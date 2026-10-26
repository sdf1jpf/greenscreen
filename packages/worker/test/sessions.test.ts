import { describe, expect, it } from "vitest";
import {
	createApp, header, helpTable, keys, menuProgram, message, newScreen, panel, pf, sendCommand, withDownload,
	type Ctx, type Holder, type Mailbox, type PanelState, type ScreenJSON, type SessionStore,
} from "../src";
import type { Sessions } from "../src/sessions";

// The Sessions Durable Object's stub fits the hooks as is (checked by tsc).
export const stubFits = (s: DurableObjectStub<Sessions>): [SessionStore, Mailbox, { fetch(req: Request): Promise<Response> }] => [s, s, s];

// An app with sessions: a record panel that locks the record it is
// changing, a download, and SEND, against an in-memory SessionStore.

interface Env { DEV_USER?: string }
interface EditState extends PanelState { p: "edit"; id: string; update: boolean }
type AppCtx = Ctx<Env> & { greeting: string };

const edit = panel<EditState, Env>({
	render(ctx, s) {
		const scr = newScreen(ctx, "TST020");
		header(scr, ctx, s.update ? "CHANGE RECORD" : "SHOW RECORD");
		scr.text(4, 2, `RECORD ${s.id} ${(ctx as AppCtx).greeting}`);
		scr.input(6, 2, 10, "name");
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  PF4=PDF");
		return scr;
	},
	handle(_ctx, s, inp) {
		s.msg = "";
		if (inp.aid === pf(3)) return s.back!;
		if (inp.aid === pf(4)) return withDownload(s, { url: `/v1/records/${s.id}/pdf`, name: `${s.id}.pdf` });
		s.msg = `SAVED ${inp.fields.name ?? ""}`.trim();
		return s;
	},
	locks: (s) => (s.update ? [`RECORD ${s.id}`] : []),
	unlocked: (s) => ({ ...s, update: false }),
});

const menu = menuProgram<Env>({
	"": {
		map: "TSTM00",
		title: "PRIMARY OPTION MENU",
		options: [
			{ key: "1", name: "SHOW", desc: "Show a record", go: (_ctx, m, arg) => ({ p: "edit", back: m, id: arg || "1", update: false }) },
			{ key: "2", name: "CHANGE", desc: "Change a record", go: (_ctx, m, arg) => ({ p: "edit", back: m, id: arg || "1", update: true }) },
		],
	},
});

// memoryStore is a SessionStore with the Sessions object's rules.
function memoryStore() {
	const sessions = new Map<string, { user: string; terminal: string }>();
	const locks = new Map<string, string>(); // resource -> sid
	const inbox: { to: string; from: string; text: string }[] = [];
	let n = 0;
	const holder = (resource: string): Holder | undefined => {
		const sid = locks.get(resource);
		const s = sid && sessions.get(sid);
		return s ? { resource, sid, user: s.user, terminal: s.terminal } : undefined;
	};
	const touch = (sid: string, user: string, terminal: string) => {
		if (sessions.get(sid)?.user === user) return sid;
		const id = `TSU${String(++n).padStart(5, "0")}`;
		sessions.set(id, { user, terminal });
		return id;
	};
	const store: SessionStore & Mailbox & { expire(sid: string): void } = {
		logon: (user, terminal) => touch("", user, terminal),
		logoff(sid) {
			sessions.delete(sid);
			for (const [r, s] of locks) if (s === sid) locks.delete(r);
		},
		hold(sid, user, terminal, want) {
			sid = touch(sid, user, terminal);
			const lost = want.map(holder).find((h) => h && h.sid !== sid);
			if (lost) return { sid, lost };
			for (const r of want) locks.set(r, sid);
			return { sid };
		},
		sync(sid, user, terminal, _map, want) {
			sid = touch(sid, user, terminal);
			const conflict = want.map(holder).find((h) => h && h.sid !== sid);
			const out: Awaited<ReturnType<SessionStore["sync"]>> = { sid };
			if (conflict) out.conflict = conflict;
			else {
				for (const [r, s] of locks) if (s === sid && !want.includes(r)) locks.delete(r);
				for (const r of want) locks.set(r, sid);
			}
			const i = inbox.findIndex((m) => m.to === user);
			if (i >= 0) out.message = inbox.splice(i, 1)[0];
			return out;
		},
		send(from, to, text) {
			const on = new Set([...sessions.values()].map((s) => s.user));
			const sent = to.filter((u) => on.has(u));
			for (const u of sent) inbox.push({ to: u, from, text });
			return { sent, notOn: to.filter((u) => !on.has(u)) };
		},
		expire(sid) {
			this.logoff(sid, "");
		},
	};
	return { store, locks };
}

function app(store: ReturnType<typeof memoryStore>["store"], operator: string[] = []) {
	return createApp<Env>({
		app: { title: "TEST SYSTEM", prefix: "TST", system: "SYS9" },
		programs: { menu, edit },
		fieldHelp: async (_s, field, ctx) => (field === "name" ? { title: `NAME FOR ${ctx.user}`, lines: ["A name."] } : undefined),
		context: () => ({ greeting: "HELLO" }),
		sessions: () => store,
		commands: sendCommand<Env>({ mailbox: () => store, operator: (_ctx, text) => void operator.push(text) }),
	});
}

type Reply = { v: 1; state: string; screen: ScreenJSON; download?: { url: string; name: string }; logoff?: { message: string } };

function terminal(a: ReturnType<typeof app>, user: string, terminal: string) {
	let state = "";
	const send = async (aid: string, extra: Record<string, unknown> = {}): Promise<Reply> => {
		const res = await a.request("/v1/screen", {
			method: "POST",
			body: JSON.stringify({ v: 1, rows: 24, cols: 80, aid, state, terminal, ...extra }),
		}, { DEV_USER: user });
		expect(res.status).toBe(200);
		const r: Reply = await res.json();
		if (r.state) state = r.state;
		return r;
	};
	return { send, get state() { return state; } };
}

const texts = (r: Reply) => r.screen.fields.map((f) => f.text ?? "").join("|");

describe("sessions", () => {
	it("gives each logon a session and keeps it in the commarea", async () => {
		const { store } = memoryStore();
		const t = terminal(app(store), "alice", "TERM0001");
		await t.send("START");
		expect(JSON.parse(t.state).t).toBe("TSU00001");
		await t.send("ENTER", { fields: { option: "1 7" } });
		expect(JSON.parse(t.state).t).toBe("TSU00001");
	});

	it("locks a record while it is changed and refuses it to others", async () => {
		const { store, locks } = memoryStore();
		const a = app(store);
		const alice = terminal(a, "alice", "TERM0001");
		const bob = terminal(a, "bob", "TERM0002");
		await alice.send("START");
		await bob.send("START");

		const r = await alice.send("ENTER", { fields: { option: "2 7" } });
		expect(r.screen.map).toBe("TST020");
		expect(locks.get("RECORD 7")).toBe("TSU00001");

		const refused = await bob.send("ENTER", { fields: { option: "2 7" } });
		expect(refused.screen.map).toBe("TSTM00");
		expect(texts(refused)).toContain("TST1201E RECORD IN USE BY ALICE ON TERM0001 - RECORD 7");
		const shown = await bob.send("ENTER", { fields: { option: "1 7" } });
		expect(shown.screen.map).toBe("TST020"); // looking needs no lock

		// Help over the panel keeps the lock; returning to the menu frees it.
		await alice.send("PF1", { cursor: { row: 6, col: 2, field: "name" } });
		expect(locks.get("RECORD 7")).toBe("TSU00001");
		await alice.send("PF3");
		await alice.send("PF3");
		expect(locks.has("RECORD 7")).toBe(false);
	});

	it("says so when a lock was lost while the session was away", async () => {
		const { store } = memoryStore();
		const a = app(store);
		const alice = terminal(a, "alice", "TERM0001");
		const bob = terminal(a, "bob", "TERM0002");
		await alice.send("START");
		await alice.send("ENTER", { fields: { option: "2 7" } });
		store.expire(JSON.parse(alice.state).t); // idle too long
		await bob.send("START");
		await bob.send("ENTER", { fields: { option: "2 7" } });

		const r = await alice.send("ENTER", { fields: { name: "NEW" } });
		expect(texts(r)).toContain("TST1202E LOCK LOST TO BOB ON TERM0002 - RECORD 7 NOT CHANGED");
		expect(texts(r)).toContain("SHOW RECORD");
	});

	it("releases the locks on logoff and timeout", async () => {
		const { store, locks } = memoryStore();
		const alice = terminal(app(store), "alice", "TERM0001");
		await alice.send("START");
		await alice.send("ENTER", { fields: { option: "2 7" } });
		const off = await alice.send("TIMEOUT");
		expect(off.logoff?.message).toContain("S522");
		expect(locks.size).toBe(0);
	});

	it("sends messages with SEND and breaks in on the receiver's screen", async () => {
		const { store } = memoryStore();
		const operator: string[] = [];
		const a = app(store, operator);
		const alice = terminal(a, "alice", "TERM0001");
		const bob = terminal(a, "bob", "TERM0002");
		await alice.send("START");
		await bob.send("START");

		let r = await alice.send("ENTER", { fields: { option: "SEND 'LUNCH?' USER(BOB,CAROL)" } });
		expect(r.screen.map).toBe("TSTM00");
		expect(texts(r)).toContain("TST1210I MESSAGE SENT TO BOB - NOT LOGGED ON: CAROL");
		r = await bob.send("REDRAW");
		expect(r.screen.fields).toContainEqual(expect.objectContaining({ row: 23, text: "LUNCH?  FROM ALICE", highlight: "reverse" }));

		r = await alice.send("ENTER", { fields: { option: "SE 'PRINTER JAMMED'" } });
		expect(texts(r)).toContain("TST1212I MESSAGE SENT TO THE OPERATOR");
		expect(operator).toEqual(["PRINTER JAMMED"]);
		r = await alice.send("ENTER", { fields: { option: "SEND LUNCH" } });
		expect(texts(r)).toContain("TST1213E ENTER SEND 'MESSAGE' USER(USERID)");
	});
});

describe("engine hooks", () => {
	it("sends a file along with the next screen", async () => {
		const { store } = memoryStore();
		const t = terminal(app(store), "alice", "TERM0001");
		await t.send("START");
		await t.send("ENTER", { fields: { option: "1 7" } });
		const r = await t.send("PF4");
		expect(r.download).toEqual({ url: "/v1/records/7/pdf", name: "7.pdf" });
		expect((await t.send("ENTER")).download).toBeUndefined(); // one screen only
	});

	it("adds the app's context and looks field help up with it", async () => {
		const { store } = memoryStore();
		const t = terminal(app(store), "alice", "TERM0001");
		await t.send("START");
		let r = await t.send("ENTER", { fields: { option: "1 7" } });
		expect(texts(r)).toContain("RECORD 7 HELLO");
		r = await t.send("PF1", { cursor: { row: 6, col: 2, field: "name" } });
		expect(texts(r)).toContain("HELP - NAME FOR ALICE");
	});

	it("passes the live flag to panels and sends the screen's live name", async () => {
		let seen: boolean | undefined;
		const probe = panel<PanelState & { p: "menu" }, Env>({
			render(ctx) {
				seen = ctx.live;
				const scr = newScreen(ctx, "TSTM00");
				scr.live = "syslog";
				return scr;
			},
			handle: (_ctx, s) => s,
		});
		const a = createApp<Env>({ app: { title: "T", prefix: "TST", system: "S" }, programs: { menu: probe } });
		const res = await a.request("/v1/screen", { method: "POST", body: JSON.stringify({ v: 1, aid: "START", live: true }) }, { DEV_USER: "x" });
		expect(seen).toBe(true);
		expect((await res.json() as Reply).screen.live).toBe("syslog"); // what GET /v1/live announces for this screen
	});

	it("opens the app's own help program on PF1", async () => {
		const own = panel<PanelState & { p: "help" }, Env>({
			render: (ctx) => newScreen(ctx, "TSTH99"),
			handle: (_ctx, s) => s.back!,
		});
		const a = createApp<Env>({ app: { title: "T", prefix: "TST", system: "S" }, programs: { menu, edit, help: own } });
		const t = terminal(a as ReturnType<typeof app>, "alice", "TERM0001");
		await t.send("START");
		expect((await t.send("PF1")).screen.map).toBe("TSTH99");
		expect((await t.send("PF3")).screen.map).toBe("TSTM00");
	});

	it("still takes a plain field help table", async () => {
		const lookup = helpTable<Env>({ name: { title: "NAME", lines: [] } });
		expect(await lookup({ p: "edit" }, "name", {} as Ctx<Env>)).toMatchObject({ title: "NAME" });
	});
});
