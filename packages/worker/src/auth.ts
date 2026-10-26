// Logon via Cloudflare Access. Access sits in front of the Worker, signs
// people in with the team's identity provider, and forwards each allowed
// request with a signed JWT in the Cf-Access-Jwt-Assertion header. The
// Worker checks that JWT itself too, so a request that reaches it some other
// way (a preview URL, a misconfigured policy) is still refused.
//
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

import { HttpError } from "./http";

export const ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";

const CLOCK_SKEW_S = 60;
const KEYS_TTL_MS = 3_600_000;

export interface Claims {
	iss?: string;
	aud?: string | string[];
	exp?: number;
	nbf?: number;
	email?: string;
	common_name?: string; // service tokens: the client ID
}

// Signing keys per team domain, refetched hourly or when a new kid appears.
const keyCache = new Map<string, { keys: Map<string, CryptoKey>; fetched: number }>();

async function signingKey(team: string, kid: string): Promise<CryptoKey | undefined> {
	let entry = keyCache.get(team);
	if (!entry || !entry.keys.has(kid) || Date.now() - entry.fetched > KEYS_TTL_MS) {
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
		entry = { keys: imported, fetched: Date.now() };
		keyCache.set(team, entry);
	}
	return entry.keys.get(kid);
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
	try {
		header = decode(parts[0]);
		claims = decode(parts[1]);
	} catch {
		return undefined;
	}
	if (header.alg !== "RS256" || !header.kid) return undefined;
	const key = await signingKey(team, header.kid);
	if (!key) return undefined;
	const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
	if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), signed))) return undefined;

	const now = Date.now() / 1000;
	const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (claims.iss !== `https://${team}`) return undefined;
	if (!auds.includes(aud)) return undefined;
	if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_S) return undefined;
	if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_S) return undefined;
	return claims;
}

// userIdFor turns an Access identity into a mainframe-style userid: the
// email's local part, upper case, letters and digits only, at most eight
// characters. Service tokens (used by CI) log on as SERVICE.
export function userIdFor(claims: Claims): string {
	if (!claims.email) return "SERVICE";
	const local = claims.email.split("@")[0].toUpperCase().replace(/[^A-Z0-9]/g, "");
	return local.slice(0, 8) || "USER";
}

// Auth signs a request on: it returns the userid, or throws a 401
// HttpError. E is the Worker's bindings.
export type Auth<E = unknown> = (env: E, req: Request) => Promise<string>;

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
		return userId(claims);
	};
}
