// The screen protocol (v1) between the Worker and its 3270 clients; see
// docs/protocol.md.

import { Screen } from "./screen.js";

// encodeRequest builds the POST /v1/screen body for an AID key.
/** @param {{aid: string, scr: Screen, state?: string | null, terminal?: string, system?: string}} req */
export function encodeRequest({ aid, scr, state, terminal, system }) {
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
	return body;
}

// decodeScreen turns a response into {state, scr, refresh} or {logoff}.
// refresh is how often, in seconds, to redraw the screen while the
// operator leaves it alone; 0 never.
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
	return { state: res.state, scr, refresh: m.refresh > 0 ? m.refresh : 0 };
}
