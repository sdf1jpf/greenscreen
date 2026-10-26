import { header, invalidKey, keys, lpad, message, newScreen, pad, panel, pf } from "@greenscreen/worker";
import { dollars, listRows, store, type Env, type PricesState } from "./common";

// POS050 PRICE LIST: every product, by SKU.

const FIRST = 6;

export const prices = panel<PricesState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS050");
		header(scr, ctx, "PRICE LIST");
		const products = await store(ctx).products();
		const rows = listRows(ctx, FIRST);
		const top = Math.min(s.top ?? 0, Math.max(products.length - rows, 0));
		scr.text(4, 2, "SKU          DESCRIPTION                     PRICE", { color: "white", bright: true });
		products.slice(top, top + rows).forEach((p, i) => {
			scr.text(FIRST + i, 2, pad(p.sku, 12), { color: "turquoise" });
			scr.text(FIRST + i, 15, pad(p.desc, 28), { color: "green" });
			scr.text(FIRST + i, 44, lpad(dollars(p.price), 9), { color: "green" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF3=RETURN  PF7=UP  PF8=DOWN");
		scr.setCursor(scr.rows, 2);
		return scr;
	},

	handle(ctx, s, inp) {
		s.msg = "";
		const rows = listRows(ctx, FIRST);
		switch (inp.aid) {
			case pf(3):
			case pf(12):
			case "ENTER":
				return s.back;
			case pf(7):
				s.top = Math.max((s.top ?? 0) - rows, 0);
				return s;
			case pf(8):
				s.top = (s.top ?? 0) + rows;
				return s;
			default:
				s.msg = invalidKey(ctx, inp.aid);
				return s;
		}
	},
});
