import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/common";
import { MemoryStore } from "../src/store";

const catalog = [
	{ sku: "1001", desc: "COFFEE, LARGE", price: 325 },
	{ sku: "2001", desc: "BAGEL, PLAIN", price: 195 },
];

type Reply = { state: string; screen: { map: string; fields: { text?: string; name?: string; value?: string }[] } };

function terminal(user = "cashier1") {
	const env = { DEV_USER: user, MANAGERS: "boss@example.com, cashier1", STATE_KEY: "test-key", STORE: new MemoryStore(catalog) } as unknown as Env;
	let state = "";
	async function key(aid: string, fields: Record<string, string> = {}, cursor = ""): Promise<Reply> {
		const res = await app.request("/v1/screen", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ v: 1, aid, state, fields, modified: Object.keys(fields), cursor: { row: 1, col: 1, field: cursor }, rows: 24, cols: 80 }),
		}, env);
		expect(res.status).toBe(200);
		const r = (await res.json()) as Reply;
		state = r.state;
		return r;
	}
	return { key, env, retry: (s: string) => (state = s), state: () => state };
}

const text = (r: Reply) => r.screen.fields.map((f) => f.text ?? "").join("|");

describe("point of sale", () => {
	it("rings up a sale, takes cash and gives change", async () => {
		const t = terminal();
		await t.key("START");
		let r = await t.key("ENTER", { option: "SALE" });
		expect(r.screen.map).toBe("POS010");
		await t.key("ENTER", { sku: "1001", qty: "2" });
		r = await t.key("ENTER", { sku: "2001" });
		expect(text(r)).toContain("8.45"); // 6.50 + 1.95; tax 0.70, total 9.15
		expect(text(r)).toContain("9.15");
		r = await t.key("PF5");
		expect(r.screen.map).toBe("POS020");
		r = await t.key("ENTER", { method: "C", amount: "20" });
		expect(r.screen.map).toBe("POS030");
		expect(text(r)).toContain("CHANGE 10.85");
		r = await t.key("ENTER");
		expect(r.screen.map).toBe("POS010");
		expect(text(r)).toContain("NO ITEMS YET");
	});

	it("refuses short cash and unknown SKUs", async () => {
		const t = terminal();
		await t.key("START");
		await t.key("ENTER", { option: "1" });
		let r = await t.key("ENTER", { sku: "9999" });
		expect(text(r)).toContain("POS0207E SKU 9999 NOT FOUND");
		await t.key("ENTER", { sku: "1001" });
		await t.key("PF5");
		r = await t.key("ENTER", { amount: "1" });
		expect(text(r)).toContain("POS0303E");
	});

	it("writes a sale once when the tender is retried", async () => {
		const t = terminal();
		await t.key("START");
		await t.key("ENTER", { option: "1" });
		await t.key("ENTER", { sku: "1001" });
		await t.key("PF5");
		const before = t.state();
		await t.key("ENTER", { method: "D" });
		t.retry(before); // the reply was lost; Enter is pressed again with the same commarea
		await t.key("ENTER", { method: "D" });
		expect(await t.env.STORE!.sales(10)).toHaveLength(1);
	});

	it("lists the price list as SKU field help and fills the pick in", async () => {
		const t = terminal();
		await t.key("START");
		await t.key("ENTER", { option: "1" });
		let r = await t.key("PF1", {}, "sku");
		expect(r.screen.map).toBe("POSH01");
		expect(text(r)).toContain("BAGEL, PLAIN  1.95");
		r = await t.key("ENTER", { "pick:1": "S" });
		expect(r.screen.fields.find((f) => f.name === "sku")?.value).toBe("2001");
	});

	it("looks up receipts and totals the day", async () => {
		const t = terminal();
		await t.key("START");
		await t.key("ENTER", { option: "1" });
		await t.key("ENTER", { sku: "1001" });
		await t.key("PF5");
		await t.key("ENTER", { method: "D" });
		await t.key("PF3");
		let r = await t.key("ENTER", { option: "RECEIPTS" });
		expect(r.screen.map).toBe("POS040");
		r = await t.key("ENTER", { "sel:1": "S" });
		expect(r.screen.map).toBe("POS030");
		expect(text(r)).toContain("1 X COFFEE, LARGE");
		await t.key("PF3");
		await t.key("PF3");
		r = await t.key("ENTER", { option: "4" });
		expect(text(r)).toContain("CARD (1)");
		expect(text(r)).toContain("3.52"); // 3.25 + 0.27 tax
	});

	it("names itself for the clients", async () => {
		const info = await (await app.request("/v1/screen/info", {}, {} as Env)).json();
		expect(info).toMatchObject({ title: "POINT OF SALE", prefix: "POS", system: "POS1" });
	});

	it("changes a price from the price list", async () => {
		const t = terminal();
		await t.key("START");
		let r = await t.key("ENTER", { option: "PRICES" });
		expect(r.screen.map).toBe("POS050");
		r = await t.key("ENTER", { "sel:2001": "X" });
		expect(text(r)).toContain("POS0502E");
		r = await t.key("ENTER", { "sel:2001": "C" });
		expect(r.screen.map).toBe("POS051");
		expect(text(r)).toContain("BAGEL, PLAIN");
		r = await t.key("ENTER", { price: "abc" });
		expect(text(r)).toContain("POS0511E");
		r = await t.key("ENTER", { price: "2.25" });
		expect(r.screen.map).toBe("POS050");
		expect(text(r)).toContain("POS0510I 2001 NOW 2.25");
		expect(text(r)).toContain("2.25");
	});

	it("lets only managers change prices", async () => {
		const t = terminal("cashier2");
		await t.key("START");
		let r = await t.key("ENTER", { option: "PRICES" });
		r = await t.key("ENTER", { "sel:2001": "C" });
		expect(r.screen.map).toBe("POS050");
		expect(text(r)).toContain("POS0002E NOT AUTHORIZED");
	});
});
