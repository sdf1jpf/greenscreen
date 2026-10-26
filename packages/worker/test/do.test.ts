import { describe, expect, it, vi } from "vitest";
import { fakeState } from "./fakedo";
import { MAX_SESSIONS, Sessions } from "../src/sessions";

const tso = () => new Sessions(fakeState(), {});

describe("Sessions userids", () => {
	it("gives each identity a userid of its own, for good", () => {
		const s = tso();
		expect(s.userid("sub-john-smith", "JOHNSMIT")).toBe("JOHNSMIT");
		expect(s.userid("sub-johnsmith", "JOHNSMIT")).toBe("JOHNSMI2");
		expect(s.userid("sub-third", "JOHNSMIT")).toBe("JOHNSMI3");
		expect(s.userid("sub-john-smith", "JOHNSMIT")).toBe("JOHNSMIT");
		expect(s.userid("sub-johnsmith", "JOHNSMIT")).toBe("JOHNSMI2");
		expect(s.userid("sub-al", "AL")).toBe("AL");
		expect(s.userid("sub-al2", "AL")).toBe("AL2");
	});

	it("keeps colliding people's locks apart", () => {
		const s = tso();
		const a = s.userid("sub-a", "JOHNSMIT");
		const b = s.userid("sub-b", "JOHNSMIT");
		const sa = s.logon(a, "TERM0001");
		const sb = s.logon(b, "TERM0002");
		expect(s.sync(sa, a, "TERM0001", "X", ["PRODUCT 1"]).conflict).toBeUndefined();
		expect(s.sync(sb, b, "TERM0002", "X", ["PRODUCT 1"]).conflict).toMatchObject({ user: "JOHNSMIT", terminal: "TERM0001" });
	});
});

describe("Sessions ids", () => {
	it("gives out random session ids that never repeat", () => {
		const s = tso();
		const sids = new Set(Array.from({ length: 200 }, (_, i) => s.logon(`U${i % 50}`, "T")));
		expect(sids.size).toBe(200);
		for (const sid of sids) expect(sid).toMatch(/^TSU[0-9A-F]{20}$/);
	});

	it("ends a user's oldest session past the limit, with its locks", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const s = tso();
			const first = s.logon("ALICE", "T1");
			s.sync(first, "ALICE", "T1", "X", ["PRODUCT 1"]);
			const others = Array.from({ length: MAX_SESSIONS }, () => (vi.advanceTimersByTime(1000), s.logon("ALICE", "T2")));
			expect(s.users().filter((u) => u.user === "ALICE")).toHaveLength(MAX_SESSIONS);
			expect(s.users().map((u) => u.sid)).not.toContain(first);
			expect(s.holder("PRODUCT 1")).toBeNull();
			expect(s.users().map((u) => u.sid).sort()).toEqual([...others].sort());
			s.logon("BOB", "T3");
			expect(s.users().filter((u) => u.user === "BOB")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Sessions SEND", () => {
	it("keeps messages for logon only for userids someone has signed on as", () => {
		const s = tso();
		s.userid("carol@example.com", "CAROL");
		s.logon(s.userid("alice@example.com", "ALICE"), "T1");
		expect(s.send("ALICE", ["CAROL", "MADEUP"], "HI", true)).toEqual({ sent: ["CAROL"], notOn: ["MADEUP"] });
	});
});

