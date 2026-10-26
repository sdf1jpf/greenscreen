import { clock, header, invalidKey, keys, lpad, message, msgId, newScreen, pad, panel, pf } from "@greenscreen-dev/worker";
import { dollars, listRows, store, type Env, type ReceiptState, type ReceiptsState } from "./common";

// POS040 RECEIPTS: the latest sales, newest first. S beside one shows it.

const FIRST = 6;
const LIMIT = 200;

export const receipts = panel<ReceiptsState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS040");
		header(scr, ctx, "RECEIPTS");
		const sales = await store(ctx).sales(LIMIT);
		const rows = listRows(ctx, FIRST);
		const top = Math.min(s.top ?? 0, Math.max(sales.length - rows, 0));
		const shown = sales.slice(top, top + rows);
		s.ids = shown.map((x) => x.id);

		scr.text(4, 2, "S  RECEIPT  TIME            CASHIER   TENDER      TOTAL", { color: "white", bright: true });
		if (sales.length === 0) scr.text(FIRST, 5, "NO SALES YET", { color: "blue" });
		shown.forEach((x, i) => {
			const row = FIRST + i;
			const name = `sel:${x.id}`;
			scr.input(row, 2, 1, name, "", { bright: s.errSel === name });
			scr.text(row, 5, lpad(x.id, 7), { color: "turquoise" });
			scr.text(row, 14, clock(ctx, x.at), { color: "green" });
			scr.text(row, 30, pad(x.cashier, 8), { color: "green" });
			scr.text(row, 40, pad(x.tender, 6), { color: "green" });
			scr.text(row, 47, lpad(dollars(x.total), 10), { color: "green" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF1=HELP  PF3=RETURN  PF7=UP  PF8=DOWN");
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errSel = undefined;
		const rows = listRows(ctx, FIRST);
		switch (inp.aid) {
			case pf(3):
			case pf(12):
				return s.back;
			case pf(7):
				s.top = Math.max((s.top ?? 0) - rows, 0);
				return s;
			case pf(8):
				s.top = (s.top ?? 0) + rows;
				return s;
			case "ENTER":
				break;
			default:
				s.msg = invalidKey(ctx, inp.aid);
				return s;
		}
		for (const id of s.ids ?? []) {
			const name = `sel:${id}`;
			const code = (inp.fields[name] ?? "").trim().toUpperCase();
			if (!code) continue;
			if (code !== "S") {
				s.msg = `${msgId(ctx, "0501E")} INVALID SELECTION CODE "${code}" - TYPE S TO SHOW A RECEIPT`;
				s.errSel = name;
				return s;
			}
			return { p: "receipt", back: s, id } satisfies ReceiptState;
		}
		return s;
	},
});
