import { header, invalidKey, keys, label, lpad, message, msgId, newScreen, pad, panel, pf, right } from "@greenscreen-dev/worker";
import { dollars, listRows, newSale, store, totals, type Env, type SaleState } from "./common";

// POS010 SALE ENTRY: ring up items by SKU. The lines travel in the signed
// commarea until the sale is tendered, so nothing is written until then.
// PF1 in the SKU field lists the price list; S beside an item puts its SKU
// in the field.

const FIRST = 8; // the first line row
const MAX_QTY = 999;
// The lines travel in the commarea with every key, so a sale holds at most
// this many.
export const MAX_LINES = 100;

export const sale = panel<SaleState, Env>({
	render(ctx, s) {
		const scr = newScreen(ctx, "POS010");
		header(scr, ctx, "SALE ENTRY");

		label(scr, 4, 2, "SKU . . . .");
		scr.input(4, 14, 12, "sku", "", { bright: s.errField === "sku" });
		label(scr, 4, 30, "QTY");
		scr.input(4, 34, 3, "qty", "", { numeric: true, bright: s.errField === "qty" });
		scr.text(4, 40, "CASHIER " + ctx.user, { color: "blue" });

		scr.text(6, 2, "SKU          DESCRIPTION                QTY      PRICE     AMOUNT", { color: "white", bright: true });
		const rows = listRows(ctx, FIRST) - 4; // room for the totals
		const shown = s.lines.slice(-Math.max(rows, 1));
		const skipped = s.lines.length - shown.length;
		shown.forEach((l, i) => {
			const row = FIRST + i;
			scr.text(row, 2, pad(l.sku, 12), { color: "turquoise" });
			scr.text(row, 15, pad(l.desc, 24), { color: "green" });
			scr.text(row, 41, lpad(l.qty, 4), { color: "green" });
			scr.text(row, 47, lpad(dollars(l.price), 9), { color: "green" });
			scr.text(row, 58, lpad(dollars(l.qty * l.price), 9), { color: "green" });
		});
		if (skipped > 0) scr.text(FIRST - 1, 2, `${skipped} EARLIER LINE(S) NOT SHOWN`, { color: "blue" });
		if (s.lines.length === 0) scr.text(FIRST, 2, "NO ITEMS YET - ENTER A SKU, OR PF1 IN THE SKU FIELD FOR THE PRICE LIST", { color: "blue" });

		const t = totals(s.lines);
		const at = ctx.rows - 5;
		const col = right(scr, 45);
		scr.text(at, col, "SUBTOTAL", { color: "turquoise" });
		scr.text(at, col + 13, lpad(dollars(t.subtotal), 9), { color: "green" });
		scr.text(at + 1, col, "TAX", { color: "turquoise" });
		scr.text(at + 1, col + 13, lpad(dollars(t.tax), 9), { color: "green" });
		scr.text(at + 2, col, "TOTAL", { color: "white", bright: true });
		scr.text(at + 2, col + 13, lpad(dollars(t.total), 9), { color: "white", bright: true });

		message(scr, s.msg ?? "");
		keys(scr, "PF1=HELP  PF3=EXIT  PF5=TENDER  PF6=VOID LINE  PF12=VOID SALE");
		scr.cursorTo(s.errField ?? "sku");
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = "";
		s.errField = undefined;
		switch (inp.aid) {
			case "ENTER":
				break;
			case pf(3):
				if (s.lines.length === 0) return s.back;
				s.msg = `${msgId(ctx, "0201W")} SALE IN PROGRESS - TENDER IT (PF5) OR VOID IT (PF12) FIRST`;
				return s;
			case pf(5):
				if (s.lines.length === 0) {
					s.msg = `${msgId(ctx, "0202E")} NOTHING TO TENDER`;
					return s;
				}
				return { p: "tender", back: s };
			case pf(6): {
				const l = s.lines.pop();
				s.msg = l ? `${msgId(ctx, "0203I")} VOIDED ${l.qty} X ${l.desc}` : `${msgId(ctx, "0204W")} NO LINES TO VOID`;
				return s;
			}
			case pf(12):
			case "CLEAR":
				if (s.lines.length === 0) return s;
				return newSale(s.back, `${msgId(ctx, "0205I")} SALE VOIDED`);
			default:
				s.msg = invalidKey(ctx, inp.aid);
				return s;
		}

		const sku = (inp.fields.sku ?? "").trim().toUpperCase();
		if (!sku) return s;
		const qty = inp.fields.qty?.trim() ? Number(inp.fields.qty) : 1;
		if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
			s.msg = `${msgId(ctx, "0206E")} QUANTITY MUST BE 1 TO ${MAX_QTY}`;
			s.errField = "qty";
			return s;
		}
		const prod = await store(ctx).product(sku);
		if (!prod) {
			s.msg = `${msgId(ctx, "0207E")} SKU ${sku} NOT FOUND - PF1 LISTS THE PRICE LIST`;
			s.errField = "sku";
			return s;
		}
		const same = s.lines.at(-1);
		if (same && same.sku === prod.sku && same.qty + qty <= MAX_QTY) same.qty += qty;
		else if (s.lines.length >= MAX_LINES) s.msg = `${msgId(ctx, "0208E")} A SALE HOLDS ${MAX_LINES} LINES - TENDER THIS ONE (PF5) AND START ANOTHER`;
		else s.lines.push({ sku: prod.sku, desc: prod.desc, qty, price: prod.price });
		return s;
	},
});
