import { date, header, keys, lpad, newScreen, panel } from "@greenscreen/worker";
import { dollars, store, type Env, type EodState, type PosCtx } from "./common";

// POS060 END OF DAY: today's takings in the terminal's local time, by tender.

export const eod = panel<EodState, Env>({
	async render(ctx, _s) {
		const scr = newScreen(ctx, "POS060");
		header(scr, ctx, "END OF DAY - " + date(ctx));
		const [from, to] = today(ctx);
		const sum = await store(ctx).summary(from, to);
		const rows: [string, string][] = [
			["SALES", lpad(sum.count, 10)],
			["SUBTOTAL", lpad(dollars(sum.subtotal), 10)],
			["TAX", lpad(dollars(sum.tax), 10)],
			["TOTAL", lpad(dollars(sum.total), 10)],
			["", ""],
			[`CASH (${sum.byTender.CASH.count})`, lpad(dollars(sum.byTender.CASH.total), 10)],
			[`CARD (${sum.byTender.CARD.count})`, lpad(dollars(sum.byTender.CARD.total), 10)],
		];
		rows.forEach(([k, v], i) => {
			if (!k) return;
			scr.text(5 + i, 4, k, { color: "turquoise" });
			scr.text(5 + i, 20, v, k === "TOTAL" ? { color: "white", bright: true } : { color: "green" });
		});
		keys(scr, "PF3=RETURN");
		scr.setCursor(scr.rows, 2);
		return scr;
	},

	handle(_ctx, s) {
		return s.back;
	},
});

// today is the start and end of the terminal's local day, in UTC.
function today(ctx: PosCtx): [string, string] {
	const offset = ctx.tzOffset * 60_000;
	const local = new Date(Date.now() + offset);
	const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset;
	return [new Date(start).toISOString(), new Date(start + 86_400_000).toISOString()];
}
