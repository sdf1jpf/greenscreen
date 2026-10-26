# @greenscreen/worker

Serve 3270-style green screens from a Cloudflare Worker. Panels are
pseudo-conversational programs: `render` turns a state into a screen,
`handle` turns a state plus the operator's AID key and input into the next
state, and the state travels in a signed commarea, so the Worker keeps no
session.

```sh
npm create greenscreen@latest my-app
```

or add it to a Worker: `npm install @greenscreen/worker hono`.

See the [repository](https://github.com/sdf1jpf/greenscreen) for a tour,
the point-of-sale example and the screen protocol.
