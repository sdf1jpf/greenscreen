// The browser 3278: draws the screens the Worker sends from POST /v1/screen
// and edits them locally until an AID key (Enter, Clear, PA or PF) sends the
// modified fields back, the way a 3270 talks to CICS.

import { Lock, MIN_COLS, MIN_ROWS, Screen } from "./screen.js";
import { decodeScreen, encodeRequest } from "./protocol.js";

const LU_NAME = (new URLSearchParams(location.search).get("lu") ?? "WEBTERM1").toUpperCase().slice(0, 8);
const IDLE_MS = 30 * 60 * 1000; // log off after this long without a key, as TSO does
const BASE_FONT_PX = 16;
const MIN_FONT_PX = 6;

const palette = ["blue", "red", "pink", "green", "turquoise", "yellow", "white"];

const el = {
	tube: document.getElementById("tube"),
	screen: document.getElementById("screen"),
	oia: document.getElementById("oia"),
	keys: document.getElementById("keys"),
	probe: document.getElementById("probe"),
};

const state = {
	scr: new Screen(),
	lock: Lock.NONE,
	insert: false,
	system: "SYS1", // the application's system name, from /v1/screen/info
	commarea: null, // the host's opaque state, handed back with every AID
	lastAid: null, // for HOST NOT RESPONDING retries
	pendingResize: false,
	timer: null, // the refresh timer, for screens that show live data
	active: Date.now(), // when the operator last pressed a key or clicked
};

// --- Host conversation ---------------------------------------------------

async function send(aid) {
	if (state.lock === Lock.WAIT) return;
	clearTimeout(state.timer);
	state.lock = Lock.WAIT;
	state.lastAid = aid;
	render();
	const before = state.scr;
	try {
		const body = encodeRequest({ aid, scr: before, state: state.commarea, terminal: LU_NAME, system: state.system });
		const res = await fetch("/v1/screen", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "same-origin",
			redirect: "manual",
			body: JSON.stringify(body),
		});
		// Cloudflare Access answers an expired session with a redirect to its
		// sign-in page, which a fetch cannot follow. Reload to sign in again.
		if (res.type === "opaqueredirect" || res.status === 401) {
			hostMessage("SESSION EXPIRED - PRESS ENTER TO SIGN ON AGAIN", () => location.reload());
			return;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const next = decodeScreen(await res.json());
		if (next.logoff !== undefined) {
			loggedOff(next.logoff);
			return;
		}
		state.commarea = next.state;
		state.scr = next.scr;
		if (aid === "REDRAW") state.scr.carry(before);
		state.lock = Lock.NONE;
		schedule(next.refresh);
			} catch (e) {
		console.error(e);
		hostMessage("HOST NOT RESPONDING - PRESS ENTER TO RETRY", () => send(state.lastAid));
		return;
	}
	render();
	if (state.pendingResize) fit();
}

// schedule redraws a screen that asks for it every so many seconds. While
// the operator is busy (a field typed in, or a message showing) it waits
// another interval rather than send what they have half typed.
function schedule(seconds) {
	clearTimeout(state.timer);
	if (!seconds) return;
	state.timer = setTimeout(() => {
		const busy = state.lock !== Lock.NONE || state.message || Object.keys(state.scr.modifiedFields()).length > 0;
		if (busy) schedule(seconds);
		else send("REDRAW");
	}, seconds * 1000);
}

// idleCheck logs the session off once the operator has left it alone for
// IDLE_MS. Nothing is sent while there is no session or the host is busy.
function idleCheck() {
	if (Date.now() - state.active < IDLE_MS) return;
	if (!state.commarea || state.lock !== Lock.NONE || state.retry) return;
	state.active = Date.now();
	clearTimeout(state.timer);
	send("TIMEOUT");
}

// tickClock redraws the status line's clock on the minute.
function tickClock() {
	render();
	setTimeout(tickClock, 60_000 - (Date.now() % 60_000));
}

const two = (n) => String(n).padStart(2, "0");

// loggedOff shows the host's farewell; Enter starts a new conversation.
function loggedOff(message) {
	state.scr = new Screen(state.scr.rows, state.scr.cols);
	state.scr.text(2, 2, message || "LOGGED OFF", { color: "white" });
	state.scr.text(4, 2, "PRESS ENTER TO LOG ON AGAIN", { color: "turquoise" });
	state.commarea = null;
	hostMessage("", () => send("START"));
}

// hostMessage keeps the operator's screen and input and shows a message in
// the OIA; Enter (or Reset, then Enter) runs retry.
function hostMessage(text, retry) {
	state.lock = Lock.NONE;
	state.message = text;
	state.retry = retry;
	render();
}

// --- Sizing --------------------------------------------------------------

// The presentation space fills the window, never smaller than a Model 2
// (24x80). When even that does not fit, the font shrinks instead.
function fit() {
	if (state.lock === Lock.WAIT) {
		state.pendingResize = true;
		return;
	}
	state.pendingResize = false;
	const keysH = el.keys.offsetHeight;
	const W = window.innerWidth - 16;
	const H = window.innerHeight - keysH - 16;

	let px = BASE_FONT_PX;
	let [cw, ch] = cellSize(px);
	const fits = (cw, ch) => MIN_COLS * cw <= W && (MIN_ROWS + 2) * ch <= H;
	while (px > MIN_FONT_PX && !fits(cw, ch)) {
		px -= 0.5;
		[cw, ch] = cellSize(px);
	}
	document.documentElement.style.setProperty("--font-px", `${px}px`);
	const cols = Math.max(MIN_COLS, Math.floor(W / cw));
	const rows = Math.max(MIN_ROWS, Math.floor(H / ch) - 2);
	if (rows === state.scr.rows && cols === state.scr.cols) {
		render();
		return;
	}
	if (!state.started) {
		// Before the first screen arrives there is nothing to lay out again.
		state.scr = new Screen(rows, cols);
		render();
		return;
	}
	state.scr = resized(state.scr, rows, cols);
	render();
	send("REDRAW");
}

function cellSize(px) {
	el.probe.style.fontSize = `${px}px`;
	const r = el.probe.getBoundingClientRect();
	return [r.width / 10, r.height];
}

// resized gives an interim screen of the new size, so nothing is drawn out
// of bounds while the host lays the panel out again.
function resized(old, rows, cols) {
	const s = new Screen(rows, cols);
	for (let r = 0; r < Math.min(rows, old.rows); r++) {
		for (let c = 0; c < Math.min(cols, old.cols); c++) {
			s.buf[r * cols + c] = old.buf[r * old.cols + c];
		}
	}
	const [cr, cc] = old.rowCol(old.cursor);
	s.setCursor(Math.min(cr, rows), Math.min(cc, cols));
	return s;
}

// --- Drawing -------------------------------------------------------------

// cellClass resolves a field's look, applying the 3270 base-color rules when
// no extended color is set.
function cellClass(a) {
	let color = a.color && palette.includes(a.color) ? a.color : "";
	if (!color) {
		if (a.protected && a.intense) color = "white";
		else if (a.protected) color = "blue";
		else if (a.intense) color = "red";
		else color = "green";
	}
	let cls = `c-${color}`;
	if (a.intense) cls += " bright";
	if (a.highlight === "underscore") cls += " ul";
	if (a.highlight === "reverse") cls += " rev";
	if (a.highlight === "blink") cls += " blink";
	return cls;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render() {
	const s = state.scr;
	let html = "";
	let attr = s.attrAt(s.buf.length - 1); // fields wrap from the last row
	if (s.fieldAttr(s.buf.length - 1) < 0) attr = { protected: false };
	for (let row = 0; row < s.rows; row++) {
		let run = "";
		let runCls = null;
		const flush = () => {
			if (run) html += `<span class="${runCls}">${esc(run)}</span>`;
			run = "";
		};
		for (let col = 0; col < s.cols; col++) {
			const i = row * s.cols + col;
			const c = s.buf[i];
			let ch = " ";
			let cls;
			if (c.attr) {
				attr = c.attr;
				cls = "c-green"; // an attribute byte shows as a blank
			} else {
				cls = cellClass(attr);
				if (c.ch !== "" && !attr.hidden) ch = c.ch;
			}
			if (i === s.cursor) {
				flush();
				html += `<span class="${cls} cursor${state.insert ? " ins" : ""}">${esc(ch)}</span>`;
				runCls = null;
				continue;
			}
			if (cls !== runCls) {
				flush();
				runCls = cls;
			}
			run += ch;
		}
		flush();
		html += "\n";
	}
	el.screen.innerHTML = html;
	el.oia.innerHTML = oia();
}

// oia draws the operator information area, keeping the right-hand indicators
// in their Model 2 places relative to the right edge as the Go client does.
function oia() {
	const s = state.scr;
	const cols = s.cols;
	const line = Array(cols).fill(" ");
	const put = (col, text) => [...text].forEach((ch, i) => col - 1 + i < cols && (line[col - 1 + i] = ch));
	const lock = state.message ? "X SYSTEM" : state.lock;
	put(9, lock);
	put(32, state.system);
	const now = new Date();
	put(42, `${two(now.getHours())}:${two(now.getMinutes())}`);
	if (state.insert) put(cols - 28, "^");
	put(cols - 23, LU_NAME);
	const [r, c] = s.rowCol(s.cursor);
	put(cols - 6, `${String(r).padStart(3, "0")}/${String(c).padStart(3, "0")}`);

	let msg = "";
	if (state.message) {
		// The message sits between the lock and the right-hand indicators.
		const room = cols - 30 - 20;
		msg = state.message.slice(0, Math.max(room, 0));
	}
	const left = line.slice(2, 8).join("");
	const warn = line.slice(8, 20).join("");
	let rest = line.slice(20).join("");
	if (msg) rest = msg + rest.slice(msg.length);
	return (
		`<span class="c-turquoise rev">4</span>` +
		`<span class="c-turquoise">A${esc(left)}</span>` +
		`<span class="c-white bright">${esc(warn)}</span>` +
		`<span class="c-turquoise">${esc(rest)}</span>`
	);
}

// --- Keyboard ------------------------------------------------------------

const pfKeys = {};
for (let n = 1; n <= 12; n++) {
	pfKeys[`F${n}`] = `PF${n}`;
	pfKeys[`Shift+F${n}`] = `PF${n + 12}`;
}
// Conveniences for keyboards without a full function-key row.
pfKeys.PageUp = "PF7";
pfKeys.PageDown = "PF8";

function keyName(e) {
	let k = e.key;
	if (k === " ") k = "Space";
	if (e.shiftKey && k.length > 1) k = `Shift+${k}`;
	if (e.altKey) k = `Alt+${e.code.replace(/^Digit/, "")}`;
	if (e.ctrlKey || e.metaKey) k = `Ctrl+${k.toLowerCase()}`;
	return k;
}

function aidKey(aid) {
	if (state.retry) {
		if (aid !== "ENTER") return; // only Enter retries or logs on again
		const retry = state.retry;
		state.retry = null;
		state.message = "";
		retry();
		return;
	}
	if (state.lock !== Lock.NONE) return;
	state.message = "";
	if (aid === "CLEAR") state.scr = new Screen(state.scr.rows, state.scr.cols);
	send(aid);
}

function reset() {
	if (state.lock === Lock.WAIT) return;
	state.lock = Lock.NONE;
	state.insert = false;
	render();
}

function onKey(e) {
	const k = keyName(e);
	if (!state.started) return;
	if (k === "Escape" || k === "Ctrl+r") {
		e.preventDefault();
		reset();
		return;
	}
	const aid =
		pfKeys[k] ??
		{ Enter: "ENTER", "Ctrl+l": "CLEAR", "Alt+1": "PA1", "Alt+2": "PA2", "Alt+3": "PA3" }[k];
	if (aid) {
		e.preventDefault();
		aidKey(aid);
		return;
	}
	if (state.lock === Lock.WAIT) {
		e.preventDefault();
		return;
	}
	const s = state.scr;
	const edits = {
		Tab: () => s.tab(),
		"Shift+Tab": () => s.backTab(),
		ArrowUp: () => s.move(-1, 0),
		ArrowDown: () => s.move(1, 0),
		ArrowLeft: () => s.move(0, -1),
		ArrowRight: () => s.move(0, 1),
		Home: () => s.cursorHome(),
		End: () => s.endOfField(),
		"Shift+Enter": () => s.newLine(),
		"Ctrl+n": () => s.newLine(),
		Insert: () => (state.insert = !state.insert),
		Backspace: () => (state.lock = s.backspace()),
		Delete: () => (state.lock = s.delete()),
		"Ctrl+e": () => (state.lock = s.eraseEOF()),
		"Ctrl+u": () => s.eraseInput(),
	};
	if (edits[k]) {
		e.preventDefault();
		if (state.lock === Lock.NONE || k === "Insert") edits[k]();
		render();
		return;
	}
	if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
		e.preventDefault();
		if (state.lock === Lock.NONE) state.lock = s.type(e.key, state.insert);
		render();
	}
}

function onPaste(e) {
	e.preventDefault();
	if (state.lock !== Lock.NONE) return;
	const text = e.clipboardData.getData("text/plain");
	for (const line of text.split(/\r?\n/).map((l, i) => (i ? "\n" : "") + l)) {
		if (line.startsWith("\n")) state.scr.newLine();
		for (const ch of line.replace(/^\n/, "")) {
			if ((state.lock = state.scr.type(ch, state.insert)) !== Lock.NONE) break;
		}
		if (state.lock !== Lock.NONE) break;
	}
	render();
}

// A click moves the cursor, as with a light pen or an emulator's mouse.
function onClick(e) {
	if (state.lock !== Lock.NONE) return;
	const r = el.screen.getBoundingClientRect();
	const cw = r.width / state.scr.cols;
	const ch = r.height / state.scr.rows;
	const col = Math.floor((e.clientX - r.left) / cw);
	const row = Math.floor((e.clientY - r.top) / ch);
	if (row < 0 || row >= state.scr.rows || col < 0 || col >= state.scr.cols) return;
	state.scr.moveTo(row * state.scr.cols + col);
	render();
}

// The key bar under the screen, for touch screens and browsers that keep
// some function keys for themselves.
function onKeyBar(e) {
	const b = e.target.closest("button");
	if (!b) return;
	if (b.dataset.aid === "RESET") reset();
	else aidKey(b.dataset.aid);
}

// --- Start ---------------------------------------------------------------

for (const ev of ["keydown", "mousedown", "touchstart"]) {
	document.addEventListener(ev, () => (state.active = Date.now()), { capture: true, passive: true });
}
document.addEventListener("keydown", onKey);
document.addEventListener("paste", onPaste);
el.screen.addEventListener("mousedown", onClick);
el.keys.addEventListener("click", onKeyBar);
el.keys.addEventListener("mousedown", (e) => e.preventDefault()); // keep keys out of focus
let resizeTimer;
window.addEventListener("resize", () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(fit, 120);
});

// appInfo asks the application what it calls itself (GET /v1/screen/info)
// for the page title and the status line. Without it the defaults stay.
async function appInfo() {
	try {
		const res = await fetch("/v1/screen/info", { credentials: "same-origin", redirect: "manual" });
		if (!res.ok) return;
		const info = await res.json();
		if (info.system) state.system = info.system;
		if (info.title) document.title = info.title;
	} catch {
		// keep the defaults
	}
}

fit();
state.started = true;
appInfo().then(() => send("START"));
setInterval(idleCheck, 30_000);
setTimeout(tickClock, 60_000 - (Date.now() % 60_000));
