// The screen protocol (v1) between the Worker and its 3270 clients; see
// docs/protocol.md.

import { Screen } from "./screen.js";

// encodeRequest builds the POST /v1/screen body for an AID key.
/** @param {{aid: string, scr: Screen, state?: string | null, terminal?: string, system?: string, live?: boolean}} req */
export function encodeRequest({ aid, scr, state, terminal, system, live }) {
	const fields = {};
	scr.buf.forEach((c, i) => {
		if (c.attr && !c.attr.protected && c.attr.name) fields[c.attr.name] = scr.fieldText(i);
	});
	const [row, col] = scr.rowCol(scr.cursor);
	/** @type {Record<string, unknown>} */
	const body = {
		v: 1,
		aid,
		fields,
		modified: Object.keys(scr.modifiedFields()),
		cursor: { row, col, field: scr.fieldName(scr.cursor) },
		rows: scr.rows,
		cols: scr.cols,
		terminal,
		system,
		tz_offset: -new Date().getTimezoneOffset(),
	};
	if (aid !== "START" && state != null) body.state = state;
	if (live) body.live = true; // listening on GET /v1/live
	return body;
}

// decodeScreen turns a response into {state, scr, map, refresh, live, download}
// or {logoff}. refresh is how often, in seconds, to redraw the screen while
// the operator leaves it alone; 0 never. live names what GET /v1/live
// announces changes to, such as "syslog", or is "". download, if the host
// sent a file along, is {url, name}: an API path to fetch and the name to
// save it as. Anything but an API path on this host is ignored.
export function decodeScreen(res) {
	if (res.v !== 1) throw new Error(`unsupported screen protocol version ${res.v}`);
	if (res.logoff) return { logoff: res.logoff.message ?? "" };
	const m = res.screen;
	const scr = new Screen(m.rows, m.cols);
	for (const f of m.fields ?? []) {
		const attr = {
			color: f.color && f.color !== "default" ? f.color : "",
			intense: !!f.bright,
			hidden: !!f.hidden,
			numeric: !!f.numeric,
			mixed: !!f.mixed,
		};
		if (f.highlight) attr.highlight = f.highlight;
		if (f.name !== undefined) {
			// A field can come with its modified tag set, to be sent back as
			// if typed: input kept across help, or a picked value.
			if (f.modified) attr.modified = true;
			scr.input(f.row, f.col, f.length ?? 0, f.name, f.value ?? "", attr);
		} else {
			scr.text(f.row, f.col, f.text ?? "", attr);
		}
	}
	const c = m.cursor;
	if (c && c.field) {
		if (!scr.cursorTo(c.field)) scr.cursorHome();
	} else if (c && c.row) {
		scr.setCursor(c.row, c.col);
	} else {
		scr.cursorHome();
	}
	const d = res.download;
	const download = d && typeof d.url === "string" && /^\/v1\/[^/]/.test(d.url) && typeof d.name === "string"
		? { url: d.url, name: d.name.replace(/[^\w.-]/g, "_") } : null;
	return { state: res.state, scr, map: m.map ?? "", refresh: m.refresh > 0 ? m.refresh : 0, live: m.live ?? "", download };
}

// encodeSnapshot builds the POST /v1/snapshot body: the screen as the
// operator sees it, typed input included, one field per attribute byte.
/** @param {{scr: Screen, format?: string, map?: string, terminal?: string}} req */
export function encodeSnapshot({ scr, format = "png", map = "", terminal = "" }) {
	const fields = [];
	scr.buf.forEach((c, fa) => {
		if (!c.attr) return;
		const a = c.attr;
		const [start, n] = scr.fieldBounds(fa);
		const text = Array.from({ length: n }, (_, i) => scr.buf[scr.wrap(start + i)].ch || " ").join("");
		if (!a.protected ? n === 0 : !text.trim()) return;
		const [row, col] = scr.rowCol(start);
		const f = { row, col, text };
		if (a.color) f.color = a.color;
		if (a.intense) f.bright = true;
		if (a.highlight && a.highlight !== "none") f.highlight = a.highlight;
		if (a.hidden) f.hidden = true;
		if (!a.protected) f.input = true;
		fields.push(f);
	});
	const [row, col] = scr.rowCol(scr.cursor);
	return { format, map, terminal, screen: { rows: scr.rows, cols: scr.cols, fields, cursor: { row, col } } };
}
