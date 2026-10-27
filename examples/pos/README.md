# Point of sale example

A coffee-counter till on Greenscreen: ring up items, take cash or card,
look up receipts, read the price list and the day's takings. Seven panels
and a menu, each a module in `src/`, on D1.

| Map | Panel | Keys |
| --- | --- | --- |
| POSM00 | Menu: SALE, RECEIPTS, PRICES, EOD | |
| POS010 | Sale entry: SKU and quantity; PF1 in the SKU field lists the price list | PF5 tender, PF6 void line, PF12 void sale |
| POS020 | Tender: cash (with change) or card | PF3 back to the sale |
| POS030 | Receipt | Enter next sale |
| POS040 | Receipts, newest first; S beside one shows it | PF7/PF8 scroll |
| POS050 | Price list | PF7/PF8 scroll |
| POS060 | End of day, by tender, in the terminal's local day | |

Things worth copying:

- A sale's lines live in the commarea, signed with `STATE_KEY`, so nothing
  is written until the tender and the prices can't be changed on the way.
- Each sale gets a token when it starts, and the store writes a token
  once: Enter pressed again after a lost reply shows the same receipt
  instead of charging twice.
- Only the people in `MANAGERS` may change prices. The menu offers the
  price list to everyone; the app's `allow` hook refuses the price change
  panel to anyone else, however the commarea got there.
- The panels reach data through the `Store` interface (`src/store.ts`):
  D1 in the Worker, memory in the tests.

## Run it

```sh
npm install                      # at the repo root
cd examples/pos
npx wrangler d1 migrations apply greenscreen-pos --local
npm run dev                      # signs on as CASHIER1, no Access
```

Open http://localhost:8787 for the browser terminal, or run the Go terminal
against it: `go run ../../cmd/greenscreen -api http://localhost:8787`.

To deploy, create the database (`wrangler d1 create greenscreen-pos`), put
its ID in `wrangler.jsonc`, apply the migrations with `--remote`, set
`STATE_KEY` with `wrangler secret put`, set `MANAGERS` to the emails that
may change prices, and put the Worker behind Cloudflare Access (set
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`).
