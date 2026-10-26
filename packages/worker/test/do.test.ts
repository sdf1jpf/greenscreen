import { describe, expect, it } from "vitest";
import { fakeState } from "./fakedo";
import { Sessions } from "../src/sessions";

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
