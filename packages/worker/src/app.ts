// createApp puts the screen engine behind a Hono app: health, the
// application's info for the clients' logon screen, and POST /v1/screen,
// signed on per route. Add your own routes to the app it returns, with the
// same signedOn middleware.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { accessAuth, type AccessEnv, type Auth } from "./auth";
import { requestKeys, screenHandler, type ScreenConfig } from "./engine";
import { errorResponse, HttpError, json, readJSON } from "./http";

export type AppEnv<E extends object> = { Bindings: E; Variables: { user: string } };

export interface AppConfig<E extends object> extends ScreenConfig<E> {
	auth?: Auth<E>; // how a request signs on; default Cloudflare Access
}

// signedOn signs the request on and sets "user" to the userid, or throws
// 401. It runs per route, so unknown paths get 404 without signing on.
export function signedOn<E extends object>(auth: Auth<E>): MiddlewareHandler<AppEnv<E>> {
	return async (c, next) => {
		const ctx = c as unknown as Context<{ Variables: { user: string } }>;
		ctx.set("user", await auth(c.env as E, c.req.raw));
		await next();
	};
}

export function createApp<E extends object = AccessEnv>(config: AppConfig<E>): Hono<AppEnv<E>> & { signedOn: MiddlewareHandler<AppEnv<E>> } {
	const auth = config.auth ?? (accessAuth() as Auth<E>);
	const guard = signedOn(auth);
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
		const { title, system, prefix, banner } = config.app;
		return json(200, { v: 1, title, system, prefix, ...(banner ? { banner } : {}) });
	});

	app.post("/v1/session", guard, (c) => json(201, { userid: user(c) }));

	app.post("/v1/screen", guard, async (c) =>
		json(200, await screen(c.env as E, user(c), new URL(c.req.url), await readJSON(c.req.raw, requestKeys))));

	return Object.assign(app, { signedOn: guard });
}

// user is the userid signedOn set on the request.
export function user(c: Context): string {
	return (c as Context<{ Variables: { user: string } }>).get("user");
}
