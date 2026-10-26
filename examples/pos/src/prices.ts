import { header, invalidKey, keys, label, lpad, message, msgId, newScreen, pad, panel, pf, value } from "@greenscreen-dev/worker";
import { cents, dollars, listRows, store, type Env, type PriceState, type PricesState } from "./common";

// POS050 PRICE LIST: every product, by SKU. C beside one changes its price.

const FIRST = 6;

export const prices = panel<PricesState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS050");
		header(scr, ctx, "PRICE LIST");
		const products = await store(ctx).products();
		const rows = listRows(ctx, FIRST);
		const top = Math.min(s.top ?? 0, Math.max(products.length - rows, 0));
		const shown = products.slice(top, top + rows);
		s.skus = shown.map((p) => p.sku);
		scr.text(4, 2, "S  SKU          DESCRIPTION                     PRICE", { color: "white", bright: true });
		shown.forEach((p, i) => {
			const name = `sel:${p.sku}`;
			scr.input(FIRST + i, 2, 1, name, "", { bright: s.errSel === name });
			scr.text(FIRST + i, 5, pad(p.sku, 12), { color: "turquoise" });
			scr.text(FIRST + i, 18, pad(p.desc, 28), { color: "green" });
			scr.text(FIRST + i, 47, lpad(dollars(p.price), 9), { color: "green" });
		});
		message(scr, s.msg ?? "");
		keys(scr, "PF1=HELP  PF3=RETURN  PF7=UP  PF8=DOWN");
		return scr;
	},

	handle(ctx, s, inp) {
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
		for (const sku of s.skus ?? []) {
			const name = `sel:${sku}`;
			const code = (inp.fields[name] ?? "").trim().toUpperCase();
			if (!code) continue;
			if (code !== "C") {
				s.msg = `${msgId(ctx, "0502E")} INVALID SELECTION CODE "${code}" - TYPE C TO CHANGE A PRICE`;
				s.errSel = name;
				return s;
			}
			return { p: "price", back: s, sku } satisfies PriceState;
		}
		return s.back;
	},
});

// POS051 PRICE CHANGE: one product's price. The product is locked while the
// panel shows, so two terminals can't change it at once.
export const price = panel<PriceState, Env>({
	async render(ctx, s) {
		const scr = newScreen(ctx, "POS051");
		header(scr, ctx, "PRICE CHANGE");
		const p = await store(ctx).product(s.sku);
		label(scr, 4, 2, "SKU . . . . . .");
		value(scr, 4, 18, s.sku);
		label(scr, 5, 2, "DESCRIPTION . .");
		value(scr, 5, 18, p?.desc ?? "");
		label(scr, 6, 2, "PRICE NOW . . .");
		value(scr, 6, 18, p ? dollars(p.price) : "");
		label(scr, 8, 2, "NEW PRICE . . .");
		scr.input(8, 18, 9, "price", "", { bright: s.errField === "price" });
		message(scr, s.msg ?? "");
		keys(scr, "PF1=HELP  PF3=CANCEL");
		scr.cursorTo("price");
		return scr;
	},

	async handle(ctx, s, inp) {
		s.msg = s.errField = undefined;
		if (inp.aid === pf(3) || inp.aid === pf(12)) return s.back;
		if (inp.aid !== "ENTER") {
			s.msg = invalidKey(ctx, inp.aid);
			return s;
		}
		const amount = cents(inp.fields.price ?? "");
		if (amount === undefined || amount === 0) {
			s.msg = `${msgId(ctx, "0511E")} ENTER THE NEW PRICE, E.G. 4.99`;
			s.errField = "price";
			return s;
		}
		await store(ctx).setPrice(s.sku, amount);
		s.back.msg = `${msgId(ctx, "0510I")} ${s.sku} NOW ${dollars(amount)}`;
		return s.back;
	},

	locks: (s) => [`PRODUCT ${s.sku}`],
});
