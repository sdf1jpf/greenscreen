import { describe, expect, it } from "vitest";
import {
	createApp, header, helpTable, invalidKey, keys, menuProgram, message, newScreen, panel, pf, values,
	USER_HEADER, type AccessEnv, type PanelState, type ScreenJSON,
} from "../src";

// A two-panel app: a menu and a counter that keeps its count in the
// commarea.

interface Env extends AccessEnv { STATE_KEY?: string }
interface CountState extends PanelState { p: "count"; n: number }

const count = panel<CountState, Env>({
	render(ctx, s) {
		const scr = newScreen(ctx, "TST010");
		header(scr, ctx, "COUNTER");
		scr.text(4, 2, `COUNT ${s.n}`);
		scr.input(6, 2, 4, "step", "", { numeric: true });
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN");
		return scr;
	},
	handle(ctx, s, inp) {
		s.msg = "";
		if (inp.aid === pf(3)) return s.back!;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		s.n += Number(inp.fields.step || 1);
		return s;
	},
});

const menu = menuProgram<Env>({
	"": {
		map: "TSTM00",
		title: "PRIMARY OPTION MENU",
		options: [
			{ key: "1", name: "COUNT", desc: "Count things", go: (_ctx, m, arg) => ({ p: "count", back: m, n: Number(arg) || 0 }) },
			{ key: "2", name: "MORE", desc: "A submenu", sub: "2" },
		],
	},
	"2": {
		map: "TSTM20",
		title: "MORE",
		options: [{ key: "1", name: "AGAIN", desc: "Count from 100", go: (_ctx, m) => ({ p: "count", back: m, n: 100 }) }],
	},
});

function app() {
	return createApp<Env>({
		app: { title: "TEST SYSTEM", prefix: "TST", system: "SYS9", banner: ["WELCOME"] },
		programs: { menu, count },
		fieldHelp: helpTable({
			"menu.option": { title: "OPTION", lines: ["Pick one."], values: (_ctx, s) => menu.values(s) },
			step: { title: "STEP", lines: ["How much to add."], values: values(["1", "ONE"], ["5", "FIVE"]) },
		}),
		stateKey: (env) => env.STATE_KEY,
	});
}

const devEnv: Env = { DEV_USER: "tester", STATE_KEY: "secret" };

type Reply = { v: 1; state: string; screen: ScreenJSON } & { logoff?: { message: string } };

async function send(body: Record<string, unknown>, env: Env = devEnv): Promise<Reply> {
	const res = await app().request("/v1/screen", {
		method: "POST",
		body: JSON.stringify({ v: 1, rows: 24, cols: 80, ...body }),
	}, env);
	expect(res.status).toBe(200);
	return res.json();
}

const texts = (r: Reply) => r.screen.fields.map((f) => f.text ?? "").join("|");

describe("screen engine", () => {
	it("starts at the menu and titles it with the app", async () => {
		const r = await send({ aid: "START" });
		expect(r.screen.map).toBe("TSTM00");
		expect(texts(r)).toContain("SYS9 TEST SYSTEM");
		expect(texts(r)).toContain("TESTER LOGON IN PROGRESS");
	});

	it("follows a fast path with an argument and keeps panel state", async () => {
		const start = await send({ aid: "START" });
		let r = await send({ aid: "ENTER", state: start.state, fields: { option: "1 7" } });
		expect(r.screen.map).toBe("TST010");
		expect(texts(r)).toContain("COUNT 7");
		r = await send({ aid: "ENTER", state: r.state, fields: { step: "3" } });
		expect(texts(r)).toContain("COUNT 10");
		r = await send({ aid: "PF3", state: r.state });
		expect(r.screen.map).toBe("TSTM00");
		r = await send({ aid: "ENTER", state: r.state, fields: { option: "2.1" } });
		expect(texts(r)).toContain("COUNT 100");
	});

	it("signs the commarea and refuses a changed one", async () => {
		const start = await send({ aid: "START" });
		const r = await send({ aid: "ENTER", state: start.state, fields: { option: "1 7" } });
		const [body, sig] = r.state.split(".");
		const forged = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
		forged.s.n = 1_000_000;
		const b = btoa(JSON.stringify(forged)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		const got = await send({ aid: "ENTER", state: `${b}.${sig}` });
		expect(got.screen.map).toBe("TSTM00");
		expect(texts(got)).toContain("TST0001W SCREEN STATE LOST");
	});

	it("sends plain JSON without a key", async () => {
		const r = await send({ aid: "START" }, { DEV_USER: "tester" });
		expect(JSON.parse(r.state).s.p).toBe("menu");
	});

	it("gives field help with values and puts the pick back", async () => {
		const start = await send({ aid: "START" });
		const c = await send({ aid: "ENTER", state: start.state, fields: { option: "1" } });
		const h = await send({ aid: "PF1", state: c.state, cursor: { row: 6, col: 2, field: "step" } });
		expect(h.screen.map).toBe("TSTH01");
		expect(texts(h)).toContain("HELP - STEP");
		const back = await send({ aid: "ENTER", state: h.state, fields: { "pick:1": "S" } });
		expect(back.screen.map).toBe("TST010");
		const step = back.screen.fields.find((f) => f.name === "step");
		expect(step).toMatchObject({ value: "5", modified: true });
	});

	it("shows the tutorial on PF1 outside a field", async () => {
		const start = await send({ aid: "START" });
		const h = await send({ aid: "PF1", state: start.state, cursor: { row: 1, col: 1, field: "" } });
		expect(h.screen.map).toBe("TSTH00");
	});

	it("retrieves menu commands with PF24", async () => {
		const start = await send({ aid: "START" });
		const c = await send({ aid: "ENTER", state: start.state, fields: { option: "1 7" } });
		const m = await send({ aid: "PF3", state: c.state });
		const r = await send({ aid: "PF24", state: m.state });
		expect(r.screen.fields.find((f) => f.name === "option")).toMatchObject({ value: "1 7", modified: true });
	});

	it("logs off from the primary menu and on timeout", async () => {
		const start = await send({ aid: "START" });
		const off = await send({ aid: "PF3", state: start.state });
		expect(off.logoff?.message).toMatch(/^IKJ56470I TESTER LOGGED OFF/);
		const idle = await send({ aid: "TIMEOUT" });
		expect(idle.logoff?.message).toContain("S522");
	});

	it("rejects an unknown AID", async () => {
		const start = await send({ aid: "START" });
		const res = await app().request("/v1/screen", {
			method: "POST", body: JSON.stringify({ v: 1, aid: "PF99", state: start.state }),
		}, devEnv);
		expect(res.status).toBe(400);
	});
});

describe("app routes", () => {
	it("serves health and info without signing on", async () => {
		const a = app();
		expect((await a.request("/v1/health", {}, {})).status).toBe(200);
		const info = await (await a.request("/v1/screen/info", {}, {})).json();
		expect(info).toEqual({ v: 1, title: "TEST SYSTEM", system: "SYS9", prefix: "TST", banner: ["WELCOME"], live: false, snapshot: false });
	});

	it("needs Access when it is configured", async () => {
		const res = await app().request("/v1/screen", { method: "POST", body: "{}" },
			{ ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.test", ACCESS_AUD: "aud" });
		expect(res.status).toBe(401);
	});

	it("serves live and snapshots when the app has them", async () => {
		const seen: string[] = [];
		const drawn: string[] = [];
		const a = createApp<Env>({
			app: { title: "T", prefix: "TST", system: "S" },
			programs: { menu },
			live: () => ({ fetch: async (req) => (seen.push(req.headers.get(USER_HEADER) ?? ""), new Response("ws")) }),
			snapshot: {
				browser: () => ({
					quickAction: async (action: string, opts: { html: string }) => (drawn.push(action), new Response(opts.html.includes("HELLO") ? "PNG" : "?")),
				}) as unknown as BrowserRun,
			},
		});
		expect(await (await a.request("/v1/screen/info", {}, {})).json()).toMatchObject({ live: true, snapshot: true });

		expect((await a.request("/v1/live", {}, devEnv)).status).toBe(426);
		const ws = await a.request("/v1/live", { headers: { Upgrade: "websocket" } }, devEnv);
		expect(await ws.text()).toBe("ws");
		expect(seen).toEqual(["TESTER"]);

		const snap = await a.request("/v1/snapshot", {
			method: "POST",
			body: JSON.stringify({ format: "png", map: "tstm00", screen: { rows: 24, cols: 80, fields: [{ row: 1, col: 2, text: "HELLO" }] } }),
		}, devEnv);
		expect(snap.status).toBe(200);
		expect(snap.headers.get("Content-Type")).toBe("image/png");
		expect(snap.headers.get("Content-Disposition")).toMatch(/filename="TSTM00-\d{12}\.png"/);
		expect(await snap.text()).toBe("PNG");
		expect(drawn).toEqual(["screenshot"]);
		const bad = await a.request("/v1/snapshot", { method: "POST", body: JSON.stringify({ format: "gif", screen: {} }) }, devEnv);
		expect(bad.status).toBe(400);
	});

	it("leaves live and snapshots out when the app has neither", async () => {
		expect((await app().request("/v1/live", { headers: { Upgrade: "websocket" } }, devEnv)).status).toBe(404);
		expect((await app().request("/v1/snapshot", { method: "POST", body: "{}" }, devEnv)).status).toBe(404);
	});

	it("lets the app add signed-on routes", async () => {
		const a = app();
		a.get("/v1/whoami", a.signedOn, (c) => c.json({ user: c.get("user") }));
		expect(await (await a.request("/v1/whoami", {}, devEnv)).json()).toEqual({ user: "TESTER" });
	});
});
