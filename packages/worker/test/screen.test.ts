import { describe, expect, it } from "vitest";
import { layoutProblems, menuProgram, Screen, type Ctx } from "../src";

describe("layoutProblems", () => {
	it("finds fields off the screen or on top of each other, attribute positions included", () => {
		const scr = new Screen("TST010", 24, 80);
		scr.text(1, 2, "TST010");
		scr.text(1, 8, "TITLE"); // its attribute position is the last letter of TST010
		scr.input(4, 12, 5, "name");
		scr.text(4, 18, "OK"); // the attribute position after name's data: fine
		scr.text(25, 1, "LOST");
		scr.text(24, 75, "TOO LONG HERE");
		expect(layoutProblems(scr)).toEqual([
			'text "TITLE" at 1,8 overlaps text "TST010" at 1,2',
			'text "LOST" at 25,1 is off the 24x80 screen',
			'text "TOO LONG HERE" at 24,75 runs off the end of the screen',
		]);
	});

	it("passes a screen laid out with room for the attribute positions", () => {
		const scr = new Screen("TST010", 24, 80);
		scr.text(1, 2, "TST010");
		scr.text(1, 9, "TITLE");
		scr.input(2, 1, 79, "line");
		expect(layoutProblems(scr)).toEqual([]);
	});
});

describe("menus", () => {
	const ctx = { app: { title: "T", prefix: "TST", system: "SYS1" }, user: "ADA", uid: "ada", rows: 24, cols: 80, system: "SYS1", terminal: "T1", host: "h", tzOffset: 0, sid: "", live: false, env: {} } as Ctx;
	const options = (n: number) => Array.from({ length: n }, (_, i) => ({ key: String(i + 1), name: `OPT${i + 1}`, desc: `OPTION NUMBER ${i + 1} DOES THINGS` }));

	it("shows a menu too long for one column in two, clear of the hints", async () => {
		const scr = await menuProgram({ "": { map: "TSTM00", title: "MENU", options: options(20) } }).render(ctx, { p: "menu" });
		expect(layoutProblems(scr)).toEqual([]);
		const at = (text: string) => scr.fields.find((f) => f.text === text);
		expect(at("OPT1")).toMatchObject({ row: 6, col: 7 });
		expect(at("OPT10")).toMatchObject({ row: 15, col: 7 });
		expect(at("OPT11")).toMatchObject({ row: 6, col: 45 });
		expect(at("USERID")).toMatchObject({ row: 17 });
		expect(Math.max(...scr.fields.filter((f) => f.text?.startsWith("OPT")).map((f) => f.row))).toBeLessThan(24 - 4);
	});

	it("keeps a short menu in one column", async () => {
		const scr = await menuProgram({ "": { map: "TSTM00", title: "MENU", options: options(4) } }).render(ctx, { p: "menu" });
		expect(scr.fields.find((f) => f.text === "OPT4")).toMatchObject({ row: 9, col: 7 });
		expect(scr.fields.find((f) => f.text?.startsWith("OPTION NUMBER 4"))?.text).toBe("OPTION NUMBER 4 DOES THINGS");
	});

	describe("fast paths", () => {
		const went: string[] = [];
		const go = (name: string) => (_: Ctx, back: { sub?: string }, arg: string) => {
			went.push(`${name} from ${back.sub ?? "primary"} arg ${arg}`);
			return back as never;
		};
		const prog = menuProgram({
			"": { map: "TSTM00", title: "PRIMARY", options: [
				{ key: "1", name: "EDIT", desc: "edit", go: go("EDIT") },
				{ key: "2", name: "UTIL", desc: "utilities", sub: "util" },
			] },
			util: { map: "TSTM01", title: "UTIL", parent: "", options: [
				{ key: "1", name: "COPY", desc: "copy", go: go("COPY") },
				{ key: "3", name: "DEEP", desc: "more", sub: "deep" },
			] },
			deep: { map: "TSTM02", title: "DEEP", parent: "util", options: [{ key: "9", name: "NINE", desc: "nine", go: go("NINE") }] },
		});
		const enter = (option: string, sub?: string) =>
			prog.handle(ctx, { p: "menu", sub }, { aid: "ENTER", fields: { option }, modified: new Set(["option"]), cursorField: "option" });

		it("goes down a dotted path from any menu, and back to the option's own menu", async () => {
			went.length = 0;
			await enter("2.3.9 X1", "util");
			await enter("=1");
			await enter("copy");
			expect(went).toEqual(["NINE from deep arg X1", "EDIT from primary arg ", "COPY from util arg "]);
		});

		it("opens a submenu by path, and = alone goes to the primary menu", async () => {
			expect(await enter("2.3")).toEqual({ p: "menu", sub: "deep" });
			expect(await enter("=", "deep")).toEqual({ p: "menu" });
		});

		it("refuses a path that goes past an option or names nothing", async () => {
			for (const bad of ["1.2", "2.7", "9", "=2.1.4"]) {
				const r = await enter(bad, "util");
				expect(r).toMatchObject({ msg: `ISPD117E INVALID OPTION ${bad}`, option: bad });
			}
		});
	});
});
