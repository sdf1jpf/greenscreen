import { header, invalidKey, keys, label, lpad, message, msgId, newScreen, panel, pf } from "@greenscreen-dev/worker";
import { cents, dollars, store, totals, type Env, type ReceiptState, type TenderState } from "./common";
import type { Tender } from "./store";

// POS020 TENDER: take payment for the sale, write it, and show the receipt.

const methods: Record<string, Tender> = { C: "CASH", D: "CARD" };

export const tender = panel<TenderState, Env>({
	render(ctx, s) {
		const scr = newScreen(ctx, "POS020");
		header(scr, ctx, "TENDER");
		const t = totals(s.back.lines);
		const items = s.back.lines.reduce((n, l) => n + l.qty, 0);

		label(scr, 4, 2, "ITEMS . . . . .");
		scr.text(4, 18, lpad(items, 9), { color: "green" });
		label(scr, 5, 2, "AMOUNT DUE  . .");
		scr.text(5, 18, lpad(dollars(t.total), 9), { color: "white", bright: true });

		label(scr, 7, 2, "METHOD  . . . .");
		scr.input(7, 18, 1, "method", "C", { bright: s.errField === "method" });
		scr.text(7, 21, "C=CASH  D=CARD", { color: "blue" });
		label(scr, 8, 2, "TENDERED  . . .");
		scr.input(8, 18, 9, "amount", "", { bright: s.errField === "amount" });
		scr.text(8, 29, "CASH ONLY; BLANK FOR THE EXACT AMOUNT", { color: "blue" });

		message(scr, s.msg ?? "");
		keys(scr, "PF1=HELP  PF3=BACK TO SALE  PF12=BACK TO SALE");
		scr.cursorTo(s.errField ?? "amount");
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = "";
		s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const method = methods[(inp.fields.method ?? "C").trim().toUpperCase() || "C"];
		if (!method) {
			s.msg = `${msgId(ctx, "0301E")} METHOD MUST BE C (CASH) OR D (CARD)`;
			s.errField = "method";
			return s;
		}
		const t = totals(s.back.lines);
		const typed = (inp.fields.amount ?? "").trim();
		const paid = method === "CARD" || typed === "" ? t.total : cents(typed);
		if (paid === undefined) {
			s.msg = `${msgId(ctx, "0302E")} AMOUNT MUST BE DOLLARS AND CENTS, E.G. 20 OR 12.50`;
			s.errField = "amount";
			return s;
		}
		if (paid < t.total) {
			s.msg = `${msgId(ctx, "0303E")} TENDERED ${dollars(paid)} IS LESS THAN ${dollars(t.total)} DUE`;
			s.errField = "amount";
			return s;
		}
		const sale = await store(ctx).recordSale({
			token: s.back.token, cashier: ctx.user, lines: s.back.lines, ...t, tender: method, paid, change: paid - t.total,
		});
		return { p: "receipt", back: s.back.back, id: sale.id, next: true } satisfies ReceiptState;
	},
});
