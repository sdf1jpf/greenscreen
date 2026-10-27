import { describe, expect, it } from "vitest";
import { page, position, scroll, type Ctx, type Scrolled } from "../src";

const ctx = { app: { prefix: "TST" } } as Ctx;
const items = Array.from({ length: 40 }, (_, i) => i);

describe("scrolled lists", () => {
	it("pages down and up, and says when there is no further to go", () => {
		const s: Scrolled = {};
		expect(page(s, items, 16)).toEqual(items.slice(0, 16));
		expect(position(s, 16)).toBe("ROW 1 TO 16 OF 40");
		expect(scroll(ctx, s, "PF7", 16)).toBe("TST0101W ALREADY AT TOP OF DATA");
		expect(scroll(ctx, s, "PF8", 16)).toBe("");
		expect(scroll(ctx, s, "PF8", 16)).toBe("");
		expect(page(s, items, 16)).toEqual(items.slice(24, 40)); // the last page is a full one
		expect(position(s, 16)).toBe("ROW 25 TO 40 OF 40");
		expect(scroll(ctx, s, "PF8", 16)).toBe("TST0102W ALREADY AT BOTTOM OF DATA");
		expect(scroll(ctx, s, "PF7", 16)).toBe("");
		expect(page(s, items, 16)).toEqual(items.slice(8, 24));
		expect(scroll(ctx, s, "ENTER", 16)).toBeUndefined();
	});

	it("follows a list that got shorter and leaves out the position when it all fits", () => {
		const s: Scrolled = { top: 30 };
		expect(page(s, items.slice(0, 20), 16)).toEqual(items.slice(4, 20));
		expect(s.top).toBe(4);
		expect(page(s, items.slice(0, 5), 16)).toEqual(items.slice(0, 5));
		expect(position(s, 16)).toBe("");
		expect(scroll(ctx, s, "PF8", 16)).toBe("TST0102W ALREADY AT BOTTOM OF DATA");
	});
});
