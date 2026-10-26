// Package api is the terminal's client for a Greenscreen application, as
// served by @greenscreen/worker.
//
//	GET    /v1/health
//	GET    /v1/screen/info  what the application calls itself; no logon
//	POST   /v1/session      logon: -> {"userid"}
//	POST   /v1/screen       the application's screens; see docs/protocol.md
//
// The terminal reaches the application's data only through the screens.
// Everything except health and info is behind Cloudflare Access (see
// access.go). Errors are returned as
// {"error":{"code","message","field"}}.
package api

import "errors"

var (
	ErrUnauthorized = errors.New("not logged on or session expired")
	ErrBadLogon     = errors.New("not authorized by Cloudflare Access")
	ErrUnavailable  = errors.New("host not responding")
)

// Wire types and error codes; keep in step with packages/worker.

type LogonResponse struct {
	UserID string `json:"userid"`
}

// ScreenVersion is the screen protocol version this client speaks.
const ScreenVersion = 1

// ScreenRequest is sent when an AID key is pressed, or with AID "START"
// for the first screen, "REDRAW" for a new window size and "TIMEOUT" when
// the terminal has been left idle too long.
type ScreenRequest struct {
	V        int               `json:"v"`
	AID      string            `json:"aid"`
	State    string            `json:"state,omitempty"`
	Fields   map[string]string `json:"fields"`
	Modified []string          `json:"modified"`
	Cursor   Cursor            `json:"cursor"`
	Rows     int               `json:"rows"`
	Cols     int               `json:"cols"`
	Terminal string            `json:"terminal,omitempty"`
	System   string            `json:"system,omitempty"`
	TZOffset int               `json:"tz_offset"`
}

// ScreenResponse holds the next screen and the commarea to send back with
// the next request, or Logoff when the operator has logged off.
type ScreenResponse struct {
	V      int     `json:"v"`
	State  string  `json:"state"`
	Screen *Screen `json:"screen"`
	Logoff *struct {
		Message string `json:"message"`
	} `json:"logoff"`
}

type Screen struct {
	Map    string  `json:"map"`
	Rows   int     `json:"rows"`
	Cols   int     `json:"cols"`
	Fields []Field `json:"fields"`
	Cursor *Cursor `json:"cursor"`
	// Refresh, in seconds, asks the client to redraw the screen this often
	// while the operator leaves it alone. Zero never does.
	Refresh int `json:"refresh"`
}

// Field is an output field (Text) or, when Name is set, an input field of
// Length characters prefilled with Value.
type Field struct {
	Row       int    `json:"row"`
	Col       int    `json:"col"`
	Text      string `json:"text"`
	Name      string `json:"name"`
	Length    int    `json:"length"`
	Value     string `json:"value"`
	Color     string `json:"color"`
	Bright    bool   `json:"bright"`
	Highlight string `json:"highlight"`
	Hidden    bool   `json:"hidden"`
	Numeric   bool   `json:"numeric"`
	Mixed     bool   `json:"mixed"`
	// Modified starts the field with its modified data tag set, so it is
	// sent back as typed: input kept across help, a picked value, or a
	// retrieved command.
	Modified bool `json:"modified"`
}

// Cursor is a position, 1-based, and the input field it is in, if any.
type Cursor struct {
	Row   int    `json:"row,omitempty"`
	Col   int    `json:"col,omitempty"`
	Field string `json:"field,omitempty"`
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`
}

// Error codes used on the wire.
const codeUnauthorized = "unauthorized"

// AppInfo is GET /v1/screen/info: what the application calls itself, for
// the logon screen and the client's own messages.
type AppInfo struct {
	V      int      `json:"v"`
	Title  string   `json:"title"`
	System string   `json:"system"`
	Prefix string   `json:"prefix"`
	Banner []string `json:"banner"`
}
