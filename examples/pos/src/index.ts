// A point-of-sale terminal on Greenscreen: ring up a sale, take payment,
// look up receipts, read the price list and the day's takings. Every
// screen is a panel in this directory; @greenscreen-dev/worker does the rest.

import { createApp, helpTable, logoff, menuProgram, sendCommand, values } from "@greenscreen-dev/worker";
import { dollars, manager, newSale, store, type Env } from "./common";
import { eod } from "./eod";
import { price, prices } from "./prices";
import { receipt } from "./receipt";
import { receipts } from "./receipts";
import { sale } from "./sale";
import { tender } from "./tender";

const menu = menuProgram<Env>({
	"": {
		map: "POSM00",
		title: "PRIMARY OPTION MENU",
		options: [
			{ key: "1", name: "SALE", desc: "Ring up a sale", go: (_ctx, m) => newSale(m) },
			{ key: "2", name: "RECEIPTS", desc: "Look up a sale", aliases: ["R"], go: (_ctx, m) => ({ p: "receipts", back: m }) },
			{ key: "3", name: "PRICES", desc: "The price list", aliases: ["P"], go: (_ctx, m) => ({ p: "prices", back: m }) },
			{ key: "4", name: "EOD", desc: "End of day takings", aliases: ["E"], go: (_ctx, m) => ({ p: "eod", back: m }) },
			{ key: "X", name: "EXIT", desc: "Log off", go: (ctx) => logoff(ctx) },
		],
		hint: [
			"Enter an option, or its name: SALE, RECEIPTS, PRICES, EOD.",
			"SEND 'MESSAGE' USER(USERID) on the option line messages another cashier.",
			"Press PF1 at any time for help.",
		],
	},
});

// The one Sessions object (worker.ts), when the binding is there.
const tso = (env: Env) => env.SESSIONS?.get(env.SESSIONS.idFromName("TSO"));

const app = createApp<Env>({
	app: { title: "POINT OF SALE", prefix: "POS", system: "POS1" },
	programs: { menu, sale, tender, receipt, receipts, prices, price, eod },
	// The price change panel is for managers only, however it is reached.
	allow: (ctx, s) => s.p !== "price" || manager(ctx),
	sessions: tso,
	live: tso,
	commands: sendCommand<Env>({ mailbox: (ctx) => tso(ctx.env)! }),
	snapshot: { browser: (env) => env.BROWSER, limit: (env) => env.SNAPSHOT_LIMIT },
	fieldHelp: helpTable<Env>({
		"menu.option": { title: "OPTION", lines: ["The menu option to go to."], values: (_ctx, s) => menu.values(s) },
		"sale.sku": {
			title: "SKU",
			lines: ["The item to ring up. Type its SKU, or S beside one below to fill it in,", "then press Enter."],
			values: async (ctx) => (await store(ctx).products()).map((p) => ({ code: p.sku, desc: `${p.desc}  ${dollars(p.price)}` })),
		},
		"sale.qty": { title: "QUANTITY", lines: ["How many of the item, 1 to 999. Blank is 1."] },
		"tender.method": { title: "METHOD", lines: ["How the customer pays."], values: values(["C", "CASH"], ["D", "CARD"]) },
		"tender.amount": { title: "TENDERED", lines: ["The cash handed over, e.g. 20 or 12.50. Blank is the exact amount.", "Ignored for card."] },
		"receipts.sel": { title: "SELECTION CODE", lines: ["Type S beside a receipt and press Enter to show it."], values: values(["S", "SHOW IT"]) },
		"prices.sel": { title: "SELECTION CODE", lines: ["Type C beside a product and press Enter to change its price."], values: values(["C", "CHANGE ITS PRICE"]) },
		"price.price": { title: "NEW PRICE", lines: ["The product's new price in dollars, e.g. 4.99."] },
	}),
	stateKey: (env) => env.STATE_KEY,
});

export default app;
