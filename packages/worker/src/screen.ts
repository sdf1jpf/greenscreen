// The screen builder: a 3270 presentation space described as a list of
// fields, in the wire format of docs/protocol.md, plus the layout helpers
// panels share. The clients draw these with the same semantics as a BMS map.

export const MIN_ROWS = 24;
export const MIN_COLS = 80;

export type Color = "default" | "blue" | "red" | "pink" | "green" | "turquoise" | "yellow" | "white";
export type Highlight = "none" | "underscore" | "reverse" | "blink";

export interface Opts {
	color?: Color;
	bright?: boolean;
	highlight?: Highlight;
	hidden?: boolean;
	numeric?: boolean; // input only
	mixed?: boolean; // input only: keep lower case
}

export interface Field extends Opts {
	row: number;
	col: number;
	text?: string; // output field
	name?: string; // input field
	length?: number;
	value?: string;
	modified?: boolean; // input only: the modified data tag starts set
}

export type Cursor = { field: string } | { row: number; col: number };

// AppInfo names the application on its screens and on the clients' logon
// screen (GET /v1/screen/info).
export interface AppInfo {
	title: string; // the second heading line, e.g. "POINT OF SALE"
	prefix: string; // three letters that start the framework's message IDs, e.g. "POS"
	system: string; // the system name when the client sends none
	banner?: string[]; // lines for the clients' logon screen
}

// Ctx is what a panel knows about the request it is answering. E is the
// Worker's bindings.
export interface Ctx<E = unknown> {
	env: E;
	app: AppInfo;
	user: string; // the signed-on userid
	rows: number;
	cols: number;
	system: string;
	terminal: string;
	host: string; // the API's host, for display
	tzOffset: number; // minutes east of UTC
}

export class Screen {
	readonly fields: Field[] = [];
	cursor?: Cursor;
	refresh?: number; // seconds: the client redraws the screen this often while idle

	constructor(
		readonly map: string,
		readonly rows: number,
		readonly cols: number,
	) {}

	// text places a protected field whose data begins at row/col.
	text(row: number, col: number, text: string, opts: Opts = {}): void {
		this.fields.push({ row, col, text, ...clean(opts, "none") });
	}

	// input places a named, unprotected field of the given length.
	input(row: number, col: number, length: number, name: string, value = "", opts: Opts = {}): void {
		const f: Field = { row, col, name, length, ...clean(opts, "underscore") };
		if (value !== "") f.value = value.slice(0, length);
		this.fields.push(f);
	}

	cursorTo(field: string): void {
		this.cursor = { field };
	}

	setCursor(row: number, col: number): void {
		this.cursor = { row, col };
	}

	// fill puts values in the named input fields, marked modified as if they
	// had been typed, and the cursor in the cursor field if there is one.
	fill(values: Record<string, string>, cursor?: string): void {
		for (const f of this.fields) {
			if (f.name === undefined || !Object.hasOwn(values, f.name)) continue;
			const v = values[f.name].slice(0, f.length);
			if (v === "") delete f.value;
			else f.value = v;
			f.modified = true;
		}
		if (cursor && this.fields.some((f) => f.name === cursor)) this.cursorTo(cursor);
	}

	toJSON(): ScreenJSON {
		return { map: this.map, rows: this.rows, cols: this.cols, fields: this.fields, cursor: this.cursor, refresh: this.refresh };
	}
}

export interface ScreenJSON {
	map: string;
	rows: number;
	cols: number;
	fields: Field[];
	cursor?: Cursor;
	refresh?: number;
}

// textLines returns what the screen shows, row by row, without the message
// and PF key lines and with trailing blanks trimmed, for printing.
export function textLines(scr: Screen): string[] {
	const rows = Array.from({ length: scr.rows - 2 }, () => Array<string>(scr.cols).fill(" "));
	for (const f of scr.fields) {
		if (f.row > scr.rows - 2 || f.hidden) continue;
		const s = f.text ?? (f.value ?? "");
		for (let i = 0; i < s.length && f.col - 1 + i < scr.cols; i++) rows[f.row - 1][f.col - 1 + i] = s[i];
	}
	const out = rows.map((r) => r.join("").trimEnd());
	while (out.length > 0 && out.at(-1) === "") out.pop();
	return out;
}

// clean drops attributes at their default so the wire stays small.
function clean(o: Opts, highlight: Highlight): Opts {
	const out: Opts = {};
	if (o.color && o.color !== "default") out.color = o.color;
	if (o.highlight && o.highlight !== highlight) out.highlight = o.highlight;
	if (o.bright) out.bright = true;
	if (o.hidden) out.hidden = true;
	if (o.numeric) out.numeric = true;
	if (o.mixed) out.mixed = true;
	return out;
}

// newScreen returns a blank screen the size of the terminal. Panels are
// laid out for 24x80 and spread into any extra room: the message and PF
// key lines stay on the last two rows, the right-hand heading fields stay
// at the right edge, and lists show as many rows as fit.
export function newScreen(ctx: Ctx, map: string): Screen {
	return new Screen(map, ctx.rows, ctx.cols);
}

export function center(scr: Screen, text: string): number {
	return Math.floor((scr.cols - text.length) / 2) + 1;
}

// right returns the column that is col on a 24x80 screen, measured from
// the right edge, so that right-hand fields follow the edge of a wider one.
export function right(scr: Screen, col: number): number {
	return col + scr.cols - MIN_COLS;
}

// header draws the standard two-line panel heading.
export function header(scr: Screen, ctx: Ctx, title: string): void {
	scr.text(1, 2, scr.map, { color: "blue" });
	scr.text(1, center(scr, title), title, { color: "white", bright: true });
	scr.text(1, right(scr, 70), date(ctx), { color: "blue" });
	scr.text(2, 2, `${ctx.system} ${ctx.app.title}`, { color: "blue" });
	scr.text(2, right(scr, 70), time(ctx), { color: "blue" });
}

// message draws the message line, the second to last row. The severity is
// taken from the last letter of the message ID, IBM style: E=error,
// W=warning, I=info.
export function message(scr: Screen, msg: string): void {
	if (!msg) return;
	const id = msg.split(" ")[0];
	const color: Color = id.endsWith("E") ? "red" : id.endsWith("W") ? "yellow" : "white";
	scr.text(scr.rows - 1, 2, msg.slice(0, scr.cols - 2), { color, bright: true });
}

// keys draws the PF key legend on the last row.
export function keys(scr: Screen, legend: string): void {
	scr.text(scr.rows, 2, legend, { color: "turquoise" });
}

export function label(scr: Screen, row: number, col: number, text: string): void {
	scr.text(row, col, text, { color: "turquoise" });
}

export function value(scr: Screen, row: number, col: number, text: string): void {
	scr.text(row, col, text, { color: "green" });
}

// msgId builds a message ID from the application's prefix: msg(ctx, "0101W")
// is "POS0101W" in an app whose prefix is POS.
export function msgId(ctx: Ctx, id: string): string {
	return ctx.app.prefix + id;
}

export function invalidKey(ctx: Ctx, aid: string): string {
	return `${msgId(ctx, "0000W")} ${aid} IS NOT ACTIVE ON THIS SCREEN`;
}

// dots pads a label with ISPF-style leader dots ("NAME . . . . ."). Dots
// fall on alternate columns so that labels of any length line up.
export function dots(s: string, width: number): string {
	let out = s;
	for (let i = s.length; i < width; i++) {
		out += i % 2 === 1 && i > s.length && i < width - 1 ? "." : " ";
	}
	return out.slice(0, width);
}

// money formats whole dollars with thousands separators: $12,450, -$900.
export function money(n: number): string {
	const s = String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return (n < 0 ? "-$" : "$") + s;
}

// pad and lpad fit text to a width, cutting it if it is too long.
export function pad(s: string, n: number): string {
	return s.slice(0, n).padEnd(n);
}

export function lpad(s: string | number, n: number): string {
	return String(s).padStart(n);
}

// Times are shown in the terminal's local time.

function local(ctx: Ctx, at: Date = new Date()): Date {
	return new Date(at.getTime() + ctx.tzOffset * 60_000);
}

const two = (n: number) => String(n).padStart(2, "0");

export function date(ctx: Ctx): string {
	const d = local(ctx);
	return `${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}/${two(d.getUTCFullYear() % 100)}`;
}

export function time(ctx: Ctx): string {
	const d = local(ctx);
	return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

// clock formats an RFC 3339 time as "01/02 15:04:05" local time.
export function clock(ctx: Ctx, iso: string): string {
	const at = new Date(iso);
	if (isNaN(at.getTime())) return "";
	const d = local(ctx, at);
	return `${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

// stamp formats an RFC 3339 time as "2006-01-02 15:04" local time.
export function stamp(ctx: Ctx, iso: string): string {
	const at = new Date(iso);
	if (isNaN(at.getTime())) return "";
	const d = local(ctx, at);
	return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}
