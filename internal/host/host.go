// Package host connects the terminal to a Greenscreen application. The
// application's screens come from its API (see docs/protocol.md): this
// package sends each AID key with the
// screen's input and draws the screen that comes back. Only the logon
// screen, which signs in through Cloudflare Access, is drawn locally.
package host

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

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

// Downloader is a Backend that can fetch the files screens send along,
// such as an invoice PDF. *api.Client implements it.
type Downloader interface {
	Download(ctx context.Context, path string) ([]byte, error)
}

// Listener is a Backend that can push: see api.Client.Listen.
type Listener interface {
	Listen(ctx context.Context, opened func(), on func(event string)) error
}

// liveFallback is how often a live screen is still redrawn while pushes
// are arriving, in case one is missed.
const liveFallback = time.Minute

// reconnect bounds the wait before listening again after the connection drops.
const (
	reconnectMin = time.Second
	reconnectMax = time.Minute
)

// SnapshotTaker is a Backend that can draw a screen as a picture.
// *api.Client implements it.
type SnapshotTaker interface {
	Snapshot(ctx context.Context, req api.SnapshotRequest) ([]byte, string, error)
}

type Config struct {
	SystemName  string // e.g. "SYS1"
	Title       string // the application's name on the logon screen, e.g. "POINT OF SALE"
	Tagline     string // shown there instead of the title, if set
	Prefix      string // starts the terminal's own message IDs, e.g. "POS"; default "GSC"
	Banner      []string
	Backend     Backend
	DownloadDir string   // where files sent with a screen are saved; empty, none are
	SignOn      []string // how Enter signs on, two lines for the logon screen; default Cloudflare Access's
	Live        bool     // the application serves GET /v1/live
	Snapshots   bool     // the application serves POST /v1/snapshot
	HaveInfo    bool     // the above came from the application (SetInfo)
}

// Informer is a Backend that can say what the application calls itself and
// what it serves: GET /v1/screen/info. *api.Client implements it.
type Informer interface {
	Info(ctx context.Context) (api.AppInfo, error)
}

// SetInfo takes what the application says about itself. The system name
// is only taken if none was given.
func (c *Config) SetInfo(info api.AppInfo) {
	c.Title, c.Prefix, c.Banner, c.Tagline = info.Title, info.Prefix, info.Banner, info.Tagline
	c.Live, c.Snapshots = info.Live, info.Snapshot
	if c.SystemName == "" {
		c.SystemName = info.System
	}
	c.HaveInfo = true
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

	push   chan struct{} // tells the terminal to redraw; see Pushes
	mu     sync.Mutex    // guards the fields below, shared with the listener
	live   string        // what the current screen shows that pushes announce
	mapID  string        // the current screen's map, for naming snapshots
	on     bool          // past the logon screen; Snapshot runs on its own goroutine
	listen bool          // connected to GET /v1/live
	stop   context.CancelFunc
}

func NewSession(cfg *Config, lu string) *Session {
	return &Session{cfg: cfg, lu: lu, logon: &logon{}, rows: t3.MinRows, cols: t3.MinCols, push: make(chan struct{}, 1)}
}

// Pushes implements tn3270.Pusher: a value comes when the host has said
// the screen should be redrawn.
func (s *Session) Pushes() <-chan struct{} { return s.push }

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
	return s.show(resp.Screen)
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
	next := s.show(resp.Screen)
	if resp.Download != nil {
		message(next, s.save(resp.Download))
	}
	return next
}

// save fetches a file the application sent with a screen into the
// download directory and returns the message to show for it.
func (s *Session) save(d *api.Download) string {
	dl, ok := s.api().(Downloader)
	if !ok || s.cfg.DownloadDir == "" {
		return s.msg("1508W") + " THIS TERMINAL CANNOT RECEIVE FILES"
	}
	if !strings.HasPrefix(d.URL, "/v1/") {
		return s.msg("1509E") + " BAD FILE LOCATION FROM THE HOST"
	}
	b, err := dl.Download(s.ctx(), d.URL)
	if err != nil {
		return strings.Replace(s.fail(err), s.msg("0299E"), s.msg("1509E"), 1)
	}
	path, err := writeNew(s.cfg.DownloadDir, d.Name, b)
	if err != nil {
		return s.msg("1509E") + " " + strings.ToUpper(err.Error())
	}
	return s.msg("1507I") + " SAVED " + path
}

// Snapshot implements tn3270.Snapshotter: the application draws the screen
// as it shows, typed input included, and the file goes in the download
// directory.
func (s *Session) Snapshot(scr *t3.Screen, format string) (string, error) {
	st, ok := s.api().(SnapshotTaker)
	if !ok || !s.cfg.Snapshots || s.cfg.DownloadDir == "" {
		return "", errors.New("this terminal cannot take snapshots")
	}
	s.mu.Lock()
	m, on := s.mapID, s.on
	s.mu.Unlock()
	if !on {
		return "", errors.New("not logged on")
	}
	row, col := scr.RowCol(scr.Cursor())
	req := api.SnapshotRequest{
		Format: format, Map: m, Terminal: s.lu,
		Screen: api.SnapshotScreen{Rows: scr.Rows(), Cols: scr.Cols(), Fields: []api.SnapField{}, Cursor: &api.Cursor{Row: row, Col: col}},
	}
	for _, a := range scr.Areas() {
		req.Screen.Fields = append(req.Screen.Fields, api.SnapField{
			Row: a.Row, Col: a.Col, Text: a.Text, Color: colorNames[a.Attr.Color], Bright: a.Attr.Intense,
			Highlight: highlightNames[a.Attr.Highlight], Hidden: a.Attr.Hidden, Input: !a.Attr.Protected,
		})
	}
	b, name, err := st.Snapshot(s.ctx(), req)
	if err != nil {
		return "", err
	}
	if name == "" {
		name = "SNAPSHOT." + format
	}
	return writeNew(s.cfg.DownloadDir, name, b)
}

var colorNames = map[t3.Color]string{
	t3.Blue: "blue", t3.Red: "red", t3.Pink: "pink", t3.Green: "green",
	t3.Turquoise: "turquoise", t3.Yellow: "yellow", t3.White: "white",
}

var highlightNames = map[t3.Highlight]string{t3.HlUnderscore: "underscore", t3.HlReverse: "reverse", t3.HlBlink: "blink"}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// writeNew writes a new file in dir, adding -2, -3 and so on to the name if
// it is taken, and returns its path.
func writeNew(dir, name string, b []byte) (string, error) {
	name = unsafeName.ReplaceAllString(filepath.Base(name), "_")
	if name == "" || name == "." || name == ".." {
		name = "DOWNLOAD"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	path := filepath.Join(dir, name)
	for n := 2; ; n++ {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if errors.Is(err, os.ErrExist) {
			path = filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, n, ext))
			continue
		}
		if err != nil {
			return "", err
		}
		_, err = f.Write(b)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		return path, err
	}
}

// start fetches the application's first screen after logon.
func (s *Session) start() *t3.Screen {
	s.logon, s.state = nil, ""
	s.mu.Lock()
	s.on = true
	s.mu.Unlock()
	resp, err := s.api().Screen(s.ctx(), s.request("START", nil))
	if err == nil && resp.Logoff != nil {
		// The application turned the user away (not on its user file, say):
		// say why on the logon screen.
		s.api().Logoff(s.ctx())
		return s.toLogon(resp.Logoff.Message)
	}
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
	return s.show(resp.Screen)
}

func (s *Session) toLogon(msg string) *t3.Screen {
	s.stopListening()
	s.user, s.state = "", ""
	s.logon = &logon{msg: msg}
	s.mu.Lock()
	s.on = false
	s.mu.Unlock()
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
	s.mu.Lock()
	req.Live = s.listen
	s.mu.Unlock()
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

// show builds a screen from the application and notes what pushes it
// listens for. While pushes arrive, its refresh timer is only a fallback.
func (s *Session) show(in *api.Screen) *t3.Screen {
	scr := build(in)
	s.mu.Lock()
	s.live = in.Live
	s.mapID = in.Map
	listening := s.listen
	s.mu.Unlock()
	if in.Live != "" && listening && in.Refresh > 0 {
		scr.SetRefresh(max(time.Duration(in.Refresh)*time.Second, liveFallback))
	}
	s.startListening()
	return scr
}

// startListening connects to GET /v1/live, if the backend can, and keeps
// reconnecting until the session logs off.
func (s *Session) startListening() {
	l, ok := s.api().(Listener)
	s.mu.Lock()
	defer s.mu.Unlock()
	if !ok || !s.cfg.Live || s.stop != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.stop = cancel
	go func() {
		wait := reconnectMin
		for ctx.Err() == nil {
			err := l.Listen(ctx, func() {
				wait = reconnectMin
				s.setListening(true)
			}, s.event)
			s.setListening(false)
			if errors.Is(err, api.ErrUnauthorized) {
				return
			}
			select {
			case <-ctx.Done():
			case <-time.After(wait):
			}
			wait = min(wait*2, reconnectMax)
		}
	}()
}

// Close stops the session's connection to GET /v1/live, for a host that
// outlives its terminals (an SSH server's).
func (s *Session) Close() { s.stopListening() }

func (s *Session) stopListening() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stop != nil {
		s.stop()
		s.stop = nil
	}
	s.listen, s.live = false, ""
}

func (s *Session) setListening(on bool) {
	s.mu.Lock()
	s.listen = on
	s.mu.Unlock()
}

// event passes a push on to the terminal when it concerns the screen: a
// message is for any screen, anything else only for a screen live on it.
func (s *Session) event(name string) {
	s.mu.Lock()
	live := s.live
	s.mu.Unlock()
	if name != "message" && name != live {
		return
	}
	select {
	case s.push <- struct{}{}:
	default: // one is already waiting
	}
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
	if r := []rune(msg); len(r) > n {
		msg = string(r[:n]) // by character: a message can carry what was typed
	}
	scr.Text(scr.Rows()-1, 2, msg+strings.Repeat(" ", n-utf8.RuneCountInString(msg)), t3.WithColor(color), t3.Bright)
}
