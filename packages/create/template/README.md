# __NAME__

A Greenscreen app: 3270-style screens served by a Cloudflare Worker.

```sh
npm install
npm run dev      # http://localhost:8787, signed on as OPERATOR
npm test
```

The screens are panels in `src/index.ts`. To use the Go terminal instead of
the browser: `go run github.com/sdf1jpf/greenscreen/cmd/greenscreen@latest -api http://localhost:8787`.

Before `npm run deploy`, set a `STATE_KEY` secret (`wrangler secret put
STATE_KEY`) and put the Worker behind Cloudflare Access, with a Bypass
policy on `/v1/screen/info` and `/v1/health`. See
https://github.com/sdf1jpf/greenscreen for the protocol and a larger
example.
