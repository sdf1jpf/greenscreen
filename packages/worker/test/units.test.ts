import { describe, expect, it } from "vitest";
import { HttpError, parseSend, readJSON, screenHtml } from "../src";

describe("parseSend", () => {
	it("reads the message, users and LOGON", () => {
		expect(parseSend("SEND 'LUNCH AT NOON?' USER(JFRANK)")).toEqual({ text: "LUNCH AT NOON?", users: ["JFRANK"], logon: false });
		expect(parseSend("tso se 'hi' u(a, b) logon")).toEqual({ text: "hi", users: ["A", "B"], logon: true });
		expect(parseSend("SE 'DOWN AT 5' USER(*) NOW")).toEqual({ text: "DOWN AT 5", users: ["*"], logon: false });
		expect(parseSend("SEND 'PRINTER JAMMED'")).toEqual({ text: "PRINTER JAMMED", users: [], logon: false });
	});

	it("takes a doubled quote as one", () => {
		expect(parseSend("SEND 'IT''S UP' USER(A)").text).toBe("IT'S UP");
	});

	it("says what is wrong", () => {
		const why = (cmd: string) => {
			try {
				parseSend(cmd);
			} catch (e) {
				expect(e).toBeInstanceOf(HttpError);
				return (e as HttpError).message;
			}
			return "";
		};
		expect(why("SEND HELLO")).toMatch(/enter SEND 'message'/);
		expect(why("SEND '  '")).toMatch(/enter SEND 'message'/);
		expect(why(`SEND '${"X".repeat(116)}'`)).toMatch(/longer than 115/);
		expect(why("SEND 'HI' USER()")).toMatch(/1 to 8 letters/);
		expect(why("SEND 'HI' USER(TOOLONGID)")).toMatch(/1 to 8 letters/);
		expect(why("SEND 'HI' USER(A) LATER")).toMatch(/unknown SEND operand LATER/);
	});
});

describe("screenHtml", () => {
	it("draws fields where they are, wraps at the end of a line, and hides hidden text", () => {
		const { html } = screenHtml({
			rows: 3,
			cols: 10,
			fields: [
				{ row: 1, col: 1, text: "<B&>", color: "red", bright: true },
				{ row: 2, col: 8, text: "WRAPS" },
				{ row: 3, col: 6, text: "PASS", hidden: true, input: true },
			],
			cursor: { row: 3, col: 1 },
		}, "CAPTION THAT IS LONGER THAN THE SCREEN");
		expect(html).toContain("&lt;B&amp;&gt;");
		expect(html).not.toContain("<B&>");
		expect(html).toContain('       <span class="c-blue">WRA</span>\n');
		// The rest of WRAPS starts row 3, under the cursor.
		expect(html).toContain('\n<span class="c-blue cursor">P</span><span class="c-blue">S</span>');
		expect(html).not.toContain("PASS");
		expect(html).toContain("CAPTION TH<");
	});
});

describe("readJSON", () => {
	const post = (body: string, headers: Record<string, string> = {}) =>
		new Request("https://h/v1/x", { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });
	const status = (p: Promise<unknown>) => p.then(() => 200, (e: HttpError) => e.status);

	it("refuses a body that says it is too big before reading it", async () => {
		expect(await status(readJSON(post("{}", { "Content-Length": String(2 << 20) }), []))).toBe(413);
	});

	it("refuses a body that is too big", async () => {
		expect(await status(readJSON(post(`{"a":"${"x".repeat(1 << 20)}"}`), ["a"]))).toBe(413);
	});

	it("refuses other content types, non-objects and unknown keys", async () => {
		expect(await status(readJSON(post("{}", { "Content-Type": "text/plain" }), []))).toBe(415);
		expect(await status(readJSON(post("[1]"), []))).toBe(400);
		expect(await status(readJSON(post("nope"), []))).toBe(400);
		expect(await status(readJSON(post('{"b":1}'), ["a"]))).toBe(400);
		expect(await readJSON(post('{"a":1}'), ["a"])).toEqual({ a: 1 });
	});
});
