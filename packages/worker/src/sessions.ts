// @greenscreen-dev/worker/sessions: the TSO address space. One Durable
// Object knows who is signed on, which records they hold for update, and
// the messages users SEND each other. It also keeps the terminals'
// WebSocket connections (GET /v1/live) and pushes them an event when
// something they show has changed.
//
// The screens stay pseudo-conversational: each POST /v1/screen calls sync
// once with the records its next panel needs locked. Everything lives in
// the object's own SQLite storage, and every method runs without awaiting,
// so each is atomic.
//
//	export { Sessions } from "@greenscreen-dev/worker/sessions";
//	createApp({ ..., sessions: (env) => tso(env.SESSIONS), live: (env) => tso(env.SESSIONS) })
//
// with a SESSIONS binding to the class (new_sqlite_classes in a migration).
// Subclass it to push events of your own; see watch.

import { DurableObject } from "cloudflare:workers";
import { USER_HEADER } from "./app.js";
import type { Holder, HoldResult, SyncResult } from "./engine.js";
import { HttpError } from "./http.js";
import type { SendResult } from "./send.js";

export type { Holder, HoldResult, SyncResult } from "./engine.js";
export type { SendResult } from "./send.js";

// A session that has not been seen for this long has ended (TSO's idle
// limit, S522); its locks go with it.
export const IDLE_MS = 30 * 60_000;
// Undelivered messages per user, and how long they wait.
const MAX_PENDING = 50;
const KEEP_MESSAGES_MS = 7 * 86_400_000;

export interface TsoSession {
	sid: string; // TSU00042
	user: string;
	terminal: string;
	logon: string; // RFC 3339
	seen: string;
	map: string; // the panel it last showed
}

export interface Message {
	from: string;
	text: string;
	sent: string; // RFC 3339
}

// Push events, as JSON text on the WebSocket: "message" when a SEND has
// come for the user, or one named like a screen's live, such as "syslog".
export type LiveEvent = { event: string; [key: string]: unknown };

export class Sessions<E = unknown> extends DurableObject<E> {
	protected sql: SqlStorage;
	// watchMs, if set, has watch run this often while any terminal listens.
	protected watchMs = 0;

	constructor(ctx: DurableObjectState, env: E) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				sid TEXT PRIMARY KEY, user TEXT NOT NULL, terminal TEXT NOT NULL,
				logon TEXT NOT NULL, seen INTEGER NOT NULL, map TEXT NOT NULL DEFAULT '');
			CREATE TABLE IF NOT EXISTS locks (resource TEXT PRIMARY KEY, sid TEXT NOT NULL, since TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT, to_user TEXT NOT NULL, from_user TEXT NOT NULL,
				text TEXT NOT NULL, sent INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS userids (id TEXT PRIMARY KEY, userid TEXT NOT NULL UNIQUE);
		`);
		// A client's keepalive is answered without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	// userid gives identity id a userid of its own, for good: want if it is
	// free, or else want with the lowest number in it that is (JOHNSMI2).
	userid(id: string, want: string): string {
		const had = this.sql.exec<{ userid: string }>("SELECT userid FROM userids WHERE id = ?", id).toArray()[0];
		if (had) return had.userid;
		for (let n = 1; ; n++) {
			const suffix = n === 1 ? "" : String(n);
			const userid = n === 1 ? want : want.slice(0, Math.max(1, 8 - suffix.length)) + suffix;
			if (this.sql.exec("SELECT 1 FROM userids WHERE userid = ?", userid).toArray().length === 0) {
				this.sql.exec("INSERT INTO userids (id, userid) VALUES (?, ?)", id, userid);
				return userid;
			}
		}
	}

	// logon starts a session and returns its TSU id.
	logon(user: string, terminal: string): string {
		this.expire();
		return this.create(user, terminal);
	}

	// logoff ends a session and releases its locks.
	logoff(sid: string, user: string): void {
		this.sql.exec("DELETE FROM locks WHERE sid IN (SELECT sid FROM sessions WHERE sid = ? AND user = ?)", sid, user);
		this.sql.exec("DELETE FROM sessions WHERE sid = ? AND user = ?", sid, user);
	}

	// sync records that the session is showing map and holds exactly the
	// locks in want: missing ones are taken and the rest released. If
	// another session holds one of them, nothing changes and the holder
	// comes back as the conflict. It also delivers one waiting message.
	sync(sid: string, user: string, terminal: string, map: string, want: string[]): SyncResult & { sid: string } {
		this.expire();
		sid = this.touch(sid, user, terminal, map);
		const out: SyncResult & { message?: Message } = { sid };
		const conflict = this.conflict(sid, want);
		if (conflict) out.conflict = conflict;
		else {
			const keep = new Set(want);
			for (const { resource } of this.sql.exec<{ resource: string }>("SELECT resource FROM locks WHERE sid = ?", sid)) {
				if (!keep.has(resource)) this.sql.exec("DELETE FROM locks WHERE resource = ?", resource);
			}
			this.take(sid, want);
		}
		const msg = this.sql.exec<{ id: number; from_user: string; text: string; sent: number }>(
			"SELECT * FROM messages WHERE to_user = ? ORDER BY id LIMIT 1", user,
		).toArray()[0];
		if (msg) {
			this.sql.exec("DELETE FROM messages WHERE id = ?", msg.id);
			out.message = { from: msg.from_user, text: msg.text, sent: new Date(msg.sent).toISOString() };
		}
		return out;
	}

	// hold makes sure the session still holds the locks in want, taking any
	// that lapsed, before a panel acts on them. lost is set when another
	// session has one now.
	hold(sid: string, user: string, terminal: string, want: string[]): HoldResult {
		this.expire();
		sid = this.touch(sid, user, terminal);
		const lost = this.conflict(sid, want);
		if (lost) return { sid, lost };
		this.take(sid, want);
		return { sid };
	}

	// holder returns who holds resource, if anyone.
	holder(resource: string): Required<Holder> | null {
		this.expire();
		return this.sql.exec<Required<Holder>>(
			"SELECT l.resource, l.sid, s.user, s.terminal, l.since FROM locks l JOIN sessions s USING (sid) WHERE l.resource = ?",
			resource,
		).toArray()[0] ?? null;
	}

	// users lists the signed-on sessions, by userid.
	users(): TsoSession[] {
		this.expire();
		return this.sql.exec<Omit<TsoSession, "seen"> & { seen: number }>(
			"SELECT sid, user, terminal, logon, seen, map FROM sessions ORDER BY user, sid",
		).toArray().map((s) => ({ ...s, seen: new Date(s.seen).toISOString() }));
	}

	// locks lists the locks held, by resource.
	locks(): Required<Holder>[] {
		this.expire();
		return this.sql.exec<Required<Holder>>(
			"SELECT l.resource, l.sid, s.user, s.terminal, l.since FROM locks l JOIN sessions s USING (sid) ORDER BY l.resource",
		).toArray();
	}

	// send queues text for each user in to, or for every signed-on user but
	// the sender when to is ["*"]. A user who is not signed on gets it only
	// with logon, at their next logon, as TSO's SEND ... LOGON does.
	send(from: string, to: string[], text: string, logon: boolean): SendResult {
		this.expire();
		const on = new Set(this.sql.exec<{ user: string }>("SELECT DISTINCT user FROM sessions").toArray().map((r) => r.user));
		const targets = to.includes("*") ? [...on].filter((u) => u !== from) : [...new Set(to)];
		const out: SendResult = { sent: [], notOn: [] };
		const now = Date.now();
		for (const user of targets) {
			if (!on.has(user) && !logon) {
				out.notOn.push(user);
				continue;
			}
			this.sql.exec("INSERT INTO messages (to_user, from_user, text, sent) VALUES (?, ?, ?, ?)", user, from, text, now);
			this.sql.exec(
				"DELETE FROM messages WHERE to_user = ? AND id NOT IN (SELECT id FROM messages WHERE to_user = ? ORDER BY id DESC LIMIT ?)",
				user, user, MAX_PENDING,
			);
			out.sent.push(user);
			this.push({ event: "message" }, user);
		}
		return out;
	}

	// fetch accepts a terminal's WebSocket. The Worker has signed the user
	// on and passes the userid in a header.
	async fetch(req: Request): Promise<Response> {
		const user = req.headers.get(USER_HEADER);
		if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket" || !user) {
			return new Response("expected a WebSocket upgrade", { status: 426 });
		}
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [user]);
		const waiting = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE to_user = ?", user).one().n;
		if (waiting > 0) server.send(JSON.stringify({ event: "message" } satisfies LiveEvent));
		if (this.watchMs > 0 && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + this.watchMs);
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(): void {} // clients only send keepalives, answered above

	webSocketClose(ws: WebSocket, code: number): void {
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code);
		} catch {
			// already closed
		}
	}

	// alarm runs watch while any terminal listens, every watchMs.
	async alarm(): Promise<void> {
		if (this.watchMs <= 0 || this.ctx.getWebSockets().length === 0) return; // stop until the next terminal connects
		try {
			await this.watch();
		} finally {
			await this.ctx.storage.setAlarm(Date.now() + this.watchMs);
		}
	}

	// watch looks for changes the terminals should hear about, such as the
	// end of a system log moving, and pushes them. A subclass that sets
	// watchMs overrides it; use counter and setCounter to remember where it
	// got to.
	protected async watch(): Promise<void> {}

	// notify pushes an event to user's terminals, or to all of them, for a
	// change made elsewhere in the app.
	notify(e: LiveEvent, user?: string): void {
		this.push(e, user);
	}

	// push sends an event to user's terminals, or to all of them.
	protected push(e: LiveEvent, user?: string): void {
		const text = JSON.stringify(e);
		for (const ws of this.ctx.getWebSockets(user)) {
			try {
				ws.send(text);
			} catch {
				// closing; it will be gone on the next push
			}
		}
	}

	// expire ends sessions idle longer than IDLE_MS, with their locks, and
	// drops old undelivered messages.
	private expire(): void {
		const now = Date.now();
		this.sql.exec("DELETE FROM sessions WHERE seen < ?", now - IDLE_MS);
		this.sql.exec("DELETE FROM locks WHERE sid NOT IN (SELECT sid FROM sessions)");
		this.sql.exec("DELETE FROM messages WHERE sent < ?", now - KEEP_MESSAGES_MS);
	}

	private create(user: string, terminal: string, map = ""): string {
		const n = this.counter("tsu") % 99_999 + 1;
		this.setCounter("tsu", n);
		const sid = `TSU${String(n).padStart(5, "0")}`;
		const now = Date.now();
		this.sql.exec("INSERT OR REPLACE INTO sessions (sid, user, terminal, logon, seen, map) VALUES (?, ?, ?, ?, ?, ?)",
			sid, user, terminal, new Date(now).toISOString(), now, map);
		return sid;
	}

	// touch marks the session as seen and returns its sid, or starts a new
	// one when it has ended, never existed (a commarea from before
	// sessions), or belongs to someone else.
	private touch(sid: string, user: string, terminal: string, map?: string): string {
		const own = sid !== "" && this.sql.exec("SELECT 1 FROM sessions WHERE sid = ? AND user = ?", sid, user).toArray().length > 0;
		if (!own) return this.create(user, terminal, map);
		this.sql.exec("UPDATE sessions SET seen = ?, terminal = ?, map = COALESCE(?, map) WHERE sid = ?",
			Date.now(), terminal, map ?? null, sid);
		return sid;
	}

	private conflict(sid: string, want: string[]): Required<Holder> | undefined {
		for (const resource of want) {
			const h = this.holder(resource);
			if (h && h.sid !== sid) return h;
		}
		return undefined;
	}

	private take(sid: string, want: string[]): void {
		const since = new Date().toISOString();
		for (const resource of want) this.sql.exec("INSERT OR IGNORE INTO locks (resource, sid, since) VALUES (?, ?, ?)", resource, sid, since);
	}

	protected counter(name: string): number {
		return this.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = ?", name).toArray()[0]?.value ?? 0;
	}

	protected setCounter(name: string, value: number): void {
		this.sql.exec("INSERT OR REPLACE INTO counters (name, value) VALUES (?, ?)", name, value);
	}
}

// tso returns the system's one Sessions object.
export function tso<T extends Sessions<any>>(ns: DurableObjectNamespace<T>, name = "TSO"): DurableObjectStub<T> {
	return ns.get(ns.idFromName(name));
}

// notLocked refuses a change to resource made outside the screens (a REST
// API, say) while another user has it locked for update in one.
export async function notLocked(stub: DurableObjectStub<Sessions<any>>, resource: string, user: string): Promise<void> {
	const h = await stub.holder(resource);
	if (h && h.user !== user) {
		throw new HttpError(423, "locked", `record in use by ${h.user} on ${h.terminal}`);
	}
}
