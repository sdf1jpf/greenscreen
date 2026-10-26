// The commarea: the state string each reply carries and the client sends
// back unchanged. With a key it is signed (HMAC-SHA256), so a panel can
// trust what it put there, such as a running total; a state that was
// changed on the way is treated as lost. Without a key it is plain JSON.

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function seal(payload: string, key?: string): Promise<string> {
	if (!key) return payload;
	const body = b64url(enc.encode(payload));
	return `${body}.${b64url(await mac(key, body))}`;
}

// open returns the payload of a sealed state, or undefined if its
// signature is wrong or missing.
export async function open(state: string, key?: string): Promise<string | undefined> {
	if (!key) return state;
	const dot = state.indexOf(".");
	if (dot < 0) return undefined;
	const body = state.slice(0, dot);
	const sig = unb64url(state.slice(dot + 1));
	if (!sig) return undefined;
	const k = await hmacKey(key);
	if (!(await crypto.subtle.verify("HMAC", k, sig, enc.encode(body)))) return undefined;
	const bytes = unb64url(body);
	return bytes ? dec.decode(bytes) : undefined;
}

const keys = new Map<string, CryptoKey>();

async function hmacKey(secret: string): Promise<CryptoKey> {
	let k = keys.get(secret);
	if (!k) {
		k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
		keys.set(secret, k);
	}
	return k;
}

async function mac(secret: string, body: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
}

function b64url(b: Uint8Array): string {
	let s = "";
	for (const c of b) s += String.fromCharCode(c);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array | undefined {
	try {
		const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
		return Uint8Array.from(bin, (c) => c.charCodeAt(0));
	} catch {
		return undefined;
	}
}
