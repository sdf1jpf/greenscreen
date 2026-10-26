// Snapshots: a 3270 screen, or a page of printed output, drawn as HTML and
// turned into a PNG or PDF by Browser Rendering (a Browser Run binding's
// quick actions). The terminal sends the screen as it shows it, typed
// input included, in the field format of docs/protocol.md, so a snapshot
// is a copy of the glass, like a 3270 local copy to a printer that happens
// to make pictures. createApp serves POST /v1/snapshot with these when
// given a browser.

import { HttpError } from "./http.js";
import { MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, type Color, type Highlight } from "./screen.js";

export type Format = "png" | "pdf";

export interface SnapField {
	row: number;
	col: number;
	text: string;
	color?: Color;
	bright?: boolean;
	highlight?: Highlight;
	hidden?: boolean;
	input?: boolean; // unprotected: the text is what is in the field, typed or not
}

export interface SnapScreen {
	rows: number;
	cols: number;
	fields: SnapField[];
	cursor?: { row: number; col: number };
}

const colors: readonly Color[] = ["default", "blue", "red", "pink", "green", "turquoise", "yellow", "white"];
const highlights: readonly Highlight[] = ["none", "underscore", "reverse", "blink"];

const bad = (msg: string, field?: string) => new HttpError(400, "invalid", msg, field);

export function format(v: unknown): Format {
	if (v === undefined || v === "" || v === "png") return "png";
	if (v === "pdf") return "pdf";
	throw bad('"format" must be "png" or "pdf"', "format");
}

const whole = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

// snapScreen checks a screen sent for a snapshot.
export function snapScreen(v: unknown): SnapScreen {
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad('"screen" must be an object', "screen");
	const s = v as Record<string, unknown>;
	if (!whole(s.rows, MIN_ROWS, MAX_ROWS)) throw bad(`"rows" must be ${MIN_ROWS} to ${MAX_ROWS}`, "rows");
	if (!whole(s.cols, MIN_COLS, MAX_COLS)) throw bad(`"cols" must be ${MIN_COLS} to ${MAX_COLS}`, "cols");
	const rows = s.rows as number, cols = s.cols as number;
	if (!Array.isArray(s.fields) || s.fields.length > rows * cols) throw bad('"fields" must be a list of fields', "fields");
	const fields = s.fields.map((f: unknown, i): SnapField => {
		const where = `field ${i + 1}`;
		if (typeof f !== "object" || f === null) throw bad(`${where} is not an object`, "fields");
		const g = f as Record<string, unknown>;
		if (!whole(g.row, 1, rows) || !whole(g.col, 1, cols)) throw bad(`${where} is off the screen`, "fields");
		if (typeof g.text !== "string" || g.text.length > rows * cols) throw bad(`${where} needs its text`, "fields");
		if (g.color === "") g.color = undefined;
		if (g.highlight === "") g.highlight = undefined;
		if (g.color !== undefined && !colors.includes(g.color as Color)) throw bad(`${where} has an unknown color`, "fields");
		if (g.highlight !== undefined && !highlights.includes(g.highlight as Highlight)) {
			throw bad(`${where} has an unknown highlight`, "fields");
		}
		return {
			row: g.row as number, col: g.col as number, text: g.text,
			color: g.color as Color | undefined, highlight: g.highlight as Highlight | undefined,
			bright: g.bright === true, hidden: g.hidden === true, input: g.input === true,
		};
	});
	const c = s.cursor as Record<string, unknown> | undefined;
	const cursor = c && whole(c.row, 1, rows) && whole(c.col, 1, cols) ? { row: c.row as number, col: c.col as number } : undefined;
	return { rows, cols, fields, cursor };
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[ch]};`);

// IBM Plex Mono is the font the browser terminal uses; its glyphs are
// 0.6em wide, which the page sizes below count on.
const FONT = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=block";
const PX = 18; // font size
const CH = PX * 0.6; // one column
const LINE = Math.round(PX * 1.25); // one row
const PAD = 16;

interface Cell {
	ch: string;
	f?: SnapField; // the field the position belongs to; none for attribute positions
}

// screenHtml lays the screen out cell by cell, as the terminal does: each
// field's data starts at its row and column and runs on until it ends,
// wrapping at the end of a line. caption goes in the status line.
export function screenHtml(s: SnapScreen, caption: string): { html: string; width: number; height: number } {
	const cells: Cell[] = Array.from({ length: s.rows * s.cols }, () => ({ ch: " " }));
	for (const f of s.fields) {
		const start = (f.row - 1) * s.cols + (f.col - 1);
		[...f.text].forEach((ch, i) => {
			const a = (start + i) % cells.length;
			cells[a] = { ch: f.hidden || ch < " " ? " " : ch, f };
		});
	}
	const cursor = s.cursor ? (s.cursor.row - 1) * s.cols + (s.cursor.col - 1) : -1;
	const lines: string[] = [];
	for (let r = 0; r < s.rows; r++) {
		let out = "";
		let run = "", cls = "";
		const flush = () => {
			if (run) out += cls ? `<span class="${cls}">${esc(run)}</span>` : esc(run);
			run = "";
		};
		for (let c = 0; c < s.cols; c++) {
			const a = r * s.cols + c;
			const { ch, f } = cells[a];
			let k = classes(f);
			if (a === cursor) k = `${k} cursor`.trim();
			if (k !== cls) {
				flush();
				cls = k;
			}
			run += ch;
		}
		flush();
		lines.push(out);
	}
	const width = Math.ceil(s.cols * CH + 2 * PAD);
	const height = (s.rows + 1) * LINE + 2 * PAD + 6;
	const html = page(width, height, `
#tube { padding: ${PAD}px; width: ${width}px; height: ${height}px; box-sizing: border-box; background: #000; }
pre span { color: var(--fg); text-shadow: 0 0 2px var(--fg); }
.bright { font-weight: 700; }
.ul { text-decoration: underline; text-underline-offset: 0.18em; }
.rev { background: var(--fg); color: #000 !important; text-shadow: none !important; }
.cursor { background: var(--fg, var(--green)); color: #000 !important; text-shadow: none !important; }
#oia { border-top: 1px solid var(--blue); margin-top: 4px; color: var(--blue); }`,
	`<div id="tube"><pre>${lines.join("\n")}</pre><pre id="oia"><span class="c-blue">${esc(caption.slice(0, s.cols))}</span></pre></div>`);
	return { html, width, height };
}

function classes(f: SnapField | undefined): string {
	if (!f) return "";
	// The 3270 base colors, when the field has no color of its own.
	const color = f.color && f.color !== "default" ? f.color
		: f.input ? (f.bright ? "red" : "green") : f.bright ? "white" : "blue";
	const k = [`c-${color}`];
	if (f.bright) k.push("bright");
	if (f.highlight === "underscore") k.push("ul");
	if (f.highlight === "reverse") k.push("rev");
	return k.join(" ");
}

const page = (width: number, height: number, css: string, body: string) => `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${FONT}">
<style>
:root {
	--blue: #5f8fff; --red: #ff4d4d; --pink: #ff75d8; --green: #3cff5a;
	--turquoise: #40e8e0; --yellow: #fff35a; --white: #f4f4f4;
}
@page { size: ${width}px ${height}px; margin: 0; }
html, body { margin: 0; padding: 0; background: #000; }
pre { margin: 0; font: ${PX}px/${LINE}px "IBM Plex Mono", "DejaVu Sans Mono", monospace; white-space: pre; font-variant-ligatures: none; }
.c-blue { --fg: var(--blue); } .c-red { --fg: var(--red); } .c-pink { --fg: var(--pink); }
.c-green { --fg: var(--green); } .c-turquoise { --fg: var(--turquoise); }
.c-yellow { --fg: var(--yellow); } .c-white { --fg: var(--white); }
${css}
</style></head><body>${body}</body></html>`;

// The green-bar page: 132 print positions by 66 lines, bands of three
// lines, with the tractor-feed holes down both edges.
const LPX = 14;
const LCH = LPX * 0.6;
const LLINE = 18;
const MARGIN = 44;

// greenbarHtml draws one page of a listing, up to 66 lines of up to 132
// characters, on green-bar paper.
export function greenbarHtml(text: string[]): { html: string; width: number; height: number } {
	const width = Math.ceil(132 * LCH + 2 * MARGIN + 24);
	const height = 66 * LLINE + 2 * 24;
	const html = page(width, height, `
html, body { background: #fbfbf5; }
#paper {
	position: relative; width: ${width}px; height: ${height}px; box-sizing: border-box; padding: 24px ${MARGIN + 12}px;
	background: repeating-linear-gradient(to bottom, #fbfbf5 0, #fbfbf5 ${3 * LLINE}px, #d9efd6 ${3 * LLINE}px, #d9efd6 ${6 * LLINE}px);
	background-origin: content-box; background-clip: content-box;
}
#paper::before, #paper::after {
	content: ""; position: absolute; top: 0; bottom: 0; width: ${MARGIN}px; background-color: #fbfbf5;
	background-image: radial-gradient(circle at 50% 50%, #9a9a90 0, #9a9a90 5px, transparent 6px);
	background-size: ${MARGIN}px 36px;
}
#paper::before { left: 0; border-right: 1px dashed #c8c8bd; }
#paper::after { right: 0; border-left: 1px dashed #c8c8bd; }
pre { font: ${LPX}px/${LLINE}px "IBM Plex Mono", "DejaVu Sans Mono", monospace; color: #1d1d1d; }`,
	`<div id="paper"><pre>${esc(text.map((l) => l.replace(/[^\x20-\x7e]/g, " ")).join("\n"))}</pre></div>`);
	return { html, width, height };
}

// render has the browser draw the page and returns the picture.
export async function render(browser: BrowserRun | undefined, p: { html: string; width: number; height: number }, f: Format): Promise<ArrayBuffer> {
	if (!browser) throw new HttpError(503, "unavailable", "snapshots are not available: no browser binding");
	const common = {
		html: p.html,
		viewport: { width: p.width, height: p.height, deviceScaleFactor: f === "png" ? 2 : 1 },
		gotoOptions: { waitUntil: "networkidle0" as const, timeout: 20_000 },
		setJavaScriptEnabled: false,
		cacheTTL: 0,
	};
	let res: Response;
	try {
		res = f === "png"
			? await browser.quickAction("screenshot", { ...common, screenshotOptions: { type: "png", clip: { x: 0, y: 0, width: p.width, height: p.height } } })
			: await browser.quickAction("pdf", { ...common, pdfOptions: { printBackground: true, preferCSSPageSize: true } });
	} catch (e) {
		throw new HttpError(503, "unavailable", `the browser is not available: ${e instanceof Error ? e.message : e}`);
	}
	if (!res.ok) {
		const why = (await res.text().catch(() => "")).slice(0, 200);
		throw new HttpError(503, "unavailable", `the browser could not draw it: ${res.status} ${why}`.trim());
	}
	return res.arrayBuffer();
}

export function imageResponse(bytes: ArrayBuffer, f: Format, filename: string): Response {
	return new Response(bytes, {
		headers: {
			"Content-Type": f === "png" ? "image/png" : "application/pdf",
			"Content-Disposition": `inline; filename="${filename}"`,
			"Cache-Control": "no-store",
		},
	});
}
