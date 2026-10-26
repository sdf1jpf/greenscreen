// A 3270 presentation space: a port of internal/tn3270/screen.go and
// keyboard.go, so the browser edits fields exactly as the Go client does.
// Each field starts with an attribute byte that occupies a screen position
// and controls protection, intensity, color and data type.

export const MIN_ROWS = 24;
export const MIN_COLS = 80;

// Locks shown in the operator information area.
export const Lock = {
	NONE: "",
	WAIT: "X ()", // host is processing an AID
	PROTECTED: "X -f", // typed into a protected position
	NUMERIC: "X NUM", // non-numeric key in a numeric field
	OVERFLOW: "X >", // insert with no room left in the field
};

const isDigit = (ch) => ch >= "0" && ch <= "9";

export class Screen {
	constructor(rows = MIN_ROWS, cols = MIN_COLS) {
		this.rows = rows;
		this.cols = cols;
		// A cell is {ch} (ch "" is a null) or {attr} for an attribute byte.
		this.buf = Array.from({ length: rows * cols }, () => ({ ch: "" }));
		this.cursor = 0;
	}

	addr(row, col) {
		return this.wrap((row - 1) * this.cols + (col - 1));
	}

	wrap(a) {
		const n = this.buf.length;
		return ((a % n) + n) % n;
	}

	rowCol(addr) {
		return [Math.floor(addr / this.cols) + 1, (addr % this.cols) + 1];
	}

	setAttr(addr, attr) {
		this.buf[this.wrap(addr)] = { attr };
	}

	// text places a protected field whose data begins at row/col; the
	// attribute byte sits in the position before it, as with a BMS map.
	text(row, col, text, attr = {}) {
		const start = this.addr(row, col);
		this.setAttr(start - 1, { protected: true, ...attr });
		const chars = [...text];
		chars.forEach((ch, i) => (this.buf[this.wrap(start + i)] = { ch }));
		this.stopper(start + chars.length);
	}

	// input places a named, unprotected field of the given length.
	input(row, col, length, name, value = "", attr = {}) {
		const start = this.addr(row, col);
		this.setAttr(start - 1, { highlight: "underscore", modified: false, ...attr, protected: false, name });
		const v = [...value];
		for (let i = 0; i < length; i++) this.buf[this.wrap(start + i)] = { ch: v[i] ?? "" };
		this.stopper(start + length);
	}

	stopper(addr) {
		addr = this.wrap(addr);
		if (!this.buf[addr].attr) this.buf[addr] = { attr: { protected: true } };
	}

	setCursor(row, col) {
		this.cursor = this.addr(row, col);
	}

	cursorTo(name) {
		const i = this.buf.findIndex((c) => c.attr && c.attr.name === name);
		if (i < 0) return false;
		this.cursor = this.wrap(i + 1);
		return true;
	}

	cursorHome() {
		const a = this.nextUnprotected(this.buf.length - 1);
		if (a !== undefined) this.cursor = a;
	}

	// fieldAttr returns the address of the attribute byte governing addr,
	// or -1 on an unformatted screen.
	fieldAttr(addr) {
		for (let i = 0; i < this.buf.length; i++) {
			const a = this.wrap(addr - i);
			if (this.buf[a].attr) return a;
		}
		return -1;
	}

	attrAt(addr) {
		const fa = this.fieldAttr(addr);
		return fa < 0 ? { protected: false } : this.buf[fa].attr;
	}

	fieldBounds(fa) {
		const start = this.wrap(fa + 1);
		for (let i = 0; i < this.buf.length - 1; i++) {
			if (this.buf[this.wrap(start + i)].attr) return [start, i];
		}
		return [start, this.buf.length - 1];
	}

	nextUnprotected(addr) {
		for (let i = 1; i <= this.buf.length; i++) {
			const a = this.wrap(addr + i);
			const c = this.buf[a];
			if (c.attr && !c.attr.protected && this.fieldBounds(a)[1] > 0) return this.wrap(a + 1);
		}
		return undefined;
	}

	prevUnprotected(addr) {
		for (let i = 1; i <= this.buf.length; i++) {
			const a = this.wrap(addr - i);
			const c = this.buf[a];
			if (c.attr && !c.attr.protected && this.wrap(a + 1) !== addr && this.fieldBounds(a)[1] > 0) {
				return this.wrap(a + 1);
			}
		}
		return undefined;
	}

	// Editing. Each returns the resulting lock.

	type(ch, insert) {
		const c = this.buf[this.cursor];
		if (c.attr) return Lock.PROTECTED;
		const fa = this.fieldAttr(this.cursor);
		const a = fa < 0 ? null : this.buf[fa].attr;
		if (a && a.protected) return Lock.PROTECTED;
		if (a && a.numeric && !(isDigit(ch) || ch === "-" || ch === ".")) return Lock.NUMERIC;
		if (insert && a) {
			const [start, n] = this.fieldBounds(fa);
			const last = this.wrap(start + n - 1);
			const tail = this.buf[last].ch;
			if (tail !== "" && tail !== " ") return Lock.OVERFLOW;
			for (let p = last; p !== this.cursor; p = this.wrap(p - 1)) {
				this.buf[p].ch = this.buf[this.wrap(p - 1)].ch;
			}
		}
		c.ch = a && a.mixed ? ch : ch.toUpperCase();
		if (a) a.modified = true;
		this.advanceAfterType();
		return Lock.NONE;
	}

	advanceAfterType() {
		const next = this.wrap(this.cursor + 1);
		if (this.buf[next].attr) {
			const a = this.nextUnprotected(this.cursor);
			if (a !== undefined) {
				this.cursor = a;
				return;
			}
		}
		this.cursor = next;
	}

	editable() {
		if (this.buf[this.cursor].attr) return -1;
		const fa = this.fieldAttr(this.cursor);
		if (fa >= 0 && this.buf[fa].attr.protected) return -1;
		return fa;
	}

	backspace() {
		const fa = this.editable();
		if (fa < 0) return Lock.PROTECTED;
		if (this.cursor === this.fieldBounds(fa)[0]) return Lock.NONE;
		this.cursor = this.wrap(this.cursor - 1);
		return this.delete();
	}

	delete() {
		const fa = this.editable();
		if (fa < 0) return Lock.PROTECTED;
		const [start, n] = this.fieldBounds(fa);
		const last = this.wrap(start + n - 1);
		for (let p = this.cursor; p !== last; p = this.wrap(p + 1)) {
			this.buf[p].ch = this.buf[this.wrap(p + 1)].ch;
		}
		this.buf[last].ch = "";
		this.buf[fa].attr.modified = true;
		return Lock.NONE;
	}

	eraseEOF() {
		const fa = this.editable();
		if (fa < 0) return Lock.PROTECTED;
		const [start, n] = this.fieldBounds(fa);
		const end = this.wrap(start + n);
		for (let p = this.cursor; p !== end; p = this.wrap(p + 1)) this.buf[p].ch = "";
		this.buf[fa].attr.modified = true;
		return Lock.NONE;
	}

	eraseInput() {
		this.buf.forEach((c, i) => {
			if (!c.attr || c.attr.protected) return;
			const [start, n] = this.fieldBounds(i);
			for (let j = 0; j < n; j++) this.buf[this.wrap(start + j)].ch = "";
			c.attr.modified = true;
		});
		this.cursorHome();
	}

	tab() {
		const a = this.nextUnprotected(this.cursor);
		if (a !== undefined) this.cursor = a;
	}

	backTab() {
		const fa = this.fieldAttr(this.cursor);
		if (fa >= 0 && !this.buf[fa].attr.protected && !this.buf[this.cursor].attr && this.wrap(fa + 1) !== this.cursor) {
			this.cursor = this.wrap(fa + 1);
			return;
		}
		const a = this.prevUnprotected(this.cursor);
		if (a !== undefined) this.cursor = a;
	}

	newLine() {
		const [row] = this.rowCol(this.cursor);
		const a = this.nextUnprotected(this.addr(row + 1, 1) - 1);
		if (a !== undefined) this.cursor = a;
	}

	endOfField() {
		const fa = this.fieldAttr(this.cursor);
		if (fa < 0 || this.buf[fa].attr.protected) return;
		const [start, n] = this.fieldBounds(fa);
		let pos = start;
		for (let i = 0; i < n; i++) {
			const ch = this.buf[this.wrap(start + i)].ch;
			if (ch !== "" && ch !== " ") pos = this.wrap(start + i + 1);
		}
		if (pos === this.wrap(start + n)) pos = this.wrap(start + n - 1);
		this.cursor = pos;
	}

	move(drow, dcol) {
		this.cursor = this.wrap(this.cursor + drow * this.cols + dcol);
	}

	moveTo(addr) {
		this.cursor = this.wrap(addr);
	}

	// Reading the screen back, as a Read Modified would.

	fieldText(fa) {
		const [start, n] = this.fieldBounds(fa);
		let s = "";
		for (let i = 0; i < n; i++) s += this.buf[this.wrap(start + i)].ch;
		return s.replace(/ +$/, "");
	}

	// modifiedFields returns {name: value} for every named input field with
	// its modified data tag set.
	modifiedFields() {
		const out = {};
		this.buf.forEach((c, i) => {
			if (c.attr && !c.attr.protected && c.attr.name && c.attr.modified) out[c.attr.name] = this.fieldText(i);
		});
		return out;
	}

	fieldName(addr) {
		const fa = this.fieldAttr(addr);
		return fa < 0 ? "" : this.buf[fa].attr.name ?? "";
	}

	// carry copies the operator's input from old into this screen: the
	// modified named fields, cut to fit, and the cursor if it was in one.
	// Used when a resize lays the panel out again.
	carry(old) {
		const fields = {};
		this.buf.forEach((c, i) => {
			if (c.attr && !c.attr.protected && c.attr.name) fields[c.attr.name] = i;
		});
		old.buf.forEach((c, i) => {
			if (!c.attr || !c.attr.modified || !c.attr.name || !(c.attr.name in fields)) return;
			const fa = fields[c.attr.name];
			const [from, n] = old.fieldBounds(i);
			const [to, m] = this.fieldBounds(fa);
			for (let j = 0; j < m; j++) this.buf[this.wrap(to + j)].ch = j < n ? old.buf[old.wrap(from + j)].ch : "";
			this.buf[fa].attr.modified = true;
		});
		const ofa = old.fieldAttr(old.cursor);
		const name = ofa < 0 ? "" : old.buf[ofa].attr.name;
		if (name && !old.buf[old.cursor].attr && name in fields) {
			const off = old.wrap(old.cursor - ofa - 1);
			const [to, m] = this.fieldBounds(fields[name]);
			this.cursor = this.wrap(to + Math.min(off, Math.max(m - 1, 0)));
		}
	}

	// rowText returns a 1-based row as plain text, attribute positions and
	// nulls as blanks and hidden fields left out (for copy and print).
	rowText(row) {
		let s = "";
		const start = this.addr(row, 1);
		for (let i = 0; i < this.cols; i++) {
			const c = this.buf[start + i];
			s += c.attr || c.ch === "" || this.attrAt(start + i).hidden ? " " : c.ch;
		}
		return s;
	}
}
