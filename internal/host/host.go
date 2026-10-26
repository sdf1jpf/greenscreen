// Package host connects the terminal to a Greenscreen application. The
// application's screens come from its API (see docs/protocol.md): this package sends each AID key with the
// screen's input and draws the screen that comes back. Only the logon
// screen, which signs in through Cloudflare Access, is drawn locally.
package host

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/sdf1jpf/greenscreen/internal/api"
	t3 "github.com/sdf1jpf/greenscreen/tn3270"
)

// Backend is the API the session talks to. *api.Client implements it.
type Backend interface {
	Host() string
	Logon(ctx context.Context) (string, error)
	Logoff(ctx context.Context) error
	Screen(ctx context.Context, req api.ScreenRequest) (api.ScreenResponse, error)
}

type Config struct {
	SystemName string // e.g. "SYS1"
	Title      string // the application's name on the logon screen, e.g. "POINT OF SALE"
	Prefix     string // starts the terminal's own message IDs, e.g. "POS"; default "GSC"
	Banner     []string
	Backend    Backend
}

// msg builds one of the terminal's own message IDs: msg("0298E").
func (s *Session) msg(id string) string {
	p := s.cfg.Prefix
	if p == "" {
		p = "GSC"
	}
	return p + id
}

// Session is the terminal's connection to the application. It implements
// tn3270.Host.
type Session struct {
	cfg   *Config
	lu    string
	user  string
	logon *logon // the local logon screen, while it is showing
	state string // the commarea from the last screen

	rows, cols int // size of the terminal's presentation space
}

func NewSession(cfg *Config, lu string) *Session {
	return &Session{cfg: cfg, lu: lu, logon: &logon{}, rows: t3.MinRows, cols: t3.MinCols}
}

func (s *Session) Start() *t3.Screen { return s.logon.Render(s) }

// Redraw asks the application for the current screen at the terminal's
// new size. It returns nil, keeping the old layout, if that fails.
func (s *Session) Redraw(rows, cols int) *t3.Screen {
	s.rows, s.cols = max(rows, t3.MinRows), max(cols, t3.MinCols)
	if s.logon != nil {
		return s.logon.Render(s)
	}
	resp, err := s.api().Screen(s.ctx(), s.request("REDRAW", nil))
	if err != nil || resp.Screen == nil {
		return nil
	}
	s.state = resp.State
	return build(resp.Screen)
}

func (s *Session) Submit(aid t3.AID, scr *t3.Screen) *t3.Screen {
	if s.logon != nil && aid == t3.AIDTimeout {
		return scr.Clone() // not logged on: nothing to time out
	}
	if s.logon != nil {
		return s.submitLogon(aid, scr)
	}
	resp, err := s.api().Screen(s.ctx(), s.request(aid.String(), scr))
	switch {
	case errors.Is(err, api.ErrUnauthorized):
		return s.toLogon("IKJ56400I SESSION EXPIRED OR ENDED BY THE HOST - PLEASE LOG ON AGAIN")
	case err != nil:
		// Keep the screen and what was typed, so Enter can try again.
		return withMessage(scr, s.fail(err))
	case resp.Logoff != nil:
		s.api().Logoff(s.ctx())
		return s.toLogon(resp.Logoff.Message)
	case resp.Screen == nil:
		return withMessage(scr, s.msg("0299E")+" NO SCREEN IN THE HOST'S REPLY")
	}
	s.state = resp.State
	return build(resp.Screen)
}

// start fetches the application's first screen after logon.
func (s *Session) start() *t3.Screen {
	s.logon, s.state = nil, ""
	resp, err := s.api().Screen(s.ctx(), s.request("START", nil))
	if err == nil && resp.Screen == nil {
		err = errors.New("no screen in the host's reply")
	}
	if err != nil {
		s.api().Logoff(s.ctx())
		if errors.Is(err, api.ErrUnauthorized) {
			return s.toLogon("IKJ56421I LOGON NOT AUTHORIZED BY CLOUDFLARE ACCESS")
		}
		return s.toLogon(s.fail(err))
	}
	s.state = resp.State
	return build(resp.Screen)
}

func (s *Session) toLogon(msg string) *t3.Screen {
	s.user, s.state = "", ""
	s.logon = &logon{msg: msg}
	return s.logon.Render(s)
}

// request describes the screen as the operator left it: every input field,
// which ones were changed, and where the cursor is.
func (s *Session) request(aid string, scr *t3.Screen) api.ScreenRequest {
	_, off := time.Now().Zone()
	req := api.ScreenRequest{
		AID: aid, State: s.state, Fields: map[string]string{}, Modified: []string{},
		Rows: s.rows, Cols: s.cols, Terminal: s.lu, System: s.cfg.SystemName, TZOffset: off / 60,
	}
	if scr != nil {
		req.Fields = scr.Fields()
		for name := range scr.Modified() {
			req.Modified = append(req.Modified, name)
		}
		row, col := scr.RowCol(scr.Cursor())
		req.Cursor = api.Cursor{Row: row, Col: col, Field: scr.FieldName(scr.Cursor())}
	}
	return req
}

func (s *Session) api() Backend { return s.cfg.Backend }

func (s *Session) ctx() context.Context { return context.Background() }

// fail turns an API error into a message for the message line.
func (s *Session) fail(err error) string {
	if errors.Is(err, api.ErrUnavailable) {
		return s.msg("0298E") + " HOST " + strings.ToUpper(s.api().Host()) + " NOT RESPONDING - PRESS ENTER TO RETRY"
	}
	return s.msg("0299E") + " " + strings.ToUpper(strings.TrimPrefix(err.Error(), "api: "))
}

var colors = map[string]t3.Color{
	"blue": t3.Blue, "red": t3.Red, "pink": t3.Pink, "green": t3.Green,
	"turquoise": t3.Turquoise, "yellow": t3.Yellow, "white": t3.White,
}

// build draws a screen sent by the application.
func build(in *api.Screen) *t3.Screen {
	scr := t3.NewScreenSize(in.Rows, in.Cols)
	for _, f := range in.Fields {
		opts := []t3.Opt{t3.WithColor(colors[f.Color])}
		if f.Bright {
			opts = append(opts, t3.Bright)
		}
		if f.Hidden {
			opts = append(opts, t3.Hidden)
		}
		if f.Numeric {
			opts = append(opts, t3.Numeric)
		}
		if f.Mixed {
			opts = append(opts, t3.MixedCase)
		}
		if f.Modified {
			opts = append(opts, t3.Modified)
		}
		switch f.Highlight {
		case "none":
			opts = append(opts, t3.NoUnderline)
		case "underscore":
			opts = append(opts, t3.Underline)
		case "reverse":
			opts = append(opts, t3.Reverse)
		case "blink":
			opts = append(opts, t3.Blink)
		}
		if f.Name != "" {
			scr.Input(f.Row, f.Col, f.Length, f.Name, f.Value, opts...)
		} else {
			scr.Text(f.Row, f.Col, f.Text, opts...)
		}
	}
	switch c := in.Cursor; {
	case c == nil:
		scr.CursorHome()
	case c.Field != "":
		if !scr.CursorTo(c.Field) {
			scr.CursorHome()
		}
	default:
		scr.SetCursor(c.Row, c.Col)
	}
	if in.Refresh > 0 {
		scr.SetRefresh(time.Duration(in.Refresh) * time.Second)
	}
	return scr
}

// withMessage returns a copy of scr, input and all, with msg on the
// message line, for errors the application could not report itself.
func withMessage(scr *t3.Screen, msg string) *t3.Screen {
	out := scr.Clone()
	message(out, msg)
	return out
}

// message draws the message line, the second to last row. The severity is
// taken from the last letter of the message ID, IBM style: E=error,
// W=warning, I=info.
func message(scr *t3.Screen, msg string) {
	if msg == "" {
		return
	}
	color := t3.White
	id, _, _ := strings.Cut(msg, " ")
	switch id[len(id)-1] {
	case 'E':
		color = t3.Red
	case 'W':
		color = t3.Yellow
	}
	n := scr.Cols() - 2
	if len(msg) > n {
		msg = msg[:n]
	}
	scr.Text(scr.Rows()-1, 2, msg+strings.Repeat(" ", n-len(msg)), t3.WithColor(color), t3.Bright)
}
