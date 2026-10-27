// createApp puts the screen engine behind a Hono app: health, the
// application's info for the clients' logon screen, and POST /v1/screen,
// signed on per route, plus GET /v1/live and POST /v1/snapshot when the
// app has them. Add your own routes to the app it returns, with the same
// signedOn middleware.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { accessAuth, type AccessEnv, type Auth, type Identity } from "./auth.js";
import { requestKeys, screenHandler, type ScreenConfig, type SessionStore } from "./engine.js";
import { errorResponse, HttpError, json, readJSON, str } from "./http.js";
import { format, imageResponse, render, screenHtml, snapScreen } from "./snapshot.js";

export type AppEnv<E extends object> = { Bindings: E; Variables: { user: string; uid: string } };

export interface AppConfig<E extends object> extends ScreenConfig<E> {
	auth?: Auth<E>; // how a request signs on; default Cloudflare Access
	// live serves GET /v1/live, the clients' push channel: the request, with
	// the userid in the USER_HEADER header, goes to this WebSocket server,
	// such as the Sessions Durable Object from "@greenscreen-dev/worker/sessions".
	// Returning undefined answers 503.
	live?: (env: E) => { fetch(req: Request): Promise<Response> } | undefined;
	// snapshot serves POST /v1/snapshot, a screen drawn as a PNG or PDF by
	// Browser Rendering: browser returns the Browser Run binding. Each one
	// costs browser time, so a user gets SNAPSHOTS_PER_MINUTE of them: limit
	// returns a rate limiting binding to count them across the Worker's
	// isolates instead, keyed by userid.
	snapshot?: { browser: (env: E) => BrowserRun | undefined; limit?: (env: E) => RateLimit | undefined };
}

export const SNAPSHOTS_PER_MINUTE = 10;

const USERID_CACHE = 10_000; // identities each isolate remembers the userid of

// USER_HEADER carries the signed-on userid to the live server.
export const USER_HEADER = "X-Greenscreen-User";

// signedOn signs the request on and sets "user" to the userid and "uid"
// to the identity, or throws 401. With sessions, the store gives each
// identity a userid of its own. It runs per route, so unknown paths get 404
// without signing on.
export function signedOn<E extends object>(auth: Auth<E>, sessions?: (env: E) => SessionStore | undefined): MiddlewareHandler<AppEnv<E>> {
	// A store gives an identity its userid for good, so each isolate keeps
	// the ones it has seen rather than ask the store on every request.
	const userids = new Map<string, string>();
	const useridOf = async (store: SessionStore, who: Identity) => {
		let userid = userids.get(who.id);
		if (userid === undefined) {
			userid = await store.userid!(who.id, who.userid);
			if (userids.size >= USERID_CACHE) userids.clear();
			userids.set(who.id, userid);
		}
		return userid;
	};
	return async (c, next) => {
		const ctx = c as unknown as Context<{ Variables: { user: string; uid: string } }>;
		const got = await auth(c.env as E, c.req.raw);
		const who: Identity = typeof got === "string" ? { id: got, userid: got } : got;
		const store = sessions?.(c.env as E);
		ctx.set("user", store?.userid ? await useridOf(store, who) : who.userid);
		ctx.set("uid", who.id);
		await next();
	};
}

export function createApp<E extends object = AccessEnv>(config: AppConfig<E>): Hono<AppEnv<E>> & { signedOn: MiddlewareHandler<AppEnv<E>> } {
	const auth = config.auth ?? (accessAuth() as Auth<E>);
	const guard = signedOn(auth, config.sessions);
	const screen = screenHandler(config);
	const app = new Hono<AppEnv<E>>({ strict: false });

	app.onError((e) => {
		if (e instanceof HttpError) return errorResponse(e);
		console.error(e);
		return errorResponse(new HttpError(500, "internal", "internal error"));
	});
	app.notFound(() => errorResponse(new HttpError(404, "not_found", "no such endpoint")));

	app.get("/v1/health", () => json(200, { status: "ok" }));

	// The clients ask this before logon to title their logon screen, so it
	// is not signed on and says nothing secret.
	app.get("/v1/screen/info", () => {
		const { title, system, prefix, banner, tagline } = config.app;
		return json(200, {
			v: 1, title, system, prefix, ...(banner ? { banner } : {}), ...(tagline ? { tagline } : {}),
			live: !!config.live, snapshot: !!config.snapshot,
		});
	});

	app.post("/v1/session", guard, (c) => json(201, { userid: user(c) }));

	app.post("/v1/screen", guard, async (c) =>
		json(200, await screen(c.env as E, { id: uid(c), userid: user(c) }, new URL(c.req.url), await readJSON(c.req.raw, requestKeys))));

	const live = config.live;
	if (live) {
		app.get("/v1/live", guard, async (c) => {
			if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
				throw new HttpError(426, "bad_request", "GET /v1/live is a WebSocket: send Upgrade: websocket");
			}
			const req = new Request(c.req.raw);
			req.headers.set(USER_HEADER, user(c));
			const server = live(c.env as E);
			if (!server) throw new HttpError(503, "unavailable", "live updates are not available");
			return server.fetch(req);
		});
	}

	const snapshot = config.snapshot;
	if (snapshot) {
		const counts = new Map<string, { since: number; n: number }>(); // in this isolate, without a limit binding
		const allowed = async (env: E, who: string): Promise<boolean> => {
			const binding = snapshot.limit?.(env);
			if (binding) return (await binding.limit({ key: who })).success;
			const now = Date.now();
			for (const [k, v] of counts) if (now - v.since > 60_000) counts.delete(k);
			const n = counts.get(who) ?? { since: now, n: 0 };
			counts.set(who, n);
			return ++n.n <= SNAPSHOTS_PER_MINUTE;
		};
		app.post("/v1/snapshot", guard, async (c) => {
			if (!(await allowed(c.env as E, user(c)))) {
				throw new HttpError(429, "too_many_requests", "too many snapshots: wait a minute");
			}
			const body = await readJSON(c.req.raw, ["format", "screen", "terminal", "map"]);
			const f = format(body.format);
			const scr = snapScreen(body.screen);
			const now = new Date().toISOString().slice(0, 16).replace("T", " ");
			const map = str(body, "map").replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 8) || "SCREEN";
			const caption = `SNAPSHOT ${map}  ${user(c)}  ${str(body, "terminal").slice(0, 8)}  ${now} UTC`.replace(/ {3,}/g, "  ");
			const stamp = now.replace(/[-: ]/g, "").slice(0, 12);
			return imageResponse(await render(snapshot.browser(c.env as E), screenHtml(scr, caption), f), f, `${map}-${stamp}.${f}`);
		});
	}

	return Object.assign(app, { signedOn: guard });
}

// user is the userid signedOn set on the request.
export function user(c: Context): string {
	return (c as Context<{ Variables: { user: string } }>).get("user");
}

// uid is the identity signedOn set on the request (Identity.id).
export function uid(c: Context): string {
	return (c as Context<{ Variables: { uid: string } }>).get("uid");
}
