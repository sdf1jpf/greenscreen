# @greenscreen-dev/web

The 3270 terminal in a browser page: it draws the screens a Greenscreen
Worker sends from `POST /v1/screen`, edits them locally, and sends the
modified fields back on an AID key. Same keys as the Go terminal, plus an
on-screen key bar for touch screens.

Serve `public/` from the same origin as the API. With Workers static
assets, point `assets.directory` at it in `wrangler.jsonc`:

```jsonc
{
  "main": "src/index.ts",
  "assets": { "directory": "node_modules/@greenscreen-dev/web/public" }
}
```

Requests for files in `public/` are answered from assets; everything else
(`/v1/...`) reaches the Worker. Behind Cloudflare Access the page signs on
with the Access cookie, and an expired session reloads to sign on again.

The page titles itself from `GET /v1/screen/info` and shows the app's system
name in the status line. Add `?lu=TILL01` to the URL to name the terminal. Add `?glow` for the CRT look, phosphor glow and scan lines; the default is crisp text.

Browsers keep some F-keys for themselves, so Esc then a digit is a PF key
too: Esc 1 to Esc 9, Esc 0 for PF10, Esc - and Esc = for PF11 and PF12.
Ctrl+P saves the screen as a text file (a 3270 print), and Ctrl+S as a
picture when the app serves snapshots.

On a phone or tablet, tap the screen to bring up the on-screen keyboard:
the tap also moves the cursor there, and the key bar gives the AID keys.
A screen reader hears each new screen's heading and message line.

The key bar's HIDE key (or Alt+K) folds it away to a single KEYS key that
brings it back; the browser remembers the choice. Add `?keys=hide` or
`?keys=show` to the URL to set it regardless, for a register or a kiosk.

`public/protocol.js` and `public/screen.js` have no DOM dependencies and can
be imported on their own (`@greenscreen-dev/web/protocol.js`, `/screen.js`).
