// Logon via Cloudflare Access. Access sits in front of the Worker, signs
// people in with the team's identity provider, and forwards each allowed
// request with a signed JWT in the Cf-Access-Jwt-Assertion header. The
// Worker checks that JWT itself too, so a request that reaches it some other
// way (a preview URL, a misconfigured policy) is still refused.
//
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

import { HttpError } from "./http.js";

export const ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";

const CLOCK_SKEW_S = 60;
const KEYS_TTL_MS = 3_600_000;
// An unknown kid refetches the keys at most this often, so tokens made up
// by anyone who reaches the Worker can't have it fetch on every request.
const REFETCH_MS = 60_000;

export interface Claims {
	iss?: string;
	aud?: string | string[];
	exp?: number;
	nbf?: number;
	email?: string;
	common_name?: string; // service tokens: the client ID
}

// Identity is who signed on. id is unique to a person or a service token:
// through Access, the email (lower case) or the token's client ID, which is
// what to name in a list of who may do something. userid is the TSO-style name
// for screens and SEND, up to eight characters. Two identities can want the
// same userid (john.smith@ and johnsmith@ both make JOHNSMIT), so with
// sessions each id gets a userid of its own (see SessionStore.userid).
export interface Identity {
	id: string;
	userid: string;
}

// Signing keys per team domain, refetched hourly, or when a new kid appears
// and they are more than REFETCH_MS old. Requests that need a fetch at the
// same time share it, and if it fails the keys already fetched still serve.
const keyCache = new Map<string, { keys: Map<string, CryptoKey>; fetched: number }>();
const fetching = new Map<string, Promise<void>>();

async function signingKey(team: string, kid: string): Promise<CryptoKey | undefined> {
	const entry = keyCache.get(team);
	const age = entry ? Date.now() - entry.fetched : Infinity;
	if (age > KEYS_TTL_MS || (!entry?.keys.has(kid) && age > REFETCH_MS)) {
		let pending = fetching.get(team);
		if (!pending) {
			pending = fetchKeys(team).finally(() => fetching.delete(team));
			fetching.set(team, pending);
		}
		try {
			await pending;
		} catch (e) {
			if (!entry) throw e;
			console.error(e); // keep using the keys from before, and try again in a minute
			entry.fetched = Math.max(entry.fetched, Date.now() - KEYS_TTL_MS + REFETCH_MS);
		}
	}
	return keyCache.get(team)?.keys.get(kid);
}

async function fetchKeys(team: string): Promise<void> {
	const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error(`fetching Access certs: ${res.status}`);
	const { keys } = await res.json<{ keys: (JsonWebKey & { kid: string })[] }>();
	const imported = new Map<string, CryptoKey>();
	for (const jwk of keys) {
		imported.set(
			jwk.kid,
			await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
		);
	}
	keyCache.set(team, { keys: imported, fetched: Date.now() });
}

function b64url(s: string): Uint8Array {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decode<T>(part: string): T {
	return JSON.parse(new TextDecoder().decode(b64url(part)));
}

// verify returns the JWT's claims if it is signed by the team's Access keys,
// meant for this application, and current; otherwise undefined.
async function verify(team: string, aud: string, jwt: string): Promise<Claims | undefined> {
	const parts = jwt.split(".");
	if (parts.length !== 3) return undefined;
	let header: { alg?: string; kid?: string };
	let claims: Claims;
	let sig: Uint8Array;
	try {
		header = decode(parts[0]);
		claims = decode(parts[1]);
		sig = b64url(parts[2]);
	} catch {
		return undefined;
	}
	if (header.alg !== "RS256" || !header.kid) return undefined;
	const key = await signingKey(team, header.kid);
	if (!key) return undefined;
	const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
	if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signed))) return undefined;

	const now = Date.now() / 1000;
	const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (claims.iss !== `https://${team}`) return undefined;
	if (!auds.includes(aud)) return undefined;
	if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_S) return undefined;
	if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_S) return undefined;
	return claims;
}

// userIdFor turns an Access identity into a mainframe-style userid: the
// email's local part, or a service token's client ID, upper case, letters
// and digits only, at most eight characters. It is a name to show, not an
// identity: different people can get the same one.
export function userIdFor(claims: Claims): string {
	const name = claims.email ? claims.email.split("@")[0] : (claims.common_name ?? "").replace(/\.access$/i, "");
	const id = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
	return id || (claims.email ? "USER" : "SERVICE");
}

// identityFor is the Identity of an Access JWT's claims: the email, or a
// service token's client ID, named by userId.
function identityFor(claims: Claims, userId: (claims: Claims) => string): Identity {
	const id = (claims.email || claims.common_name || "").toLowerCase();
	if (!id) throw new HttpError(401, "unauthorized", "the Access token names no email or service token");
	return { id, userid: userId(claims) };
}

// Auth signs a request on: it returns who signed on, or throws a 401
// HttpError. A plain string is a userid that is its own identity. E is the
// Worker's bindings.
export type Auth<E = unknown> = (env: E, req: Request) => Promise<string | Identity>;

export interface AccessEnv {
	ACCESS_TEAM_DOMAIN?: string; // e.g. "example.cloudflareaccess.com"
	ACCESS_AUD?: string; // the Access application's audience tag
	DEV_USER?: string; // wrangler dev only, when Access is not configured
}

// accessAuth signs people on through Cloudflare Access, configured by the
// ACCESS_TEAM_DOMAIN and ACCESS_AUD bindings. Without them it signs on
// DEV_USER, for local development, or refuses every request.
export function accessAuth<E extends AccessEnv>(userId: (claims: Claims) => string = userIdFor): Auth<E> {
	return async (env, req) => {
		if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
			if (env.DEV_USER) return env.DEV_USER.toUpperCase();
			throw new HttpError(500, "internal", "Cloudflare Access is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD");
		}
		const jwt = req.headers.get(ASSERTION_HEADER);
		const claims = jwt ? await verify(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, jwt) : undefined;
		if (!claims) throw new HttpError(401, "unauthorized", "not signed in through Cloudflare Access");
		return identityFor(claims, userId);
	};
}

// Headers a Cloudflare Access service token is sent in.
export const CLIENT_ID_HEADER = "CF-Access-Client-Id";
export const CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";

// tokenHash is how serviceTokenAuth keeps a secret: SHA-256, in hex.
export async function tokenHash(secret: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
	return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

// serviceTokenAuth signs on the clients that hold one of a known set of
// service tokens, checking the client ID and secret they send itself, for
// a server Cloudflare Access isn't in front of: one on a store's own
// network, say, that its terminals reach directly. They keep the token
// they use through Access, so a terminal moves between the two by its URL
// alone. tokens maps each client ID to tokenHash(secret); the identity is
// the same as accessAuth gives the token, so its userid is too.
export function serviceTokenAuth<E>(tokens: (env: E) => Record<string, string> | undefined): Auth<E> {
	return async (env, req) => {
		const id = req.headers.get(CLIENT_ID_HEADER)?.trim().toLowerCase();
		const secret = req.headers.get(CLIENT_SECRET_HEADER);
		const known = Object.fromEntries(Object.entries(tokens(env) ?? {}).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
		const want = id ? known[id] : undefined;
		if (!id || !secret || !want || !same(await tokenHash(secret), want)) {
			throw new HttpError(401, "unauthorized", "not signed on: send a known service token");
		}
		return identityFor({ common_name: id }, userIdFor);
	};
}

// same compares two strings in time that doesn't depend on where they differ.
function same(a: string, b: string): boolean {
	let d = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	return d === 0;
}

// The header a gateway names who it signs on in.
export const GATEWAY_USER_HEADER = "Greenscreen-User";

const EMAIL = /^[^\s@]+@[^\s@]+$/;

// gatewayAuth lets a gateway that signs people on itself, such as
// `greenscreen serve-ssh` with its authorized keys, say who each request is
// for. The gateway signs on through auth as usual (with its own service
// token, say); when that identity is one of gateways, the request is for the
// email in the Greenscreen-User header instead, the same identity Access
// would give that person, so their userid, locks and messages follow them
// between SSH and a browser. Anyone else naming a user, and a gateway naming
// no one, is refused.
export function gatewayAuth<E>(
	auth: Auth<E>,
	gateways: (env: E) => string[] | undefined,
	userId: (claims: Claims) => string = userIdFor,
): Auth<E> {
	return async (env, req) => {
		const got = await auth(env, req);
		const id = (typeof got === "string" ? got : got.id).toLowerCase();
		const gateway = (gateways(env) ?? []).some((g) => g.trim().toLowerCase() === id);
		const named = req.headers.get(GATEWAY_USER_HEADER)?.trim().toLowerCase();
		if (!named) {
			if (gateway) throw new HttpError(401, "unauthorized", `a gateway must name who it signs on in ${GATEWAY_USER_HEADER}`);
			return got;
		}
		if (!gateway) throw new HttpError(401, "unauthorized", `only a gateway may send ${GATEWAY_USER_HEADER}`);
		if (!EMAIL.test(named)) throw new HttpError(401, "unauthorized", `${GATEWAY_USER_HEADER} must be an email`);
		return identityFor({ email: named }, userId);
	};
}
