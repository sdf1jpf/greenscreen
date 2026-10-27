// The keyboard cases in testdata/terminal.json, which the Go terminal runs
// too (internal/host), so the two screen models edit fields alike.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeScreen } from "../public/protocol.js";
import { Lock, type Screen } from "../public/screen.js";

type Case = { name: string; keys: string[]; want: { fields: Record<string, string>; modified: string[]; cursor: [number, number]; lock: string } };
const data = JSON.parse(readFileSync(new URL("../../../testdata/terminal.json", import.meta.url), "utf8")) as { screen: unknown; cases: Case[] };

function run(keys: string[]) {
	const scr: Screen = decodeScreen({ v: 1, state: "", screen: data.screen }).scr;
	let lock: string = Lock.NONE;
	let insert = false;
	for (const key of keys) {
		const [op, ...args] = key.split(" ");
		const n = args.map(Number);
		if (op === "type") {
			for (const ch of args.join(" ")) if ((lock = scr.type(ch, insert)) !== Lock.NONE) break;
		} else if (op === "insert") insert = !insert;
		else if (op === "reset") lock = Lock.NONE;
		else if (op === "move") scr.move(n[0], n[1]);
		else if (op === "moveTo") scr.moveTo(scr.addr(n[0], n[1]));
		else if (op === "tab") scr.tab();
		else if (op === "backtab") scr.backTab();
		else if (op === "newline") scr.newLine();
		else if (op === "home") scr.cursorHome();
		else if (op === "end") scr.endOfField();
		else if (op === "backspace") lock = scr.backspace();
		else if (op === "delete") lock = scr.delete();
		else if (op === "eraseEOF") lock = scr.eraseEOF();
		else if (op === "eraseInput") scr.eraseInput();
		else throw new Error(`unknown key ${key}`);
	}
	const fields: Record<string, string> = {};
	scr.buf.forEach((c, i) => {
		if (c.attr && !c.attr.protected && c.attr.name) fields[c.attr.name] = scr.fieldText(i);
	});
	return { fields, modified: Object.keys(scr.modifiedFields()).sort(), cursor: scr.rowCol(scr.cursor), lock };
}

describe("keyboard cases shared with the Go terminal", () => {
	for (const c of data.cases) it(c.name, () => expect(run(c.keys)).toEqual(c.want));
});
