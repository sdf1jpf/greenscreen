// SEND, TSO's message to other users, typed on any command line:
//
//	SEND 'LUNCH AT NOON?' USER(JFRANK)       to one user, or USER(A,B)
//	SE 'SYSTEM GOING DOWN AT 5' USER(*)      to everyone signed on
//	SEND 'CALL ME' USER(BSMITH) LOGON        kept until they log on
//	SEND 'PRINTER JAMMED'                    to the operator
//
// The message shows on the receiver's message line with the sender's
// userid, at their next screen; a terminal listening on GET /v1/live
// redraws at once to show it. Put sendCommand in ScreenConfig.commands.

import { HttpError } from "./http.js";
import { msgId, type Ctx } from "./screen.js";

const MAX_TEXT = 115; // as TSO's

export function isSend(cmd: string): boolean {
	return /^(TSO\s+)?SE(ND)?(\s|$)/i.test(cmd);
}

export interface SendCommand {
	text: string;
	users: string[]; // empty: the operator
	logon: boolean;
}

// parseSend reads a SEND command, or throws with what is wrong.
export function parseSend(cmd: string): SendCommand {
	const m = /^(?:TSO\s+)?SE(?:ND)?\s*'((?:[^']|'')*)'\s*(.*)$/i.exec(cmd.trim());
	if (!m) throw usage();
	const text = m[1].replace(/''/g, "'").trim();
	if (!text) throw usage();
	if (text.length > MAX_TEXT) throw new HttpError(400, "invalid", `message longer than ${MAX_TEXT} characters`);
	let rest = m[2].toUpperCase().replace(/^,/, "");
	const out: SendCommand = { text, users: [], logon: false };
	const user = /(?:^|[\s,])U(?:SER)?\(([^)]*)\)/.exec(rest);
	if (user) {
		out.users = user[1].split(/[\s,]+/).filter(Boolean);
		rest = rest.replace(user[0], " ");
		if (out.users.length === 0 || out.users.some((u) => u !== "*" && !/^[A-Z0-9#@$]{1,8}$/.test(u))) {
			throw new HttpError(400, "invalid", "userids are 1 to 8 letters or digits, or * for everyone");
		}
	}
	for (const word of rest.split(/[\s,]+/).filter(Boolean)) {
		if (word === "LOGON" || word === "LOGO") out.logon = true;
		else if (word !== "NOW") throw new HttpError(400, "invalid", `unknown SEND operand ${word}`);
	}
	return out;
}

function usage(): HttpError {
	return new HttpError(400, "invalid", "enter SEND 'message' USER(userid)");
}

export interface SendResult {
	sent: string[]; // users it was sent or saved for
	notOn: string[]; // users not signed on, without LOGON
}

// Mailbox delivers SEND messages; the Sessions Durable Object is one.
export interface Mailbox {
	send(from: string, to: string[], text: string, logon: boolean): SendResult | Promise<SendResult>;
}

export interface SendOptions<E> {
	mailbox: (ctx: Ctx<E>) => Mailbox;
	// operator takes a SEND with no USER, such as by writing it to a
	// system log. Without it, such a SEND is refused.
	operator?: (ctx: Ctx<E>, text: string) => void | Promise<void>;
}

// sendCommand is a ScreenConfig.commands hook that runs SEND and leaves any
// other command to the panel.
export function sendCommand<E>(opts: SendOptions<E>): (ctx: Ctx<E>, cmd: string) => Promise<string | undefined> {
	return async (ctx, cmd) => (isSend(cmd) ? send(ctx, cmd, opts) : undefined);
}

// send runs a SEND command and returns the message for the sender's
// message line.
export async function send<E>(ctx: Ctx<E>, cmd: string, opts: SendOptions<E>): Promise<string> {
	let c: SendCommand;
	try {
		c = parseSend(cmd);
	} catch (e) {
		if (!(e instanceof HttpError)) throw e;
		return `${msgId(ctx, "1213E")} ${e.message.toUpperCase()}`;
	}
	if (c.users.length === 0) {
		if (!opts.operator) return `${msgId(ctx, "1213E")} NAME THE USERS: SEND 'MESSAGE' USER(USERID)`;
		await opts.operator(ctx, c.text);
		return `${msgId(ctx, "1212I")} MESSAGE SENT TO THE OPERATOR`;
	}
	const r = await opts.mailbox(ctx).send(ctx.user, c.users, c.text, c.logon);
	if (r.sent.length === 0 && r.notOn.length === 0) return `${msgId(ctx, "1211W")} NO OTHER USERS ARE LOGGED ON`;
	if (r.sent.length === 0) return `${msgId(ctx, "1211W")} ${r.notOn.join(", ")} NOT LOGGED ON - ADD LOGON TO KEEP THE MESSAGE FOR THEM`;
	const sent = `${msgId(ctx, "1210I")} MESSAGE ${c.logon ? "SENT OR SAVED FOR" : "SENT TO"} ${r.sent.join(", ")}`;
	return r.notOn.length ? `${sent} - NOT LOGGED ON: ${r.notOn.join(", ")}` : sent;
}
