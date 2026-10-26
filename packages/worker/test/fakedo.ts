// A stand-in for the Workers runtime, enough to run the Sessions Durable
// Object under Node: its SQLite storage is node:sqlite.

// @ts-expect-error: this package has Workers types, not Node's
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(readonly ctx: unknown, readonly env: unknown) {}
	},
}));

(globalThis as Record<string, unknown>).WebSocketRequestResponsePair ??= class {
	constructor(readonly request: string, readonly response: string) {}
};

export function fakeState(): DurableObjectState {
	const db = new DatabaseSync(":memory:");
	const sql = {
		exec(query: string, ...bindings: unknown[]) {
			let rows: Record<string, unknown>[] = [];
			if (bindings.length === 0 && query.split(";").filter((q) => q.trim()).length > 1) db.exec(query);
			else rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
			return {
				toArray: () => rows,
				one: () => rows[0],
				[Symbol.iterator]: () => rows[Symbol.iterator](),
			};
		},
	};
	return {
		storage: { sql, getAlarm: async () => null, setAlarm: async () => {} },
		setWebSocketAutoResponse() {},
		acceptWebSocket() {},
		getWebSockets: () => [],
	} as unknown as DurableObjectState;
}
