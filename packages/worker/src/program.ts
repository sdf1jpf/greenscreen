// Panels are pseudo-conversational programs: the state they need between
// screens travels in the response's commarea, so the Worker keeps no
// session. A program's state is plain JSON tagged with its panel name in
// "p", the key it is registered under.

import type { Scrolled } from "./list.js";
import type { Ctx, Screen } from "./screen.js";

// PanelState is what every panel's state has. back is the state to return
// to, for panels that have one; msg is the message line.
export interface PanelState {
	p: string;
	back?: PanelState;
	msg?: string;
}

// The two panels the framework provides.
export interface MenuState extends PanelState { p: "menu"; sub?: string; option?: string } // sub: the submenu shown, unset for the primary menu
export interface HelpState extends PanelState, Scrolled { // scrolled: the field's list of values
	p: "help";
	back: PanelState;
	field?: string; // help for that field
	vals?: Record<string, string>; // what the operator had typed on the screen, put back on return
	errSel?: string;
}

// Input is what the operator sent with the AID key.
export interface Input {
	aid: string; // ENTER, CLEAR, PA1-PA3, PF1-PF24
	fields: Record<string, string>;
	modified: Set<string>;
	cursorField: string;
}

export interface Logoff { logoff: string }

export type Next = PanelState | Logoff;

// Program renders a panel from its state and handles an AID key, returning
// the state to show next (the same object to stay) or a logoff. E is the
// Worker's bindings.
export interface Program<S extends PanelState = PanelState, E = unknown> {
	render(ctx: Ctx<E>, s: S): Screen | Promise<Screen>;
	handle(ctx: Ctx<E>, s: S, input: Input): Next | Promise<Next>;
	// locks names the records the panel holds for update while it shows,
	// such as "CUSTOMER 000101", when the app has sessions (see
	// ScreenConfig.sessions). They are held for as long as the panel, or one
	// opened over it like help, is showing.
	locks?(s: S): string[];
	// unlocked is the panel without its locks, for when they were lost to
	// another session: an inquiry instead of an update, say.
	unlocked?(s: S): PanelState;
}

// panel types a program's state without repeating it: panel<SaleState>({...}).
export function panel<S extends PanelState, E = unknown>(p: Program<S, E>): Program<S, E> {
	return p;
}

// Fill puts values in a panel's input fields the next time it is drawn,
// with their modified data tags set as if the operator had typed them:
// what was typed before PF1, a value picked from a prompt list, or a
// retrieved command. It travels on the state for one screen only.
export interface Fill {
	fields: Record<string, string>;
	cursor?: string; // the field to put the cursor in
}

export function withFill<S extends PanelState>(s: S, fill: Fill): S {
	(s as S & { fill?: Fill }).fill = fill;
	return s;
}

// takeFill removes the fill from a state and returns it.
export function takeFill(s: PanelState): Fill | undefined {
	const st = s as PanelState & { fill?: Fill };
	const fill = st.fill;
	delete st.fill;
	return fill;
}

// Download hands the operator a file along with the next screen: the client
// fetches url (an API path, signed on the same way) and saves or opens it
// as name. Like a fill, it travels on the state for one screen only.
export interface Download {
	url: string;
	name: string;
}

export function withDownload<S extends PanelState>(s: S, d: Download): S {
	(s as S & { download?: Download }).download = d;
	return s;
}

// takeDownload removes the download from a state and returns it.
export function takeDownload(s: PanelState): Download | undefined {
	const st = s as PanelState & { download?: Download };
	const d = st.download;
	delete st.download;
	return d;
}

export function pf(n: number): string {
	return `PF${n}`;
}

// isLogoff tells a logoff from a panel state.
export function isLogoff(n: Next): n is Logoff {
	return "logoff" in n;
}
