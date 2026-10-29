import { afterEach, describe, expect, it, vi } from "vitest";
import {
	accessAuth, createApp, gatewayAuth, header, userIdFor, SNAPSHOTS_PER_MINUTE, helpTable, invalidKey, keys, menuProgram, message, newScreen, panel, pf, serviceTokenAuth, tokenHash, values,
	USER_HEADER, type AccessEnv, type AppConfig, type PanelState, type ScreenJSON,
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

function app(extra: Partial<AppConfig<Env>> = {}) {
	return createApp<Env>({
		app: { title: "TEST SYSTEM", prefix: "TST", system: "SYS9", banner: ["WELCOME"] },
		programs: { menu, count },
		fieldHelp: helpTable({
			"menu.option": { title: "OPTION", lines: ["Pick one."], values: (_ctx, s) => menu.values(s) },
			step: { title: "STEP", lines: ["How much to add."], values: values(["1", "ONE"], ["5", "FIVE"]) },
		}),
		stateKey: (env) => env.STATE_KEY,
		...extra,
	});
}

const devEnv: Env = { DEV_USER: "tester", STATE_KEY: "secret" };

type Reply = { v: 1; state: string; screen: ScreenJSON } & { logoff?: { message: string } };

async function send(body: Record<string, unknown>, env: Env = devEnv): Promise<Reply> {
	const res = await app().request("/v1/screen", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ v: 1, rows: 24, cols: 80, ...body }),
	}, env);
	expect(res.status).toBe(200);
	return res.json();
}

const texts = (r: Reply) => r.screen.fields.map((f) => f.text ?? "").join("|");

afterEach(() => {
	vi.useRealTimers();
});

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

	it("refuses a commarea issued to another user", async () => {
		const alice = { DEV_USER: "alice", STATE_KEY: "secret" };
		const bob = { DEV_USER: "bob", STATE_KEY: "secret" };
		const start = await send({ aid: "START" }, alice);
		const c = await send({ aid: "ENTER", state: start.state, fields: { option: "1 5" } }, alice);
		expect(texts(c)).toContain("COUNT 5");
		const got = await send({ aid: "ENTER", state: c.state, fields: { step: "1" } }, bob);
		expect(got.screen.map).toBe("TSTM00");
		expect(texts(got)).toContain("TST0001W SCREEN STATE LOST");
		const own = await send({ aid: "ENTER", state: c.state, fields: { step: "1" } }, alice);
		expect(texts(own)).toContain("COUNT 6");
	});

	it("binds the commarea to the identity, not the userid", async () => {
		const auth = async (_env: Env, req: Request) => ({ id: req.headers.get("X-Id") ?? "", userid: "JOHNSMIT" });
		const a = app({ auth });
		const post = async (id: string, body: Record<string, unknown>): Promise<Reply> =>
			(await a.request("/v1/screen", { method: "POST", headers: { "Content-Type": "application/json", "X-Id": id }, body: JSON.stringify({ v: 1, ...body }) }, { STATE_KEY: "k" })).json();
		const start = await post("john.smith@a.com", { aid: "START" });
		const c = await post("john.smith@a.com", { aid: "ENTER", state: start.state, fields: { option: "1 5" } });
		expect(texts(c)).toContain("COUNT 5");
		expect(texts(await post("johnsmith@b.com", { aid: "ENTER", state: c.state }))).toContain("SCREEN STATE LOST");
	});

	it("asks allow about the panel shown and the one to show", async () => {
		let counters = ["ALICE"];
		const a = app({ allow: (ctx, s) => s.p !== "count" || counters.includes(ctx.user) });
		const post = async (user: string, body: Record<string, unknown>): Promise<Reply> =>
			(await a.request("/v1/screen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, ...body }) }, { DEV_USER: user, STATE_KEY: "k" })).json();
		const bob = await post("bob", { aid: "START" });
		const refused = await post("bob", { aid: "ENTER", state: bob.state, fields: { option: "1 5" } });
		expect(refused.screen.map).toBe("TSTM00");
		expect(texts(refused)).toContain("TST0002E NOT AUTHORIZED");
		const alice = await post("alice", { aid: "START" });
		const c = await post("alice", { aid: "ENTER", state: alice.state, fields: { option: "1 5" } });
		expect(texts(c)).toContain("COUNT 5");
		counters = [];
		const after = await post("alice", { aid: "ENTER", state: c.state, fields: { step: "1" } });
		expect(after.screen.map).toBe("TSTM00");
		expect(texts(after)).toContain("TST0002E NOT AUTHORIZED");
	});

	it("takes input only for the fields drawn, as long as they were drawn", async () => {
		const start = await send({ aid: "START" });
		const c = await send({ aid: "ENTER", state: start.state, fields: { option: "1 5" } });
		const cut = await send({ aid: "ENTER", state: c.state, fields: { step: "12345" } });
		expect(texts(cut)).toContain("COUNT 1239");
		const letters = await send({ aid: "ENTER", state: cut.state, fields: { step: "9x" }, modified: ["step"] });
		expect(texts(letters)).toContain("COUNT 1239"); // not counted: the panel never saw it
		expect(texts(letters)).toContain("TST0003E ONLY DIGITS, - AND . CAN BE ENTERED IN STEP");
		expect(letters.screen.fields.find((f) => f.name === "step")).toMatchObject({ value: "9x", modified: true });
		expect(letters.screen.cursor).toEqual({ field: "step" });
		const big = "9".repeat(200_000);
		const h = await send({ aid: "PF1", state: letters.state, fields: { step: big, other: big }, modified: ["step", "other"] });
		expect(h.state.length).toBeLessThan(4000);
	});

	it("refuses a commarea older than its lifetime", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = await send({ aid: "START" });
		const c = await send({ aid: "ENTER", state: start.state, fields: { option: "1 5" } });
		vi.setSystemTime(Date.now() + 29 * 60_000);
		const fresh = await send({ aid: "ENTER", state: c.state, fields: { step: "100" } });
		expect(texts(fresh)).toContain("COUNT 105");
		vi.setSystemTime(Date.now() + 2 * 60_000); // c is 31 minutes old; fresh is 2
		const old = await send({ aid: "ENTER", state: c.state, fields: { step: "1" } });
		expect(texts(old)).toContain("TST0001W SCREEN STATE LOST");
		expect(texts(await send({ aid: "ENTER", state: fresh.state, fields: { step: "1" } }))).toContain("COUNT 106");
	});

	it("refuses to serve without a signing key outside wrangler dev", async () => {
		const auth = async () => "TESTER";
		const res = await app({ auth }).request("/v1/screen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, aid: "START" }) }, {});
		expect(res.status).toBe(500);
		expect(await res.text()).toContain("signing key is not set");
		const signed = await app({ auth }).request("/v1/screen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, aid: "START" }) }, { STATE_KEY: "k" });
		expect(signed.status).toBe(200);
		const unsigned = await app({ auth, unsigned: true }).request("/v1/screen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, aid: "START" }) }, {});
		expect(unsigned.status).toBe(200);
	});

	it("gives field help with values and puts the pick back", async () => {
		const start = await send({ aid: "START" });
		const c = await send({ aid: "ENTER", state: start.state, fields: { option: "1" } });
		const h = await send({ aid: "PF1", state: c.state, cursor: { row: 6, col: 2, field: "step" } });
		expect(h.screen.map).toBe("TSTH01");
		expect(texts(h)).toContain("HELP - STEP");
		const back = await send({ aid: "ENTER", state: h.state, fields: { "pick:5": "S" } });
		expect(back.screen.map).toBe("TST010");
		const step = back.screen.fields.find((f) => f.name === "step");
		expect(step).toMatchObject({ value: "5", modified: true });
	});

	it("picks a help value by its code, even if the list changed under it", async () => {
		const list = values(["1", "ONE"], ["5", "FIVE"]);
		const a = app({ fieldHelp: helpTable({ step: { title: "STEP", lines: ["How much to add."], values: () => list } }) });
		const post = async (body: Record<string, unknown>): Promise<Reply> => (await a.request("/v1/screen", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, rows: 24, cols: 80, ...body }),
		}, devEnv)).json();
		const c = await post({ aid: "ENTER", state: (await post({ aid: "START" })).state, fields: { option: "1" } });
		const h = await post({ aid: "PF1", state: c.state, cursor: { row: 6, col: 2, field: "step" } });
		list.unshift({ code: "0", desc: "NONE" }); // a value added above the one picked
		const back = await post({ aid: "ENTER", state: h.state, fields: { "pick:5": "S" } });
		expect(back.screen.fields.find((f) => f.name === "step")).toMatchObject({ value: "5" });
		const h2 = await post({ aid: "PF1", state: back.state, cursor: { row: 6, col: 2, field: "step" } });
		list.splice(0, list.length);
		list.push({ code: "9", desc: "NINE" });
		const gone = await post({ aid: "ENTER", state: h2.state, fields: { "pick:5": "S" } });
		expect(texts(gone)).toContain("TST0104W THAT VALUE IS NO LONGER IN THE LIST");
	});

	it("goes 16 panels deep and says why it can't go further", async () => {
		const deeper = panel<PanelState, Env>({
			render: (ctx) => newScreen(ctx, "TST099"),
			handle: (_ctx, s) => ({ p: "deeper", back: s }),
		});
		const a = app({ programs: { menu, count, deeper }, start: () => ({ p: "deeper" }) });
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		let state = "";
		const statuses: number[] = [];
		for (let i = 0; i < 17; i++) {
			const res = await a.request("/v1/screen", {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ v: 1, rows: 24, cols: 80, aid: i ? "ENTER" : "START", state }),
			}, devEnv);
			statuses.push(res.status);
			if (res.ok) state = ((await res.json()) as Reply).state;
		}
		expect(statuses.slice(0, 16).every((st) => st === 200)).toBe(true);
		expect(statuses[16]).toBe(500);
		expect(String(errors.mock.calls[0][0])).toContain('panel "deeper" is 17 panels deep');
		errors.mockRestore();
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

	it("takes only JSON bodies and names it can show", async () => {
		const form = await app().request("/v1/screen", {
			method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: JSON.stringify({ v: 1, aid: "START" }),
		}, devEnv);
		expect(form.status).toBe(415);
		const events: string[] = [];
		await app({ onEvent: (_ctx, e) => void events.push(e.text) }).request("/v1/screen", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, aid: "START", terminal: "<b>evil term</b>" }),
		}, devEnv);
		expect(events).toEqual(["IKJ56455I TESTER LOGON IN PROGRESS ON BEVILTER"]);
	});

	it("rejects an unknown AID", async () => {
		const start = await send({ aid: "START" });
		const res = await app().request("/v1/screen", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ v: 1, aid: "PF99", state: start.state }),
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
		const res = await app().request("/v1/screen", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
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
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ format: "png", map: "tstm00", screen: { rows: 24, cols: 80, fields: [{ row: 1, col: 2, text: "HELLO" }] } }),
		}, devEnv);
		expect(snap.status).toBe(200);
		expect(snap.headers.get("Content-Type")).toBe("image/png");
		expect(snap.headers.get("Content-Disposition")).toMatch(/filename="TSTM00-\d{12}\.png"/);
		expect(await snap.text()).toBe("PNG");
		expect(drawn).toEqual(["screenshot"]);
		const bad = await a.request("/v1/snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "gif", screen: {} }) }, devEnv);
		expect(bad.status).toBe(400);
	});

	it("limits each user's snapshots", async () => {
		const shot = (a: ReturnType<typeof createApp<Env>>, env: Env) => a.request("/v1/snapshot", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ format: "png", screen: { rows: 24, cols: 80, fields: [] } }),
		}, env);
		const browser = () => ({ quickAction: async () => new Response("PNG") }) as unknown as BrowserRun;
		const a = createApp<Env>({ app: { title: "T", prefix: "TST", system: "S" }, programs: { menu }, snapshot: { browser } });
		for (let i = 0; i < SNAPSHOTS_PER_MINUTE; i++) expect((await shot(a, devEnv)).status).toBe(200);
		expect((await shot(a, devEnv)).status).toBe(429);
		expect((await shot(a, { ...devEnv, DEV_USER: "other" })).status).toBe(200);

		const keys: string[] = [];
		const limit = () => ({ limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) });
		const b = createApp<Env>({ app: { title: "T", prefix: "TST", system: "S" }, programs: { menu }, snapshot: { browser, limit } });
		expect((await shot(b, devEnv)).status).toBe(429);
		expect(keys).toEqual(["TESTER"]);
	});

	it("leaves live and snapshots out when the app has neither", async () => {
		expect((await app().request("/v1/live", { headers: { Upgrade: "websocket" } }, devEnv)).status).toBe(404);
		expect((await app().request("/v1/snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, devEnv)).status).toBe(404);
	});

	it("lets the app add signed-on routes", async () => {
		const a = app();
		a.get("/v1/whoami", a.signedOn, (c) => c.json({ user: c.get("user"), uid: c.get("uid") }));
		expect(await (await a.request("/v1/whoami", {}, devEnv)).json()).toEqual({ user: "TESTER", uid: "TESTER" });
	});

	it("asks the session store for each identity's userid once", async () => {
		const asked: string[] = [];
		const store = {
			logon: () => "TSU1", logoff: () => {}, hold: (sid: string) => ({ sid }), sync: (sid: string) => ({ sid }),
			userid: (id: string, want: string) => (asked.push(id), want + "2"),
		};
		const a = app({ sessions: () => store });
		a.get("/v1/whoami", a.signedOn, (c) => c.json({ user: c.get("user") }));
		for (let i = 0; i < 3; i++) expect(await (await a.request("/v1/whoami", {}, devEnv)).json()).toEqual({ user: "TESTER2" });
		expect(asked).toEqual(["TESTER"]);
	});
});

describe("serviceTokenAuth", () => {
	it("signs on a known service token as its client ID, as Access does, and nothing else", async () => {
		const hash = await tokenHash("s3cret");
		const a = createApp<Env & { TOKENS?: Record<string, string> }>({
			app: { title: "TEST SYSTEM", prefix: "TST", system: "SYS9" },
			programs: { menu },
			auth: serviceTokenAuth((env) => env.TOKENS),
		});
		a.get("/v1/whoami", a.signedOn, (c) => c.json({ user: c.get("user"), uid: c.get("uid") }));
		const env = { TOKENS: { "Reg-1.access": hash } };
		const who = (h: Record<string, string>) => a.request("/v1/whoami", { headers: h }, env);
		const ok = await who({ "CF-Access-Client-Id": "REG-1.access", "CF-Access-Client-Secret": "s3cret" });
		expect(await ok.json()).toEqual({ user: "REG1", uid: "reg-1.access" });
		expect((await who({ "CF-Access-Client-Id": "reg-1.access", "CF-Access-Client-Secret": "wrong" })).status).toBe(401);
		expect((await who({ "CF-Access-Client-Id": "reg-2.access", "CF-Access-Client-Secret": "s3cret" })).status).toBe(401);
		expect((await who({})).status).toBe(401);
		expect((await a.request("/v1/whoami", { headers: { "CF-Access-Client-Id": "reg-1.access", "CF-Access-Client-Secret": "s3cret" } }, {})).status).toBe(401);
	});
});

describe("gatewayAuth", () => {
	it("signs on the person a gateway names, and lets no one else name anyone", async () => {
		const hash = await tokenHash("s3cret");
		const a = createApp<Env & { TOKENS?: Record<string, string>; GATEWAYS?: string[] }>({
			app: { title: "TEST SYSTEM", prefix: "TST", system: "SYS9" },
			programs: { menu },
			auth: gatewayAuth(serviceTokenAuth((env) => env.TOKENS), (env) => env.GATEWAYS),
		});
		a.get("/v1/whoami", a.signedOn, (c) => c.json({ user: c.get("user"), uid: c.get("uid") }));
		const env = { TOKENS: { "ssh.access": hash, "reg-1.access": hash }, GATEWAYS: ["SSH.access"] };
		const who = (id: string, user?: string) =>
			a.request("/v1/whoami", {
				headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": "s3cret", ...(user ? { "Greenscreen-User": user } : {}) },
			}, env);
		expect(await (await who("ssh.access", "John.Smith@Example.com")).json()).toEqual({ user: "JOHNSMIT", uid: "john.smith@example.com" });
		expect((await who("ssh.access")).status).toBe(401); // a gateway is never anyone itself
		expect((await who("ssh.access", "not an email")).status).toBe(401);
		expect((await who("reg-1.access", "john.smith@example.com")).status).toBe(401);
		expect(await (await who("reg-1.access")).json()).toEqual({ user: "REG1", uid: "reg-1.access" });
	});
});

describe("userIdFor", () => {
	it("makes a TSO-style name, which is not unique", () => {
		expect(userIdFor({ email: "john.smith@a.com" })).toBe("JOHNSMIT");
		expect(userIdFor({ email: "johnsmith@b.com" })).toBe("JOHNSMIT");
		expect(userIdFor({ common_name: "0123abcd9876.access" })).toBe("0123ABCD");
		expect(userIdFor({})).toBe("SERVICE");
	});
});

describe("accessAuth", () => {
	it("fetches the Access keys for an unknown kid at most once a minute", async () => {
		const real = globalThis.fetch;
		let fetched = 0;
		globalThis.fetch = (async () => (fetched++, Response.json({ keys: [] }))) as typeof fetch;
		try {
			const a = app({ auth: accessAuth() });
			const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
			const env = { ACCESS_TEAM_DOMAIN: "throttle.cloudflareaccess.com", ACCESS_AUD: "aud", STATE_KEY: "k" };
			for (let i = 0; i < 5; i++) {
				const jwt = `${b64({ alg: "RS256", kid: `made-up-${i}` })}.${b64({})}.c2ln`;
				const res = await a.request("/v1/session", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": jwt } }, env);
				expect(res.status).toBe(401);
			}
			expect(fetched).toBe(1);
		} finally {
			globalThis.fetch = real;
		}
	});

	it("refuses a signature that is not base64 as unsigned, not as an error", async () => {
		const real = globalThis.fetch;
		const { jwk, sign } = await signer("kid-1");
		globalThis.fetch = (async () => Response.json({ keys: [jwk] })) as typeof fetch;
		try {
			const env = { ACCESS_TEAM_DOMAIN: "badsig.cloudflareaccess.com", ACCESS_AUD: "aud", STATE_KEY: "k" };
			const good = await sign(claims(env));
			const res = await app({ auth: accessAuth() }).request("/v1/session", {
				method: "POST", headers: { "Cf-Access-Jwt-Assertion": good.replace(/\.[^.]*$/, ".!!!") },
			}, env);
			expect(res.status).toBe(401);
		} finally {
			globalThis.fetch = real;
		}
	});

	it("keeps the keys it has when fetching them again fails", async () => {
		const real = globalThis.fetch;
		vi.useFakeTimers({ toFake: ["Date"] });
		const { jwk, sign } = await signer("kid-1");
		let up = true;
		let fetched = 0;
		globalThis.fetch = (async () => (fetched++, up ? Response.json({ keys: [jwk] }) : new Response("down", { status: 502 }))) as typeof fetch;
		try {
			const a = app({ auth: accessAuth() });
			const env = { ACCESS_TEAM_DOMAIN: "stale.cloudflareaccess.com", ACCESS_AUD: "aud", STATE_KEY: "k" };
			const logon = async () => (await a.request("/v1/session", {
				method: "POST", headers: { "Cf-Access-Jwt-Assertion": await sign(claims(env)) },
			}, env)).status;
			expect(await logon()).toBe(201);
			up = false;
			vi.setSystemTime(Date.now() + 2 * 3_600_000);
			expect(await logon()).toBe(201);
			expect(await logon()).toBe(201);
			expect(fetched).toBe(2); // the failed fetch is not tried again at once
		} finally {
			globalThis.fetch = real;
		}
	});
});

// claims are an Access user's, current, for env's application.
function claims(env: { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string }) {
	const now = Math.floor(Date.now() / 1000);
	return { iss: `https://${env.ACCESS_TEAM_DOMAIN}`, aud: [env.ACCESS_AUD], exp: now + 300, email: "ada@example.com" };
}

// signer makes an RS256 key pair the way Access publishes them.
async function signer(kid: string) {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
	)) as CryptoKeyPair;
	const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey, kid };
	const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	const part = (o: object) => b64(new TextEncoder().encode(JSON.stringify(o)));
	const sign = async (body: object) => {
		const head = `${part({ alg: "RS256", kid })}.${part(body)}`;
		const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(head));
		return `${head}.${b64(new Uint8Array(sig))}`;
	};
	return { jwk, sign };
}

