// JSON helpers and the error envelope the clients expect:
// {"error": {"code", "message", "field"?}}.

export type ErrorCode =
	| "unauthorized"
	| "not_found"
	| "conflict"
	| "invalid"
	| "bad_request"
	| "method_not_allowed"
	| "internal";

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: ErrorCode,
		message: string,
		readonly field?: string,
	) {
		super(message);
	}
}

export function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function noContent(): Response {
	return new Response(null, { status: 204 });
}

export function errorResponse(e: HttpError): Response {
	const detail: Record<string, string> = { code: e.code, message: e.message };
	if (e.field) detail.field = e.field;
	return json(e.status, { error: detail });
}

const MAX_BODY = 1 << 20;

// readJSON parses a request body as a JSON object, rejecting oversized
// bodies and keys outside `allowed`.
export async function readJSON(req: Request, allowed: readonly string[]): Promise<Record<string, unknown>> {
	const text = await req.text();
	if (text.length > MAX_BODY) throw new HttpError(413, "bad_request", "request body too large");
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new HttpError(400, "bad_request", "invalid request body: not JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new HttpError(400, "bad_request", "invalid request body: expected an object");
	}
	for (const key of Object.keys(body)) {
		if (!allowed.includes(key)) {
			throw new HttpError(400, "bad_request", `invalid request body: unknown field "${key}"`);
		}
	}
	return body as Record<string, unknown>;
}

export function str(body: Record<string, unknown>, key: string): string {
	const v = body[key] ?? "";
	if (typeof v !== "string") throw new HttpError(400, "bad_request", `invalid request body: "${key}" must be a string`);
	return v;
}

export function int(body: Record<string, unknown>, key: string): number {
	const v = body[key] ?? 0;
	if (typeof v !== "number" || !Number.isInteger(v)) {
		throw new HttpError(400, "bad_request", `invalid request body: "${key}" must be an integer`);
	}
	return v;
}
