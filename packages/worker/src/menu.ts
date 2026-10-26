import type { Value } from "./fieldhelp";
import { header, invalidKey, keys, label, message, newScreen, time, type Ctx } from "./screen";
import { pf, type MenuState, type Next, type PanelState, type Program } from "./program";

// The ISPF-style primary option menu and its submenus. An option is picked
// by its key on the menu shown, by a fast path from the primary menu such
// as 1.2 or =1.2, or by its name (or an alias) from any menu. A second word
// is passed to the option, so 1.2 000105 can jump straight to a record.

export interface Option<E = unknown> {
	key: string;
	name: string;
	desc: string; // keep it to 22 characters or fewer if the menu may show two columns
	aliases?: string[];
	sub?: string; // opens this submenu
	go?: (ctx: Ctx<E>, back: MenuState, arg: string, rest: string) => Next | Promise<Next>; // rest: every word after the option
}

export interface Menu<E = unknown> {
	map: string;
	title: string;
	parent?: string; // the menu PF3 returns to, for a submenu of a submenu
	options: Option<E>[];
	hint?: string[]; // up to two lines of guidance near the bottom
}

// Menus maps a menu's key to it. "" is the primary menu; a submenu's key is
// usually the option path that opens it ("1", "4.2").
export type Menus<E = unknown> = Record<string, Menu<E>>;

export interface MenuOptions<E> {
	pf4?: { label: string; go: (ctx: Ctx<E>, m: MenuState) => Next | Promise<Next> }; // an extra key on every menu, e.g. PF4=BROWSE
	info?: boolean; // show USERID, TERMINAL, SYSTEM and HOST on the primary menu; default true
}

const NAME_WIDTH = 12;

export function logoff(ctx: Ctx): Next {
	return { logoff: `IKJ56470I ${ctx.user} LOGGED OFF AT ${time(ctx)}` };
}

// menuProgram builds the menu panel. Register it as "menu".
export function menuProgram<E>(menus: Menus<E>, opts: MenuOptions<E> = {}): Program<MenuState, E> & { values(s: PanelState): Value[] } {
	if (!menus[""]) throw new Error('menus must have a primary menu under ""');
	const current = (m: MenuState) => menus[m.sub ?? ""] ?? menus[""];

	// byName finds an option by name or alias on any menu.
	const byName = (word: string) => {
		for (const menu of Object.values(menus)) {
			for (const o of menu.options) if (o.name === word || o.aliases?.includes(word)) return o;
		}
		return undefined;
	};

	// menuOf is the key of the menu an option is on.
	const menuOf = (opt: Option<E>) => {
		for (const [k, menu] of Object.entries(menus)) if (menu.options.includes(opt)) return k;
		return "";
	};

	return {
		// values lists the options on the menu s shows, for the option
		// field's prompt list.
		values(s) {
			const mn = s.p === "menu" ? current(s as MenuState) : menus[""];
			return mn.options.map((o) => ({ code: o.key, desc: `${o.name} - ${o.desc}`.toUpperCase() }));
		},

		render(ctx, m) {
			const primary = !m.sub || !menus[m.sub];
			const mn = current(m);
			const scr = newScreen(ctx, mn.map);
			header(scr, ctx, mn.title);

			label(scr, 4, 2, "OPTION ===>");
			scr.input(4, 14, 40, "option", m.option ?? "");

			mn.options.forEach(({ key, name, desc }, i) => {
				scr.text(6 + i, 4, key, { color: "white", bright: true });
				scr.text(6 + i, 7, name, { color: "turquoise" });
				scr.text(6 + i, 7 + NAME_WIDTH, desc, { color: "green" });
			});

			if (primary && opts.info !== false) {
				const info = [
					["USERID", ctx.user],
					["TERMINAL", ctx.terminal],
					["SYSTEM", ctx.system],
					["HOST", ctx.host.toUpperCase().slice(0, 30)],
				];
				const row = 7 + mn.options.length;
				let col = 4;
				for (const [k, v] of info) {
					if (col + k.length + v.length + 1 > scr.cols) break;
					label(scr, row, col, k);
					scr.text(row, col + k.length + 1, v, { color: "white" });
					col += k.length + v.length + 4;
				}
			}
			const hint = mn.hint ?? (primary
				? ["Enter an option, or a fast path such as 1.2 to go straight there.", "Press PF1 at any time for help."]
				: ["Enter an option, or the name of one. PF3 returns to the previous", "menu, and =X logs off."]);
			hint.slice(0, 2).forEach((line, i) => scr.text(scr.rows - 4 + i, 4, line, { color: "blue" }));

			message(scr, m.msg ?? "");
			const extra = opts.pf4 ? `  PF4=${opts.pf4.label}` : "";
			keys(scr, `PF1=HELP  PF3=${primary ? "LOGOFF" : "RETURN"}${extra}  PF12=CANCEL`);
			scr.cursorTo("option");
			return scr;
		},

		async handle(ctx, m, input) {
			m.msg = "";
			switch (input.aid) {
				case "ENTER":
					break;
				case pf(3):
					if (m.sub) return menus[m.sub]?.parent ? { p: "menu", sub: menus[m.sub].parent } satisfies MenuState : { p: "menu" };
					return logoff(ctx);
				case pf(4):
					if (opts.pf4) return opts.pf4.go(ctx, m);
					m.msg = invalidKey(ctx, input.aid);
					return m;
				case pf(12):
				case "CLEAR":
					m.option = "";
					return m;
				default:
					m.msg = invalidKey(ctx, input.aid);
					return m;
			}

			const words = (input.fields.option ?? "").toUpperCase().split(/\s+/).filter(Boolean);
			m.option = "";
			if (words.length === 0) return m;
			const arg = words[1] ?? "";

			// A leading = or a dotted path starts from the primary menu.
			let cmd = words[0];
			let mn = current(m);
			if (cmd.startsWith("=") || cmd.includes(".")) {
				cmd = cmd.replace(/^=/, "");
				mn = menus[""];
			}
			if (cmd === "") return { p: "menu" };
			if (cmd === "X" && !mn.options.some((o) => o.key === "X")) return logoff(ctx);

			const path = cmd.split(".");
			let opt = path.length === 1 ? mn.options.find((o) => o.key === cmd) ?? byName(cmd) : undefined;
			for (let i = 0; i < path.length && path.length > 1; i++) {
				opt = mn.options.find((o) => o.key === path[i]);
				if (!opt || i === path.length - 1) break;
				if (!opt.sub || !menus[opt.sub]) {
					opt = undefined; // the path goes on past an option
					break;
				}
				mn = menus[opt.sub];
			}
			if (opt?.sub) return { p: "menu", sub: opt.sub } satisfies MenuState;
			if (opt?.go) {
				// The option returns to the menu it is on, which a fast path or a
				// name may have skipped past.
				const home = menuOf(opt);
				const back: MenuState = home === (m.sub ?? "") ? m : home ? { p: "menu", sub: home } : { p: "menu" };
				return opt.go(ctx, back, arg, words.slice(1).join(" "));
			}
			m.option = words.join(" ");
			m.msg = "ISPD117E INVALID OPTION " + words[0];
			return m;
		},
	};
}
