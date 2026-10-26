// POST /v1/screen: the application's screens, served by the Worker. The
// protocol is described in docs/protocol.md. A client sends the AID key,
// its input fields and the commarea from the last reply; the engine runs
// the panel the commarea names and answers with the next screen.

import { open, seal } from "./commarea.js";
import type { FieldHelpLookup } from "./fieldhelp.js";
import { helpProgram } from "./help.js";
import { HttpError, int, str } from "./http.js";
import { isLogoff, takeFill, withFill, type HelpState, type Input, type Next, type PanelState, type Program } from "./program.js";
import { MIN_COLS, MIN_ROWS, msgId, time, type AppInfo, type Ctx, type ScreenJSON } from "./screen.js";

export const requestKeys = [
	"v", "aid", "state", "fields", "modified", "cursor", "rows", "cols", "terminal", "system", "tz_offset",
] as const;

// SessionEvent is something worth a line in a system log.
export type SessionEvent =
	| { kind: "logon"; text: string }
	| { kind: "logoff"; text: string }
	| { kind: "timeout"; text: string };

export interface ScreenConfig<E = unknown> {
	app: AppInfo;
	// The panels, by the name in their state's "p". "menu" is where START
	// lands unless start says otherwise; "help" is provided unless given.
	// The record is checked at run time, so any Program fits.
	programs: Record<string, Program<any, E>>;
	start?: (ctx: Ctx<E>) => Next | Promise<Next>; // the first screen after logon
	fieldHelp?: FieldHelpLookup<E>; // help for the field the cursor is in on PF1
	commandLines?: Record<string, string>; // panel -> the name of its command line field, for PF24 RETRIEVE
	stateKey?: (env: E) => string | undefined; // the secret that signs the commarea; unset sends it unsigned
	stateVersion?: number; // bump when a state shape changes so old states can't be read
	onEvent?: (ctx: Ctx<E>, event: SessionEvent) => void | Promise<void>; // logon, logoff, idle timeout
}

const HISTORY = 20;
const MAX_ROWS = 200;
const MAX_COLS = 400;

const aids = new Set([
	"ENTER", "CLEAR", "PA1", "PA2", "PA3",
	...Array.from({ length: 24 }, (_, i) => `PF${i + 1}`),
]);

export type ScreenResponse =
	| { v: 1; state: string; screen: ScreenJSON }
	| { v: 1; logoff: { message: string } };

// Session is what the commarea carries for the whole conversation rather
// than for one panel.
interface Session {
	history: string[]; // commands entered, newest first
	retrieved?: number; // the history entry PF24 last put back
}

export type ScreenHandler<E> = (env: E, user: string, url: URL, body: Record<string, unknown>) => Promise<ScreenResponse>;

export function screenHandler<E>(config: ScreenConfig<E>): ScreenHandler<E> {
	const programs: Record<string, Program<PanelState, E>> = {
		help: helpProgram(config.fieldHelp ?? (() => undefined)),
		...config.programs,
	};
	if (!programs.menu && !config.start) throw new Error('register a "menu" program or give a start screen');
	const commandLines = config.commandLines ?? (programs.menu ? { menu: "option" } : {});
	const stateVersion = config.stateVersion ?? 1;
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

	async function encode(s: PanelState, session: Session, key?: string): Promise<string> {
		const out: Record<string, unknown> = { sv: stateVersion, s };
		if (session.history.length > 0) out.h = session.history;
		if (session.retrieved !== undefined) out.r = session.retrieved;
		return seal(JSON.stringify(out), key);
	}

	// decode reads a commarea, or returns undefined if it is missing,
	// damaged, tampered with or from an incompatible release.
	async function decode(raw: string, key?: string): Promise<{ s: PanelState; session: Session } | undefined> {
		try {
			const payload = await open(raw, key);
			if (payload === undefined) return undefined;
			const { sv, s, h, r } = JSON.parse(payload);
			if (sv !== stateVersion || !valid(s)) return undefined;
			const history = Array.isArray(h) ? h.filter((c): c is string => typeof c === "string").slice(0, HISTORY) : [];
			const retrieved = Number.isInteger(r) && r >= 0 && r < history.length ? (r as number) : undefined;
			return { s, session: { history, retrieved } };
		} catch {
			return undefined;
		}
	}

	return async (env, user, url, body) => {
		if (body.v !== 1) throw bad('"v" must be 1');
		const aid = str(body, "aid");
		const ctx: Ctx<E> = {
			env,
			app: config.app,
			user,
			rows: clamp(int(body, "rows"), MIN_ROWS, MAX_ROWS),
			cols: clamp(int(body, "cols"), MIN_COLS, MAX_COLS),
			system: str(body, "system") || config.app.system,
			terminal: str(body, "terminal") || "TERM0001",
			host: url.host,
			tzOffset: clamp(int(body, "tz_offset"), -14 * 60, 14 * 60),
		};
		const key = config.stateKey?.(env);

		let next: Next;
		let session: Session = { history: [] };
		if (aid === "START") {
			const msg = `IKJ56455I ${user} LOGON IN PROGRESS AT ${time(ctx)}`;
			next = config.start ? await config.start(ctx) : { p: "menu", msg };
			await event(ctx, { kind: "logon", text: `IKJ56455I ${user} LOGON IN PROGRESS ON ${ctx.terminal}` });
		} else if (aid === "TIMEOUT") {
			await event(ctx, { kind: "timeout", text: `IEF450I ${user} TSO - ABEND=S522 - IDLE TIME LIMIT EXCEEDED ON ${ctx.terminal}` });
			next = { logoff: `IKJ56470I ${user} LOGGED OFF AT ${time(ctx)} - SESSION IDLE TOO LONG (S522)` };
		} else {
			const got = await decode(str(body, "state"), key);
			const current = got?.s;
			if (got) session = got.session;
			const cmdField = current ? commandLines[current.p] : undefined;
			if (!current) {
				const lost = `${msgId(ctx, "0001W")} SCREEN STATE LOST OR FROM AN OLDER RELEASE - START OVER`;
				next = config.start ? await config.start(ctx) : { p: "menu" };
				if (!isLogoff(next)) next.msg = lost;
			} else if (aid === "REDRAW") {
				next = current;
			} else if (!aids.has(aid)) {
				throw bad(`unknown aid "${aid}"`);
			} else if (aid === "PF1" && current.p !== "help" && !config.programs.help) {
				// PF1 is help on every screen: for the field the cursor is in if
				// it has any, otherwise the tutorial. What the operator typed is
				// kept for when they come back.
				const inp = input(body, aid);
				const vals = Object.fromEntries([...inp.modified].filter((n) => n in inp.fields).map((n) => [n, inp.fields[n]]));
				const h: HelpState = { p: "help", back: current, ...(Object.keys(vals).length ? { vals } : {}) };
				next = config.fieldHelp?.(current, inp.cursorField) ? { ...h, field: inp.cursorField } : h;
			} else if (aid === "PF24" && cmdField) {
				next = retrieve(ctx, current, cmdField, session);
			} else {
				const inp = input(body, aid);
				session.retrieved = undefined;
				const cmd = (inp.fields[cmdField ?? ""] ?? "").trim();
				if (aid === "ENTER" && cmdField && cmd) {
					session.history = [cmd, ...session.history.filter((c) => c !== cmd)].slice(0, HISTORY);
				}
				next = await program(current.p).handle(ctx, current, inp);
			}
		}

		if (isLogoff(next)) {
			await event(ctx, { kind: "logoff", text: `IKJ56470I ${user} LOGGED OFF ${ctx.terminal}` });
			return { v: 1, logoff: { message: next.logoff } };
		}
		const fill = takeFill(next);
		const scr = await program(next.p).render(ctx, next);
		if (fill) scr.fill(fill.fields, fill.cursor);
		return { v: 1, state: await encode(next, session, key), screen: scr.toJSON() };
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

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(Math.max(n, lo), hi);
}

function bad(msg: string): HttpError {
	return new HttpError(400, "bad_request", "invalid request body: " + msg);
}
