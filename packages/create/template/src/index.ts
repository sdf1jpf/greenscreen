// Your Greenscreen app. Each screen is a panel: render draws it from its
// state, handle answers an AID key with the next state. Add panels to
// programs and options to the menu. The point-of-sale example shows D1,
// lists, field help and more:
// https://github.com/sdf1jpf/greenscreen/tree/main/examples/pos

import {
	createApp, header, helpTable, invalidKey, keys, label, logoff, menuProgram, message, msgId, newScreen, panel, pf,
	type AccessEnv, type MenuState, type PanelState,
} from "@greenscreen-dev/worker";

export interface Env extends AccessEnv {
	STATE_KEY?: string; // signs the commarea
}

// HELLO: greets the operator and counts how often they have pressed Enter.
// The count lives in the state, which comes back with every key.
interface HelloState extends PanelState { p: "hello"; back: MenuState; name?: string; count: number }

const hello = panel<HelloState, Env>({
	render(ctx, s) {
		const scr = newScreen(ctx, "APP010");
		header(scr, ctx, "HELLO");
		label(scr, 4, 2, "YOUR NAME . .");
		scr.input(4, 16, 20, "name", s.name ?? "");
		scr.text(6, 2, `HELLO, ${s.name || ctx.user}. YOU HAVE PRESSED ENTER ${s.count} TIME(S).`, { color: "green" });
		message(scr, s.msg ?? "");
		keys(scr, "PF1=HELP  PF3=RETURN");
		return scr;
	},

	handle(ctx, s, inp) {
		s.msg = "";
		if (inp.aid === pf(3)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		s.name = (inp.fields.name ?? "").trim().toUpperCase();
		s.count++;
		if (s.count === 3) s.msg = `${msgId(ctx, "0100I")} THREE TIMES - TRY PF1 IN THE NAME FIELD`;
		return s;
	},
});

const menu = menuProgram<Env>({
	"": {
		map: "APPM00",
		title: "PRIMARY OPTION MENU",
		options: [
			{ key: "1", name: "HELLO", desc: "Say hello", go: (_ctx, m) => ({ p: "hello", back: m, count: 0 }) },
			{ key: "X", name: "EXIT", desc: "Log off", go: (ctx) => logoff(ctx) },
		],
	},
});

export default createApp<Env>({
	app: { title: "__TITLE__", prefix: "APP", system: "SYS1" },
	programs: { menu, hello },
	fieldHelp: helpTable<Env>({
		"menu.option": { title: "OPTION", lines: ["The menu option to go to."], values: (_ctx, s) => menu.values(s) },
		"hello.name": { title: "YOUR NAME", lines: ["Up to 20 characters. Field help like this comes from helpTable in", "src/index.ts."] },
	}),
	stateKey: (env) => env.STATE_KEY,
});
