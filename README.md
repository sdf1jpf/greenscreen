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
| [Go terminal](cmd/greenscreen) | One binary for every app, run in any terminal: `go install github.com/sdf1jpf/greenscreen/cmd/greenscreen@latest`. `greenscreen serve-ssh` serves it to SSH clients ([Over SSH](#over-ssh)). The 3270 screen model is importable as [`tn3270`](tn3270). |
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

## Optional pieces

`createApp` takes more when the app wants them:

| Option | What it adds |
| --- | --- |
| `sessions` | TSO sessions: record locks named by panels (`locks`), and messages breaking in on the message line. Use the `Sessions` Durable Object from `@greenscreen-dev/worker/sessions`. |
| `live` | `GET /v1/live`, so the terminals redraw on pushes instead of polling. The `Sessions` object serves it too; subclass it and override `watch`, or call `notify`, to push your own events. |
| `commands` | A command any command line takes. `sendCommand` gives you TSO's SEND. |
| `snapshot` | `POST /v1/snapshot`: Ctrl+S in the terminals saves a PNG or PDF of the screen, drawn by Browser Rendering. |
| `context` | Your own things on every panel's `ctx`, such as `{ db: ctx.env.DB }`. |

A list longer than the screen scrolls with `page`, `scroll` and
`position`: the state keeps where it is, PF7 and PF8 move a page, and the
operator is told at the top or bottom (the POS price list and receipts
use them).

Under `wrangler dev` with `DEV_USER` set, every screen is checked as it is
drawn: a field off the screen, running off its end, or on top of another
(counting the attribute position before each field) is logged as a warning.
`layoutProblems(scr)` does the same check in a test.

A panel sends the operator a file with `withDownload(s, { url, name })`; the
terminals fetch it from your API and save it. The POS example uses
sessions, live, SEND and snapshots: `src/worker.ts` exports the Durable
Object, and the price change panel locks the product it changes.

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

A server that Access isn't in front of, such as one on a store's own
network, can check the same service tokens itself: give `createApp` the
`auth` `serviceTokenAuth((env) => tokens)`, where `tokens` maps each client
ID to `await tokenHash(secret)`. A terminal then moves between the two by
its `-api` URL alone. Serve it over HTTPS: the terminal won't send its
token over plain HTTP to anything but this machine.

A userid is TSO-style, eight characters from the email or client ID, so
two people can want the same one (`john.smith@` and `johnsmith@` are both
`JOHNSMIT`). With `sessions`, the Sessions object gives each Access
identity its own for good (the second is `JOHNSMI2`), and locks, SEND and
live pushes stay apart. Without sessions, record who did something with
`ctx.uid` (the email, or a service token's client ID) rather than `ctx.user`.

## Over SSH

`greenscreen serve-ssh` serves the same terminal to anyone with an SSH
client, so people can sign on from a terminal with nothing installed:

```sh
CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… \
  greenscreen serve-ssh -api https://pos.example.com -listen :2222 -users ./users
ssh -p 2222 pos.example.com
```

A Worker can't take SSH connections, so this runs on a machine of your own
(a VM, a container, a store's back-office box). People sign on with their
SSH keys: the users file has a line for each key, an email and the key as
`authorized_keys` writes it, and is read again whenever it changes.

```text
john.smith@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… john@laptop
ann@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… ann@desk
```

The server goes through Access with its own service token and names each
person in the `Greenscreen-User` header. The Worker takes that only from a
gateway it trusts, by wrapping its `auth` in `gatewayAuth`:

```ts
createApp<Env>({
	...
	auth: gatewayAuth(accessAuth(), (env) => [env.SSH_GATEWAY]), // the gateway's service token client ID
});
```

The person is then the same identity Access would give them, their email,
so their userid, locks and messages follow them between SSH and a browser.
The gateway's token alone signs on no one, and a request from anyone else
that names a user is refused. Under `wrangler dev` the gateway is
`DEV_USER`. The host key is made on first run (`-host-key`, by default in
your config directory). Files the host sends, snapshots and the PRINT key
are off over SSH, since they would land on the server.

## Releasing

Bump the version in `packages/worker`, `packages/web` and `packages/create`
(and the template's dependencies), then push a matching tag, e.g. `v0.2.0`,
or run the Release workflow by hand on main, which tags it once it's
published. A run that fails part way through can be run again: it skips
packages already on npm at that version. The Release workflow tests and publishes the packages on npm
through trusted publishing (OIDC), so there is no npm token. Each package
lists `sdf1jpf/greenscreen` and `release.yml` as its trusted publisher. The Go terminal is released by the same tag:
`go install github.com/sdf1jpf/greenscreen/cmd/greenscreen@v0.2.0`.

## License

MIT

## Developing

```sh
npm install
npm test
go test ./...
```
