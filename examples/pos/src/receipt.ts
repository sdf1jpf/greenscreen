import { header, keys, lpad, message, msgId, newScreen, pad, panel, pf, stamp } from "@greenscreen/worker";
import { dollars, newSale, store, type Env, type ReceiptState, type SaleState } from "./common";

// POS030 RECEIPT: one sale as it would print. Right after a tender, Enter
// starts the next sale; from the receipt list it goes back there.

export const receipt = panel<ReceiptState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS030");
		header(scr, ctx, `RECEIPT ${s.id}`);
		const sale = await store(ctx).sale(s.id);
		if (!sale) {
			message(scr, `${msgId(ctx, "0401E")} RECEIPT ${s.id} NOT FOUND`);
			keys(scr, "PF3=RETURN");
			return scr;
		}
		scr.text(4, 2, `${stamp(ctx, sale.at)}   CASHIER ${sale.cashier}   TERMINAL ${ctx.terminal}`, { color: "blue" });
		const room = ctx.rows - 14;
		sale.lines.slice(0, room).forEach((l, i) => {
			scr.text(6 + i, 2, pad(`${l.qty} X ${l.desc}`, 40), { color: "green" });
			scr.text(6 + i, 44, lpad(dollars(l.qty * l.price), 10), { color: "green" });
		});
		if (sale.lines.length > room) scr.text(6 + room, 2, `... ${sale.lines.length - room} MORE`, { color: "blue" });
		const at = ctx.rows - 7;
		const rows: [string, number, boolean][] = [
			["SUBTOTAL", sale.subtotal, false],
			["TAX", sale.tax, false],
			["TOTAL", sale.total, true],
			[sale.tender, sale.paid, false],
			["CHANGE", sale.change, sale.change > 0],
		];
		rows.forEach(([k, v, hi], i) => {
			scr.text(at + i, 30, k, { color: "turquoise" });
			scr.text(at + i, 44, lpad(dollars(v), 10), hi ? { color: "white", bright: true } : { color: "green" });
		});
		message(scr, s.msg ?? (s.next ? `${msgId(ctx, "0402I")} SALE ${sale.id} COMPLETE - CHANGE ${dollars(sale.change)}` : ""));
		keys(scr, s.next ? "ENTER=NEXT SALE  PF3=MENU" : "PF3=RETURN");
		scr.setCursor(scr.rows, 2);
		return scr;
	},

	handle(_ctx, s, inp) {
		if (s.next && inp.aid === "ENTER") return newSale(s.back as SaleState["back"]);
		if (s.next || inp.aid === pf(3) || inp.aid === pf(12) || inp.aid === "ENTER") return s.back;
		return s;
	},
});
