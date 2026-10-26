import { expect, it } from "vitest";
import app, { type Env } from "../src/index";

const env: Env = { DEV_USER: "operator", STATE_KEY: "test" };

it("says hello and counts", async () => {
	let state = "";
	const key = async (aid: string, fields: Record<string, string> = {}) => {
		const res = await app.request("/v1/screen", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ v: 1, aid, state, fields, modified: Object.keys(fields), rows: 24, cols: 80 }),
		}, env);
		const r = await res.json() as { state: string; screen: { map: string; fields: { text?: string }[] } };
		state = r.state;
		return r;
	};
	await key("START");
	await key("ENTER", { option: "1" });
	const r = await key("ENTER", { name: "Ada" });
	expect(r.screen.map).toBe("APP010");
	expect(r.screen.fields.map((f) => f.text ?? "").join("|")).toContain("HELLO, ADA. YOU HAVE PRESSED ENTER 1 TIME(S).");
});
