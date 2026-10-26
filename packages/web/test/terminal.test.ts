// The browser terminal's screen model and protocol (public/), which run in
// the page; they have no DOM dependencies, so they are tested here.
import { describe, expect, it } from "vitest";
import { decodeScreen, encodeRequest } from "../public/protocol.js";
import { Lock, Screen } from "../public/screen.js";

const response = {
	v: 1,
	state: "abc",
	screen: {
		map: "POSM01",
		rows: 24,
		cols: 80,
		fields: [
			{ row: 1, col: 2, text: "POSM01", color: "blue" },
			{ row: 4, col: 2, text: "NAME ===>", color: "turquoise" },
			{ row: 4, col: 12, name: "filter", length: 5, value: "AC" },
			{ row: 5, col: 12, name: "amount", length: 4, numeric: true },
			{ row: 6, col: 12, name: "note", length: 6, mixed: true },
		],
		cursor: { field: "amount" },
	},
};

describe("browser terminal", () => {
	it("presets the modified tag when the host asks", () => {
		const res = structuredClone(response);
		res.screen.fields.push({ row: 7, col: 12, name: "status", length: 1, value: "H", modified: true } as never);
		const { scr } = decodeScreen(res) as { scr: Screen };
		expect(scr.modifiedFields()).toEqual({ status: "H" });
		const body = encodeRequest({ aid: "ENTER", scr, state: "abc", system: "SYS1" });
		expect(body.modified).toEqual(["status"]);
		expect(body.system).toBe("SYS1");
	});

	it("lays out fields BMS style", () => {
		const { state, scr } = decodeScreen(response) as { state: string; scr: Screen };
		expect(state).toBe("abc");
		expect(scr.rowText(1).trimEnd()).toBe(" POSM01");
		expect(scr.rowText(4).trimEnd()).toBe(" NAME ===> AC");
		expect(scr.rowCol(scr.cursor)).toEqual([5, 12]);
	});

	it("edits fields like a 3270 and sends what changed", () => {
		const scr = decodeScreen(response).scr!;
		expect(scr.type("x", false)).toBe(Lock.NUMERIC);
		for (const ch of "1234") expect(scr.type(ch, false)).toBe(Lock.NONE);
		// Auto-skip: a full field moves the cursor to the next input field.
		expect(scr.fieldName(scr.cursor)).toBe("note");
		scr.type("a", false);
		scr.backTab();
		scr.backTab();
		expect(scr.fieldName(scr.cursor)).toBe("amount");
		scr.cursorHome();
		scr.endOfField();
		expect(scr.type("m", true)).toBe(Lock.NONE);
		scr.move(-2, 0); // into the protected heading
		expect(scr.type("q", false)).toBe(Lock.PROTECTED);

		const body = encodeRequest({ aid: "ENTER", scr, state: "abc", terminal: "WEBTERM1" });
		expect(body).toMatchObject({
			v: 1,
			aid: "ENTER",
			state: "abc",
			fields: { filter: "ACM", amount: "1234", note: "a" },
			modified: ["filter", "amount", "note"],
			rows: 24,
			cols: 80,
			terminal: "WEBTERM1",
		});
		expect(encodeRequest({ aid: "START", scr, state: "abc" }).state).toBeUndefined();
	});

	it("keeps typed input across a redraw at a new size", () => {
		const old = decodeScreen(response).scr!;
		old.type("9", false);
		const wide = decodeScreen({ ...response, screen: { ...response.screen, rows: 30, cols: 120 } }).scr!;
		wide.carry(old);
		expect(wide.modifiedFields()).toEqual({ amount: "9" });
		expect(wide.rowCol(wide.cursor)).toEqual([5, 13]);
	});

	it("reads the refresh interval of a live screen", () => {
		expect(decodeScreen(response).refresh).toBe(0);
		expect(decodeScreen({ ...response, screen: { ...response.screen, refresh: 5 } }).refresh).toBe(5);
	});

	it("passes a logoff through", () => {
		expect(decodeScreen({ v: 1, logoff: { message: "LOGGED OFF" } })).toEqual({ logoff: "LOGGED OFF" });
	});
});
