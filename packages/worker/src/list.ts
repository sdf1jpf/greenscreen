// Scrolled lists, ISPF style: a panel shows a page of a longer list and
// PF7 and PF8 move up and down it a page at a time. The panel's state keeps
// where the page starts and how long the list was when drawn:
//
//	interface BrowseState extends PanelState, Scrolled { ... }
//	render: for (const x of page(s, items, rows)) ...; scr.text(3, right(scr, 60), position(s, rows))
//	handle: const moved = scroll(ctx, s, inp.aid, rows); if (moved !== undefined) { s.msg = moved; return s; }

import { msgId, type Ctx } from "./screen.js";

export interface Scrolled {
	top?: number; // the first item shown
	end?: number; // how many items the list had when it was drawn
}

// page returns the items to show, rows of them from s.top, moving s.top
// back if the list has got shorter, and notes the list's length.
export function page<T>(s: Scrolled, items: readonly T[], rows: number): T[] {
	const top = Math.max(Math.min(s.top ?? 0, items.length - rows), 0);
	s.top = top;
	s.end = items.length;
	return items.slice(top, top + rows);
}

// scroll handles PF7 and PF8 for a list showing rows items at a time. It
// returns the message to show: "" when the list moved, a warning when it
// was already at the top or bottom. For any other key it returns undefined.
export function scroll(ctx: Ctx, s: Scrolled, aid: string, rows: number): string | undefined {
	const top = s.top ?? 0;
	if (aid === "PF7") {
		if (top === 0) return `${msgId(ctx, "0101W")} ALREADY AT TOP OF DATA`;
		s.top = Math.max(top - rows, 0);
		return "";
	}
	if (aid === "PF8") {
		if (top + rows >= (s.end ?? 0)) return `${msgId(ctx, "0102W")} ALREADY AT BOTTOM OF DATA`;
		s.top = top + rows;
		return "";
	}
	return undefined;
}

// position says which rows show, "ROW 17 TO 32 OF 40", or "" when the
// whole list fits.
export function position(s: Scrolled, rows: number): string {
	const end = s.end ?? 0;
	if (end <= rows) return "";
	const top = s.top ?? 0;
	return `ROW ${top + 1} TO ${Math.min(top + rows, end)} OF ${end}`;
}
