# Greenscreen

Build 3270-style green screen applications on Cloudflare Workers.

The Worker owns every screen. Clients are generic block-mode terminals:
they draw the fields they are sent, let the operator type into the input
fields, and send the screen back when an AID key (Enter, a PF key, Clear)
is pressed. It is the CICS pseudo-conversational model over HTTP, so a new
screen ships with a Worker deploy and no client changes. The wire format is
in [docs/protocol.md](docs/protocol.md).

| Package | What it is |
| --- | --- |
| [`@greenscreen-dev/worker`](packages/worker) | The screen engine, builder, ISPF-style menus, PF1 field help, PF24 RETRIEVE, signed commarea and Cloudflare Access logon, as a Hono app. |
| [Go terminal](cmd/greenscreen) | One binary for every app, run in any terminal: `go install github.com/sdf1jpf/greenscreen/cmd/greenscreen@latest`. The 3270 screen model is importable as [`tn3270`](tn3270). |
| [`@greenscreen-dev/web`](packages/web) | The same terminal in a browser page, served from the Worker's static assets. |
| [`examples/pos`](examples/pos) | A point-of-sale app: sale entry, tender, receipts, price list, end of day. |
| [`create-greenscreen`](packages/create) | `npm create greenscreen@latest my-app` makes a starter app. |

## A panel

```ts
import {
	createApp, header, keys, menuProgram, message, newScreen, panel, pf, type AccessEnv, type PanelState,
} from "@greenscreen-dev/worker";

type Env = AccessEnv & { STATE_KEY: string }; // a secret that signs the commarea

interface SaleState extends PanelState { p: "sale"; total: number }

const sale = panel<SaleState>({
	render(ctx, s) {
		const scr = newScreen(ctx, "POS010");
		header(scr, ctx, "SALE ENTRY");
		scr.text(4, 2, "SKU ===>", { color: "turquoise" });
		scr.input(4, 11, 12, "sku");
		scr.text(6, 2, `TOTAL ${s.total}`);
		message(scr, s.msg ?? "");
		keys(scr, "PF3=EXIT");
		return scr;
	},
	async handle(ctx, s, inp) {
		if (inp.aid === pf(3)) return s.back!;
		s.total += await priceOf(ctx, inp.fields.sku);
		return s;
	},
});

const menu = menuProgram({
	"": {
		map: "POSM00",
		title: "PRIMARY OPTION MENU",
		options: [{ key: "1", name: "SALE", desc: "Ring up a sale", go: (_ctx, m) => ({ p: "sale", back: m, total: 0 }) }],
	},
});

export default createApp<Env>({
	app: { title: "POINT OF SALE", prefix: "POS", system: "POS1" },
	programs: { menu, sale },
	stateKey: (env) => env.STATE_KEY,
});
```

`createApp` returns a Hono app with `/v1/health`, `/v1/screen/info` and
`POST /v1/screen`. Add your own routes with its `signedOn` middleware:

```ts
const app = createApp({ ... });
app.get("/v1/sales/:id", app.signedOn, (c) => ...);
export default app;
```

## The terminal

```sh
greenscreen -api https://pos.example.com
```

It asks the application for its name, system and logon banner
(`GET /v1/screen/info`), signs on through Cloudflare Access with
`cloudflared` (or a service token in `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET`), and from then on draws whatever screens the
Worker sends. Give `/v1/screen/info` and `/v1/health` an Access Bypass
policy so the logon screen can be titled before sign-in; without one the
terminal uses its defaults. `-h` lists the flags.

## Releasing

Bump the version in `packages/worker`, `packages/web` and `packages/create`
(and the template's dependencies), then push a matching tag, e.g. `v0.2.0`,
or run the Release workflow by hand on main, which tags it once it's published.
The Release workflow tests and publishes to npm through trusted publishing
(OIDC), so there is no npm token: each package lists `sdf1jpf/greenscreen`
and `release.yml` as its trusted publisher on npmjs.com. The Go terminal is released by the same tag: `go install
github.com/sdf1jpf/greenscreen/cmd/greenscreen@v0.2.0`.

## License

MIT

## Developing

```sh
npm install
npm test
go test ./...
```
