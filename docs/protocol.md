# Screen protocol (v1)

The Worker owns the application's screens. A client (the Go terminal, or a
browser page) is a generic 3270 display: it draws the fields it is sent,
lets the operator edit the input fields locally, and when the operator
presses an AID key (Enter, Clear, a PA or PF key) it sends the key, the
input fields and the cursor position back. The Worker replies with the next
screen. This is how a 3270 talks to a CICS transaction, so new screens ship
with a Worker deploy and no client changes.

There are no sessions on the server. Each reply carries `state`, an opaque
string (the "commarea") that the client must send back unchanged with the
next request. It records which panel is showing and what it needs to carry
on: a filter, a scroll position, the record being edited. The Worker never
trusts it for anything the caller could not do anyway, unless it is
signed (see [Commarea](#commarea)): every request is signed on by itself,
through Cloudflare Access by default.

## Request

`POST /v1/screen`, signed on like every endpoint but health and info.

```json
{
  "v": 1,
  "aid": "ENTER",
  "state": "…from the last response…",
  "fields": { "filter": "ACME", "sel:000101": "" },
  "modified": ["filter"],
  "cursor": { "row": 4, "col": 27, "field": "filter" },
  "rows": 24,
  "cols": 80,
  "terminal": "TERM0001",
  "system": "SYS1",
  "tz_offset": -240
}
```

| Key | Meaning |
| --- | --- |
| `v` | Protocol version, 1. |
| `aid` | The key: `ENTER`, `CLEAR`, `PA1`-`PA3`, `PF1`-`PF24`. Three more are not keys: `START` asks for the first screen after logon (send no `state`), `REDRAW` asks for the current screen again at a new `rows`/`cols`, without acting on any input, and `TIMEOUT` says the operator has left the terminal idle too long: the reply is always a logoff. |
| `state` | The `state` string from the previous response. Leave it out on `START`. |
| `fields` | Every named input field on the screen, as the operator left it: nulls removed and trailing blanks trimmed. |
| `modified` | Names of the input fields whose modified data tag is set (the operator typed in them). |
| `cursor` | 1-based row and column of the cursor, and the name of the input field it is in, or `""`. Field-level help (PF1 on a field) uses `field`. |
| `rows`, `cols` | Size of the presentation space. The Worker lays the screen out for it, no smaller than 24x80. |
| `terminal`, `system` | The terminal (LU) name and system name to show on screens. Optional. |
| `tz_offset` | The client's offset from UTC in minutes (east positive), so times show in local time. Optional, default 0. |

## Response

`200` with either a screen:

```json
{
  "v": 1,
  "state": "…",
  "screen": {
    "map": "POSM01",
    "rows": 24,
    "cols": 80,
    "fields": [
      { "row": 1, "col": 2, "text": "POSM01", "color": "blue" },
      { "row": 4, "col": 2, "text": "NAME STARTS WITH ===>", "color": "turquoise" },
      { "row": 4, "col": 24, "name": "filter", "length": 20, "value": "ACME" }
    ],
    "cursor": { "field": "filter" }
  }
}
```

or, when the operator logs off, `{"v": 1, "logoff": {"message": "IKJ56470I IBMUSER LOGGED OFF AT 11:23:06"}}`.
The client then goes back to its own logon screen and shows the message.

Errors use the API's usual envelope, `{"error": {"code", "message"}}`. A
`401` (or Access redirecting to its login page) means the sign-in has expired:
go back to the logon screen. If the API cannot be reached, keep the screen
and what the operator typed, show a message, and let Enter retry with the
same `state`.

### Fields

`fields` is applied in order to a cleared screen of `rows` x `cols`, the
way a BMS map is:

- A field starting at `row`/`col` has its attribute byte at the position
  just before it (column `col - 1`, wrapping to the previous row). The
  attribute position shows as a blank.
- After the field's data, a protected attribute (a "stopper") is placed
  unless another field already starts there.
- Everything outside a field is protected and blank.

A field with `text` is protected output. A field with `name` and `length`
is an unprotected input field, prefilled with `value`.

| Key | Applies to | Values (default first) |
| --- | --- | --- |
| `row`, `col` | all | 1-based position of the first data character. |
| `text` | output | The text. |
| `name`, `length`, `value` | input | Field name sent back in `fields`; length in characters; initial contents. |
| `color` | all | `default`, `blue`, `red`, `pink`, `green`, `turquoise`, `yellow`, `white`. |
| `bright` | all | `false`, `true`: high intensity. |
| `highlight` | all | `none` for output and `underscore` for input; also `reverse`, `blink`. |
| `hidden` | all | `false`, `true`: non-display, e.g. a password. |
| `numeric` | input | `false`, `true`: only digits may be typed. |
| `mixed` | input | `false`, `true`: keep lower case. Otherwise the client folds typed letters to upper case. |
| `modified` | input | `false`, `true`: start with the modified data tag set, so the field is sent back in `modified` as if typed. The Worker uses it to put back what the operator typed before PF1, a value picked from a help list, and a retrieved command. |

Keys at their default are left out. With color `default` the 3270 base
colors apply: protected is blue, protected and bright is white, input is
green, input and bright is red.

### Refresh

A screen that shows live data, such as the operator console, can carry
`"refresh": 5` next to `cursor`: the client should send `REDRAW` every that
many seconds while the operator leaves the screen alone. It waits another
interval instead while the keyboard is locked or any input field has been
typed in, so a refresh never takes what the operator is typing. Absent or 0
means never.

### Cursor

`cursor` is `{"field": name}` (the first position of that input field),
`{"row", "col"}`, or absent (the first input field, as the Home key does).

## App info

`GET /v1/screen/info` is not signed on. It tells a generic client what to
call the application on its logon screen and status line:

```json
{ "v": 1, "title": "POINT OF SALE", "system": "POS1", "prefix": "POS", "banner": ["STORE 0042"] }
```

`prefix` starts the message IDs the server sends (`POS0001W`); clients use
it for their own messages too, such as "host not responding". `banner` is
optional. A client that gets a 404 here falls back to its own defaults.

## Commarea

`state` is opaque to clients. A server may sign it (`@greenscreen/worker`
does when given a `stateKey`: base64url JSON, a dot, an HMAC-SHA256), and
then a state that was changed on the way is treated like a lost one: the
reply is the first screen with a `xxx0001W` warning. Unsigned states are
plain JSON, and panels must not trust them for anything the operator
could not do anyway.

## Versions

`v` is the major version, 1. Changes that old clients can ignore, like a
new optional key, stay in v1. A breaking change becomes v2, and a server
will answer both for at least one release.

## Conventions for screens

These keep the panels consistent; they are not enforced by the protocol.

- Rows 1 and 2 are the heading: map name at the left, title centered, date
  and time at the right edge.
- The second to last row is the message line. Message IDs end in a severity
  letter, IBM style (`E` error in red, `W` warning in yellow, `I` info in white).
- The last row is the PF key legend, in turquoise.
- Screens wider or taller than 24x80 keep right-hand fields at the right edge
  and give extra rows to lists.
- PF1 is help on every screen. PF3 goes back, PF12 cancels, PF7/PF8 scroll.
- PF1 with the cursor in a field explains that field. A field with a set of
  valid values lists them under its help, ISPF prompt style: S beside one
  goes back with it in the field. Whatever the operator had typed on the
  screen is put back on return.
- PF24 is RETRIEVE on a panel with a command line (the menus' OPTION and the
  console's command): it puts the last command back, and again for the one
  before. The history travels in the commarea.

## Session

The clients keep a few things to themselves:

- The status line (OIA) shows the system name and the time of day next to
  the terminal name.
- A terminal left without a key pressed for 30 minutes sends `TIMEOUT`, and
  the Worker logs the session off (an S522 in TSO terms, reported to the
  app's `onEvent` hook). The Go client's `-idle` flag changes the limit; 0 turns
  it off.

## In the Worker

With `@greenscreen/worker`, each panel is a `Program` with a `render`
(state to screen) and a `handle` (state plus AID and input to the next
state), registered with `createApp` under the name in its state's `p`.
The package provides the menu (`menuProgram`), help and field prompts
(`helpTable`), PF24 RETRIEVE, the idle timeout and the commarea.
