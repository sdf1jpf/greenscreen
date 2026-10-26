// POST /v1/screen: the application's screens, served by the Worker. The
// protocol is described in docs/protocol.md. A client sends the AID key,
// its input fields and the commarea from the last reply; the engine runs
// the panel the commarea names and answers with the next screen.

import type { Identity } from "./auth.js";
import { open, seal } from "./commarea.js";
import type { FieldHelpLookup } from "./fieldhelp.js";
import { helpProgram } from "./help.js";
import { HttpError, int, str } from "./http.js";
import {
	isLogoff, takeDownload, takeFill, withFill,
	type Download, type HelpState, type Input, type Next, type PanelState, type Program,
} from "./program.js";
import { breakIn, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, msgId, time, type AppInfo, type Ctx, type ScreenJSON } from "./screen.js";

export const requestKeys = [
	"v", "aid", "state", "fields", "modified", "cursor", "rows", "cols", "terminal", "system", "tz_offset", "live",
] as const;

// SessionEvent is something worth a line in a system log.
export type SessionEvent =
	| { kind: "logon"; text: string }
	| { kind: "logoff"; text: string }
	| { kind: "timeout"; text: string };

// Holder is a session holding a record for update.
export interface Holder {
	resource: string; // e.g. "CUSTOMER 000101"
	user: string;
	terminal: string;
	sid?: string;
	since?: string; // RFC 3339
}

// SessionStore keeps who is signed on, the records they hold and the
// messages waiting for them. The Sessions Durable Object in
// "@greenscreen-dev/worker/sessions" is one; its stub fits as is.
export interface SessionStore {
	// logon starts a session and returns its id.
	logon(user: string, terminal: string): string | Promise<string>;
	// logoff ends a session and releases its locks.
	logoff(sid: string, user: string): void | Promise<void>;
	// hold makes sure the session still holds want before a panel acts on
	// them, taking any that lapsed. lost is another session that has one now.
	hold(sid: string, user: string, terminal: string, want: string[]): HoldResult | Promise<HoldResult>;
	// sync records the panel the session shows and makes it hold exactly
	// want. conflict is another session holding one of them, and then
	// nothing changed. message is one waiting for the user, now delivered.
	sync(sid: string, user: string, terminal: string, map: string, want: string[]): SyncResult | Promise<SyncResult>;
	// userid gives the identity id the userid it signs on as: the one it
	// had before, or want if no other identity has it, or want with a
	// number in it (JOHNSMI2). Everything else here is keyed on the userid,
	// so two people must never share one.
	userid?(id: string, want: string): string | Promise<string>;
}

export interface HoldResult { sid: string; lost?: Holder | null }
export interface SyncResult { sid: string; conflict?: Holder | null; message?: { from: string; text: string } | null }

export interface ScreenConfig<E = unknown> {
	app: AppInfo;
	// The panels, by the name in their state's "p". "menu" is where START
	// lands unless start says otherwise; "help" is provided unless given.
	// The record is checked at run time, so any Program fits.
	programs: Record<string, Program<any, E>>;
	start?: (ctx: Ctx<E>) => Next | Promise<Next>; // the first screen after logon
	fieldHelp?: FieldHelpLookup<E>; // help for the field the cursor is in on PF1
	commandLines?: Record<string, string>; // panel -> the name of its command line field, for PF24 RETRIEVE
	// stateKey returns the secret that signs the commarea. Without one the
	// engine refuses to serve screens, unless unsigned is set or the
	// request was signed on as DEV_USER (wrangler dev): an unsigned
	// commarea can be rewritten by the client, totals and all.
	stateKey?: (env: E) => string | undefined;
	unsigned?: boolean; // serve an unsigned commarea, for an app whose panels trust nothing in it
	stateVersion?: number; // bump when a state shape changes so old states can't be read
	// stateLifetime is how long, in seconds, a commarea can be sent back
	// before it is treated as lost: by default 30 minutes, the idle limit.
	// Each reply carries a new one, so it only ends a conversation left that
	// long. 0 lets them last for ever.
	stateLifetime?: number;
	onEvent?: (ctx: Ctx<E>, event: SessionEvent) => void | Promise<void>; // logon, logoff, idle timeout
	// context adds the app's own things to every panel's ctx, such as its
	// database: context: (ctx) => ({ db: ctx.env.DB }). A panel declares
	// them in its own Ctx type.
	context?: (ctx: Ctx<E>) => object | void;
	// commands runs a command typed on any command line before the panel
	// sees it, the way a TSO command works from any panel. It returns the
	// message to show on the same screen, or undefined to leave the command
	// to the panel.
	commands?: (ctx: Ctx<E>, cmd: string, s: PanelState) => string | undefined | Promise<string | undefined>;
	// sessions turns on TSO-style sessions: a session id in the commarea,
	// record locks named by panels (Program.locks), and messages from other
	// users breaking in on the message line. Returning undefined runs
	// without them, as when a binding is missing in tests.
	sessions?: (env: E) => SessionStore | undefined;
}

const HISTORY = 20;
const LIFETIME_S = 30 * 60;
const CLOCK_SKEW_S = 60;

const aids = new Set([
	"ENTER", "CLEAR", "PA1", "PA2", "PA3",
	...Array.from({ length: 24 }, (_, i) => `PF${i + 1}`),
]);

export type ScreenResponse =
	| { v: 1; state: string; screen: ScreenJSON; download?: Download }
	| { v: 1; logoff: { message: string } };

// Session is what the commarea carries for the whole conversation rather
// than for one panel.
interface Session {
	sid?: string; // the session in the app's SessionStore
	history: string[]; // commands entered, newest first
	retrieved?: number; // the history entry PF24 last put back
}

// who is the signed-on identity, with the userid the app's SessionStore
// gave it.
export type ScreenHandler<E> = (env: E, who: Identity, url: URL, body: Record<string, unknown>) => Promise<ScreenResponse>;

export function screenHandler<E>(config: ScreenConfig<E>): ScreenHandler<E> {
	const programs: Record<string, Program<PanelState, E>> = {
		help: helpProgram(config.fieldHelp ?? (() => undefined)),
		...config.programs,
	};
	if (!programs.menu && !config.start) throw new Error('register a "menu" program or give a start screen');
	const commandLines = config.commandLines ?? (programs.menu ? { menu: "option" } : {});
	const stateVersion = config.stateVersion ?? 1;
	const lifetime = config.stateLifetime ?? LIFETIME_S;
	const event = async (ctx: Ctx<E>, e: SessionEvent) => config.onEvent?.(ctx, e);

	const program = (p: string) => {
		const prog = programs[p];
		if (!prog) throw new Error(`no program registered for panel "${p}"`);
		return prog;
	};

	function valid(s: unknown, depth = 0): s is PanelState {
		if (typeof s !== "object" || s === null || depth > 8) return false;
		const st = s as { p?: unknown; back?: unknown };
		if (typeof st.p !== "string" || !Object.hasOwn(programs, st.p)) return false;
		return st.back === undefined || valid(st.back, depth + 1);
	}

	// The commarea names the identity it was issued to and when, so it
	// can't be sent back by anyone else or, after its lifetime, by anyone.
	async function encode(s: PanelState, session: Session, user: string, key?: string): Promise<string> {
		const out: Record<string, unknown> = { sv: stateVersion, u: user, i: Math.floor(Date.now() / 1000), s };
		if (session.sid) out.t = session.sid;
		if (session.history.length > 0) out.h = session.history;
		if (session.retrieved !== undefined) out.r = session.retrieved;
		return seal(JSON.stringify(out), key);
	}

	// decode reads a commarea, or returns undefined if it is missing,
	// damaged, tampered with, from an incompatible release, issued to
	// another user or too old.
	async function decode(raw: string, user: string, key?: string): Promise<{ s: PanelState; session: Session } | undefined> {
		try {
			const payload = await open(raw, key);
			if (payload === undefined) return undefined;
			const { sv, u, i, s, h, r, t } = JSON.parse(payload);
			if (sv !== stateVersion || u !== user || !valid(s)) return undefined;
			const now = Date.now() / 1000;
			if (typeof i !== "number" || i > now + CLOCK_SKEW_S || (lifetime > 0 && i < now - lifetime)) return undefined;
			const history = Array.isArray(h) ? h.filter((c): c is string => typeof c === "string").slice(0, HISTORY) : [];
			const retrieved = Number.isInteger(r) && r >= 0 && r < history.length ? (r as number) : undefined;
			return { s, session: { history, retrieved, sid: typeof t === "string" ? t : undefined } };
		} catch {
			return undefined;
		}
	}

	// locksOf lists the records held for update by s and the panels under
	// it, such as a record being changed under the help panel opened from it.
	const locksOf = (s: PanelState): string[] => {
		const out: string[] = [];
		for (let st: PanelState | undefined = s; st; st = st.back) out.push(...(program(st.p).locks?.(st) ?? []));
		return out;
	};

	// unlock returns the screen that held lost locks, without them.
	const unlock = (s: PanelState): PanelState => {
		for (let st: PanelState | undefined = s; st; st = st.back) {
			const p = program(st.p);
			if (p.locks?.(st).length && p.unlocked) return p.unlocked(st);
		}
		return s;
	};

	return async (env, who, url, body) => {
		if (body.v !== 1) throw bad('"v" must be 1');
		const user = who.userid;
		const aid = str(body, "aid");
		const ctx: Ctx<E> = {
			env,
			app: config.app,
			user,
			uid: who.id,
			rows: clamp(int(body, "rows"), MIN_ROWS, MAX_ROWS),
			cols: clamp(int(body, "cols"), MIN_COLS, MAX_COLS),
			system: str(body, "system") || config.app.system,
			terminal: str(body, "terminal") || "TERM0001",
			host: url.host,
			tzOffset: clamp(int(body, "tz_offset"), -14 * 60, 14 * 60),
			sid: "",
			live: body.live === true,
		};
		const extra = config.context?.(ctx);
		if (extra) Object.assign(ctx, extra);
		const key = config.stateKey?.(env);
		if (!key && !config.unsigned && !devUser(env)) {
			throw new HttpError(500, "internal", "the commarea signing key is not set (stateKey, usually the STATE_KEY secret)");
		}
		const store = config.sessions?.(env);

		let next: Next;
		let session: Session = { history: [] };
		let before: PanelState | undefined; // the screen as it was, to go back to if a lock is refused
		const got = aid === "START" ? undefined : await decode(str(body, "state"), who.id, key);
		if (got) session = got.session;
		ctx.sid = session.sid ?? "";
		if (aid === "START") {
			if (store) ctx.sid = await store.logon(user, ctx.terminal);
			const msg = `IKJ56455I ${user} LOGON IN PROGRESS AT ${time(ctx)}`;
			next = config.start ? await config.start(ctx) : { p: "menu", msg };
			await event(ctx, { kind: "logon", text: `IKJ56455I ${user} LOGON IN PROGRESS ON ${ctx.terminal}` });
		} else if (aid === "TIMEOUT") {
			await event(ctx, { kind: "timeout", text: `IEF450I ${user} TSO - ABEND=S522 - IDLE TIME LIMIT EXCEEDED ON ${ctx.terminal}` });
			next = { logoff: `IKJ56470I ${user} LOGGED OFF AT ${time(ctx)} - SESSION IDLE TOO LONG (S522)` };
		} else {
			const current = got?.s;
			const cmdField = current ? commandLines[current.p] : undefined;
			before = current && structuredClone(current);
			const held = store && current ? locksOf(current) : [];
			const hold = store && held.length > 0 && aid !== "REDRAW" ? await store.hold(ctx.sid, user, ctx.terminal, held) : undefined;
			if (hold) ctx.sid = hold.sid;
			if (!current) {
				const lost = `${msgId(ctx, "0001W")} SCREEN STATE LOST, EXPIRED OR FROM AN OLDER RELEASE - START OVER`;
				next = config.start ? await config.start(ctx) : { p: "menu" };
				if (!isLogoff(next)) next.msg = lost;
			} else if (aid === "REDRAW") {
				next = current;
			} else if (!aids.has(aid)) {
				throw bad(`unknown aid "${aid}"`);
			} else if (hold?.lost) {
				// The session ended with a record held and someone else has it
				// now: what was typed cannot be saved.
				const l = hold.lost;
				next = unlock(current);
				before = undefined;
				next.msg = `${msgId(ctx, "1202E")} LOCK LOST TO ${l.user} ON ${l.terminal} - ${l.resource} NOT CHANGED`;
			} else if (aid === "PF1" && current.p !== "help") {
				// PF1 is help on every screen: for the field the cursor is in if
				// it has any, otherwise the tutorial. What the operator typed is
				// kept for when they come back.
				const inp = input(body, aid);
				const vals = Object.fromEntries([...inp.modified].filter((n) => n in inp.fields).map((n) => [n, inp.fields[n]]));
				const h: HelpState = { p: "help", back: current, ...(Object.keys(vals).length ? { vals } : {}) };
				next = (await config.fieldHelp?.(current, inp.cursorField, ctx)) ? { ...h, field: inp.cursorField } : h;
			} else if (aid === "PF24" && cmdField) {
				next = retrieve(ctx, current, cmdField, session);
			} else {
				const inp = input(body, aid);
				session.retrieved = undefined;
				const cmd = (inp.fields[cmdField ?? ""] ?? "").trim();
				if (aid === "ENTER" && cmdField && cmd) {
					session.history = [cmd, ...session.history.filter((c) => c !== cmd)].slice(0, HISTORY);
				}
				const said = aid === "ENTER" && cmdField && cmd && config.commands ? await config.commands(ctx, cmd, current) : undefined;
				if (said !== undefined) {
					next = current;
					next.msg = said;
				} else {
					next = await program(current.p).handle(ctx, current, inp);
				}
			}
		}

		if (isLogoff(next)) {
			if (store && ctx.sid) await store.logoff(ctx.sid, user);
			await event(ctx, { kind: "logoff", text: `IKJ56470I ${user} LOGGED OFF ${ctx.terminal}` });
			return { v: 1, logoff: { message: next.logoff } };
		}
		const fill = takeFill(next);
		let download = takeDownload(next);
		let scr = await program(next.p).render(ctx, next);
		if (fill) scr.fill(fill.fields, fill.cursor);

		if (store) {
			// Take the locks the new screen needs and release the rest. If
			// another session has one, stay on the screen as it was.
			const sync = await store.sync(ctx.sid, user, ctx.terminal, scr.map, locksOf(next));
			session.sid = ctx.sid = sync.sid;
			if (sync.conflict) {
				const h = sync.conflict;
				const back: Next = before ?? (config.start ? await config.start(ctx) : { p: "menu" });
				if (isLogoff(back)) return { v: 1, logoff: { message: back.logoff } };
				next = back;
				next.msg = `${msgId(ctx, "1201E")} RECORD IN USE BY ${h.user} ON ${h.terminal} - ${h.resource}`;
				takeFill(next);
				takeDownload(next);
				scr = await program(next.p).render(ctx, next);
				download = undefined;
			}
			if (sync.message) breakIn(scr, sync.message.from, sync.message.text);
		}
		return { v: 1, state: await encode(next, session, who.id, key), screen: scr.toJSON(), ...(download ? { download } : {}) };
	};
}

// retrieve puts the next older command from the history on the command line.
function retrieve(ctx: Ctx, s: PanelState, field: string, session: Session): PanelState {
	if (session.history.length === 0) {
		s.msg = `${msgId(ctx, "1101I")} NO COMMANDS TO RETRIEVE`;
		return withFill(s, { fields: { [field]: "" }, cursor: field });
	}
	const n = session.retrieved === undefined ? 0 : (session.retrieved + 1) % session.history.length;
	session.retrieved = n;
	s.msg = "";
	return withFill(s, { fields: { [field]: session.history[n] }, cursor: field });
}

function input(body: Record<string, unknown>, aid: string): Input {
	const fields: Record<string, string> = {};
	const raw = body.fields ?? {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad('"fields" must be an object');
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v !== "string") throw bad(`field "${k}" must be a string`);
		fields[k] = v;
	}
	const modified = body.modified ?? [];
	if (!Array.isArray(modified) || modified.some((m) => typeof m !== "string")) {
		throw bad('"modified" must be a list of field names');
	}
	const cursor = body.cursor;
	const cursorField = typeof cursor === "object" && cursor !== null && "field" in cursor && typeof cursor.field === "string"
		? cursor.field : "";
	return { aid, fields, modified: new Set(modified as string[]), cursorField };
}

// devUser says the Worker signs everyone on as DEV_USER, under wrangler
// dev without Access, where an unsigned commarea is allowed for convenience.
function devUser(env: unknown): boolean {
	const e = env as { DEV_USER?: unknown; ACCESS_AUD?: unknown } | null;
	return !!e && !!e.DEV_USER && !e.ACCESS_AUD;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(Math.max(n, lo), hi);
}

function bad(msg: string): HttpError {
	return new HttpError(400, "bad_request", "invalid request body: " + msg);
}
