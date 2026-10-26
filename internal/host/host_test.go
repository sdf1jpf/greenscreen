package host

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sdf1jpf/greenscreen/internal/api"
	t3 "github.com/sdf1jpf/greenscreen/tn3270"
)

// fakeAPI stands in for the Worker. It records each screen request and
// answers with a screen that echoes it, or with err.
type fakeAPI struct {
	denied   bool  // Access refuses the logon
	err      error // returned by the next Screen calls
	logoff   bool  // answer the next request with a logoff
	reqs     []api.ScreenRequest
	loggedOn bool
}

func (f *fakeAPI) Host() string { return "fake:1" }

func (f *fakeAPI) Logon(context.Context) (string, error) {
	if f.denied {
		return "", api.ErrBadLogon
	}
	f.loggedOn = true
	return "IBMUSER", nil
}

func (f *fakeAPI) Logoff(context.Context) error {
	f.loggedOn = false
	return nil
}

func (f *fakeAPI) Screen(_ context.Context, req api.ScreenRequest) (api.ScreenResponse, error) {
	f.reqs = append(f.reqs, req)
	if f.err != nil {
		return api.ScreenResponse{}, f.err
	}
	if f.logoff {
		resp := api.ScreenResponse{V: 1}
		resp.Logoff = &struct {
			Message string `json:"message"`
		}{"IKJ56470I IBMUSER LOGGED OFF AT 11:00:00"}
		return resp, nil
	}
	n := len(f.reqs)
	return api.ScreenResponse{V: 1, State: "s" + string(rune('0'+n)), Screen: &api.Screen{
		Map: "TEST", Rows: req.Rows, Cols: req.Cols,
		Fields: []api.Field{
			{Row: 1, Col: 2, Text: req.AID + " " + req.Fields["opt"], Color: "blue"},
			{Row: 4, Col: 14, Name: "opt", Length: 10},
			{Row: 5, Col: 14, Name: "pw", Length: 8, Hidden: true, Numeric: true, Bright: true},
			{Row: req.Rows, Col: 2, Text: "PF3=EXIT", Color: "turquoise"},
		},
		Cursor: &api.Cursor{Field: "opt"},
	}}, nil
}

func (f *fakeAPI) last() api.ScreenRequest { return f.reqs[len(f.reqs)-1] }

func newSession(t *testing.T) (*Session, *fakeAPI, *t3.Screen) {
	t.Helper()
	f := &fakeAPI{}
	s := NewSession(&Config{SystemName: "TEST", Backend: f}, "TERM0001")
	return s, f, s.Start()
}

// fill types values into named fields, like an operator would.
func fill(t *testing.T, scr *t3.Screen, kv ...string) {
	t.Helper()
	for i := 0; i < len(kv); i += 2 {
		if !scr.CursorTo(kv[i]) {
			t.Fatalf("no field %q", kv[i])
		}
		scr.EraseEOF()
		for _, r := range kv[i+1] {
			if l := scr.Type(r, false); l != t3.LockNone {
				t.Fatalf("field %s: %v", kv[i], l)
			}
		}
	}
}

func login(t *testing.T) (*Session, *fakeAPI, *t3.Screen) {
	t.Helper()
	s, f, scr := newSession(t)
	scr = s.Submit(t3.AIDEnter, scr)
	if s.logon != nil || len(f.reqs) != 1 {
		t.Fatalf("not logged on: %+v", s.logon)
	}
	return s, f, scr
}

func TestLogonStartsTheApplication(t *testing.T) {
	_, f, scr := login(t)
	req := f.reqs[0]
	if req.AID != "START" || req.State != "" || req.Rows != 24 || req.Cols != 80 ||
		req.Terminal != "TERM0001" || req.System != "TEST" {
		t.Fatalf("start request: %+v", req)
	}
	if !strings.Contains(scr.Row(1), "START") || !strings.Contains(scr.Row(24), "PF3=EXIT") {
		t.Fatalf("screen not drawn:\n%s\n%s", scr.Row(1), scr.Row(24))
	}
	if scr.FieldName(scr.Cursor()) != "opt" {
		t.Fatal("cursor not placed in the named field")
	}
}

func TestSubmitSendsInputAndCommarea(t *testing.T) {
	s, f, scr := login(t)
	fill(t, scr, "opt", "abc")
	scr = s.Submit(t3.PF(5), scr)
	req := f.last()
	if req.AID != "PF5" || req.State != "s1" || req.Fields["opt"] != "ABC" || req.Fields["pw"] != "" ||
		len(req.Modified) != 1 || req.Modified[0] != "opt" || req.Cursor.Field != "opt" || req.Cursor.Row != 4 {
		t.Fatalf("request: %+v", req)
	}
	if !strings.Contains(scr.Row(1), "PF5 ABC") {
		t.Fatalf("reply not drawn: %q", scr.Row(1))
	}
	s.Submit(t3.AIDEnter, scr)
	if f.last().State != "s2" {
		t.Fatalf("commarea not round-tripped: %q", f.last().State)
	}
}

func TestFieldAttributes(t *testing.T) {
	_, _, scr := login(t)
	fill(t, scr, "pw", "12")
	if strings.Contains(scr.Row(5), "12") {
		t.Fatal("hidden field shown")
	}
	scr.CursorTo("pw")
	if l := scr.Type('x', false); l == t3.LockNone {
		t.Fatal("numeric field took a letter")
	}
}

func TestLogonRejectedByAccess(t *testing.T) {
	s, f, scr := newSession(t)
	f.denied = true
	scr = s.Submit(t3.AIDEnter, scr)
	if s.logon == nil || !strings.HasPrefix(s.logon.msg, "IKJ56421I") || len(f.reqs) != 0 {
		t.Fatalf("expected logon rejection, got %+v", s.logon)
	}
	if !strings.Contains(scr.Row(23), "IKJ56421I") {
		t.Fatalf("message not shown: %q", scr.Row(23))
	}
}

func TestHostDownAtLogon(t *testing.T) {
	s := NewSession(&Config{SystemName: "TEST", Backend: api.NewClient("http://127.0.0.1:1", nil)}, "TERM0001")
	s.Submit(t3.AIDEnter, s.Start())
	if s.logon == nil || !strings.HasPrefix(s.logon.msg, "GSC0298E") {
		t.Fatalf("expected host-down message, got %+v", s.logon)
	}
}

func TestHostDownKeepsScreenAndRetries(t *testing.T) {
	s, f, scr := login(t)
	fill(t, scr, "opt", "keep")
	f.err = api.ErrUnavailable
	got := s.Submit(t3.AIDEnter, scr)
	if s.logon != nil || got.Fields()["opt"] != "KEEP" || !got.Modified()["opt"] {
		t.Fatal("input lost when the host was down")
	}
	if !strings.Contains(got.Row(23), "GSC0298E HOST FAKE:1 NOT RESPONDING") {
		t.Fatalf("no host-down message: %q", got.Row(23))
	}
	if strings.Contains(scr.Row(23), "GSC0298E") {
		t.Fatal("the submitted screen was changed")
	}

	f.err = nil
	got = s.Submit(t3.AIDEnter, got)
	if req := f.last(); req.State != "s1" || req.Fields["opt"] != "KEEP" {
		t.Fatalf("retry sent %+v", req)
	}
	if !strings.Contains(got.Row(1), "ENTER KEEP") {
		t.Fatalf("retry not drawn: %q", got.Row(1))
	}
}

func TestExpiredSessionReturnsToLogon(t *testing.T) {
	s, f, scr := login(t)
	f.err = api.ErrUnauthorized
	scr = s.Submit(t3.AIDEnter, scr)
	if s.logon == nil || !strings.HasPrefix(s.logon.msg, "IKJ56400I") || s.user != "" || s.state != "" {
		t.Fatalf("expected logon with expiry message, got %+v", s.logon)
	}
	if !strings.Contains(scr.Row(23), "IKJ56400I") {
		t.Fatalf("message not shown: %q", scr.Row(23))
	}
}

func TestLogoffFromTheApplication(t *testing.T) {
	s, f, scr := login(t)
	f.logoff = true
	scr = s.Submit(t3.PF(3), scr)
	if s.logon == nil || !strings.HasPrefix(s.logon.msg, "IKJ56470I") || f.loggedOn {
		t.Fatalf("expected logon screen after logoff, got %+v", s.logon)
	}
	if s.Submit(t3.PF(3), scr) != nil {
		t.Fatal("PF3 on the logon screen should disconnect")
	}
}

func TestRedraw(t *testing.T) {
	s, f, _ := newSession(t)
	if scr := s.Redraw(40, 132); scr.Rows() != 40 || len(f.reqs) != 0 {
		t.Fatal("the logon screen should be laid out locally")
	}
	s.Submit(t3.AIDEnter, s.Start())
	if req := f.last(); req.Rows != 40 || req.Cols != 132 {
		t.Fatalf("start request not at the new size: %+v", req)
	}

	scr := s.Redraw(30, 100)
	if req := f.last(); req.AID != "REDRAW" || req.State != "s1" || req.Rows != 30 || req.Cols != 100 {
		t.Fatalf("redraw request: %+v", req)
	}
	if scr.Rows() != 30 || scr.Cols() != 100 || !strings.Contains(scr.Row(30), "PF3=EXIT") {
		t.Fatalf("redraw is %dx%d", scr.Rows(), scr.Cols())
	}

	f.err = api.ErrUnavailable
	if s.Redraw(24, 80) != nil {
		t.Fatal("a failed redraw should keep the old layout")
	}
}

func TestBuildCursor(t *testing.T) {
	in := &api.Screen{Rows: 24, Cols: 80, Fields: []api.Field{{Row: 3, Col: 5, Name: "a", Length: 2}}}
	if scr := build(in); scr.FieldName(scr.Cursor()) != "a" {
		t.Fatal("no cursor should mean the first input field")
	}
	in.Cursor = &api.Cursor{Row: 24, Col: 2}
	if r, c := build(in).RowCol(build(in).Cursor()); r != 24 || c != 2 {
		t.Fatalf("cursor at %d,%d", r, c)
	}
}

func TestBuildPresetsModifiedTag(t *testing.T) {
	in := &api.Screen{Rows: 24, Cols: 80, Fields: []api.Field{
		{Row: 3, Col: 5, Name: "a", Length: 2, Value: "S", Modified: true},
		{Row: 4, Col: 5, Name: "b", Length: 2, Value: "X"},
	}}
	if m := build(in).Modified(); !m["a"] || m["b"] {
		t.Fatalf("modified tags: %v", m)
	}
}

func TestTimeoutOnLogonScreenStaysThere(t *testing.T) {
	f := &fakeAPI{}
	s := NewSession(&Config{SystemName: "SYS1", Backend: f}, "TERM0001")
	scr := s.Submit(t3.AIDTimeout, s.Start())
	if len(f.reqs) != 0 || !strings.Contains(scr.Row(scr.Rows()), "ENTER=LOGON") {
		t.Fatal("a timeout before logon should do nothing")
	}
}

// fileAPI also serves downloads, and sends one with the next screen.
type fileAPI struct {
	fakeAPI
	send  *api.Download
	files map[string][]byte
}

func (f *fileAPI) Screen(ctx context.Context, req api.ScreenRequest) (api.ScreenResponse, error) {
	resp, err := f.fakeAPI.Screen(ctx, req)
	resp.Download, f.send = f.send, nil
	return resp, err
}

func (f *fileAPI) Download(_ context.Context, path string) ([]byte, error) {
	b, ok := f.files[path]
	if !ok {
		return nil, errors.New("api: not found")
	}
	return b, nil
}

func TestSavesFilesTheHostSends(t *testing.T) {
	dir := t.TempDir()
	f := &fileAPI{files: map[string][]byte{"/v1/invoices/INV00001/pdf": []byte("%PDF-1.4")}}
	s := NewSession(&Config{SystemName: "TEST", Backend: f, DownloadDir: dir}, "TERM0001")
	scr := s.Submit(t3.AIDEnter, s.Start())

	for i, want := range []string{"INV00001.pdf", "INV00001-2.pdf"} {
		f.send = &api.Download{URL: "/v1/invoices/INV00001/pdf", Name: "../INV00001.pdf"}
		scr = s.Submit(t3.AIDPF2, scr)
		path := filepath.Join(dir, want)
		if b, err := os.ReadFile(path); err != nil || string(b) != "%PDF-1.4" {
			t.Fatalf("copy %d: %q, %v", i+1, b, err)
		}
		if !strings.Contains(scr.Row(23), "GSC1507I SAVED "+path) {
			t.Fatalf("message: %q", scr.Row(23))
		}
	}

	f.send = &api.Download{URL: "/v1/nosuch", Name: "X.pdf"}
	scr = s.Submit(t3.AIDEnter, scr)
	if !strings.Contains(scr.Row(23), "GSC1509E NOT FOUND") {
		t.Fatalf("failed download: %q", scr.Row(23))
	}
	f.send = &api.Download{URL: "https://evil.example/x", Name: "X.pdf"}
	scr = s.Submit(t3.AIDEnter, scr)
	if !strings.Contains(scr.Row(23), "GSC1509E BAD FILE LOCATION") {
		t.Fatalf("foreign URL: %q", scr.Row(23))
	}
}

// snapAPI is a backend that draws snapshots.
type snapAPI struct {
	fakeAPI
	got api.SnapshotRequest
}

func (f *snapAPI) Snapshot(_ context.Context, req api.SnapshotRequest) ([]byte, string, error) {
	f.got = req
	return []byte("PNG"), req.Map + "-202610260112." + req.Format, nil
}

func TestSnapshotSendsTheScreenAsItShows(t *testing.T) {
	dir := t.TempDir()
	f := &snapAPI{}
	s := NewSession(&Config{SystemName: "TEST", Backend: f, DownloadDir: dir, Snapshots: true}, "TERM0001")
	if _, err := s.Snapshot(s.Start(), "png"); err == nil {
		t.Fatal("snapshot before logon")
	}
	scr := s.Submit(t3.AIDEnter, s.Start())
	fill(t, scr, "opt", "1.2", "pw", "1234")

	path, err := s.Snapshot(scr, "pdf")
	if err != nil || path != filepath.Join(dir, "TEST-202610260112.pdf") {
		t.Fatalf("snapshot: %q, %v", path, err)
	}
	if b, _ := os.ReadFile(path); string(b) != "PNG" {
		t.Fatalf("file: %q", b)
	}
	req := f.got
	if req.Format != "pdf" || req.Map != "TEST" || req.Terminal != "TERM0001" || req.Screen.Rows != 24 || req.Screen.Cols != 80 {
		t.Fatalf("request: %+v", req)
	}
	want := []api.SnapField{
		{Row: 1, Col: 2, Text: "START ", Color: "blue"},
		{Row: 4, Col: 14, Text: "1.2       ", Input: true, Highlight: "underscore"},
		{Row: 5, Col: 14, Text: "1234    ", Input: true, Highlight: "underscore", Bright: true, Hidden: true},
		{Row: 24, Col: 2, Text: "PF3=EXIT", Color: "turquoise"},
	}
	got := req.Screen.Fields
	if len(got) != len(want) {
		t.Fatalf("fields: %+v", got)
	}
	for i := range want {
		if !strings.HasPrefix(got[i].Text, want[i].Text) || got[i].Row != want[i].Row || got[i].Col != want[i].Col ||
			got[i].Color != want[i].Color || got[i].Input != want[i].Input || got[i].Hidden != want[i].Hidden {
			t.Errorf("field %d: %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestPushes(t *testing.T) {
	s, _, _ := newSession(t)
	pushed := func() bool {
		select {
		case <-s.Pushes():
			return true
		default:
			return false
		}
	}
	s.event("syslog")
	if pushed() {
		t.Fatal("syslog pushed for a screen that is not live")
	}
	s.event("message")
	if !pushed() {
		t.Fatal("a message did not push")
	}
	s.show(&api.Screen{Map: "APPO01", Rows: 24, Cols: 80, Refresh: 5, Live: "syslog"})
	s.event("syslog")
	s.event("syslog") // coalesced with the first
	if !pushed() || pushed() {
		t.Fatal("want one push for a live screen")
	}

	// While listening, the refresh timer is only a fallback.
	s.setListening(true)
	if got := s.show(&api.Screen{Map: "APPO01", Rows: 24, Cols: 80, Refresh: 5, Live: "syslog"}).Refresh(); got != liveFallback {
		t.Fatalf("refresh while listening = %v, want %v", got, liveFallback)
	}
	if !s.request("REDRAW", nil).Live {
		t.Fatal("request does not say the client is listening")
	}
}

func TestAppNamesItselfOnLogon(t *testing.T) {
	f := &fakeAPI{err: api.ErrUnavailable}
	s := NewSession(&Config{SystemName: "POS1", Title: "Point of Sale", Prefix: "POS", Banner: []string{"STORE 42"}, Backend: f}, "TERM0001")
	scr := s.Start()
	text := strings.Join(rows(scr), "\n")
	for _, want := range []string{"STORE 42", "P O I N T   O F   S A L E", "SYSTEM . . . . : POS1"} {
		if !strings.Contains(text, want) {
			t.Errorf("logon screen lacks %q:\n%s", want, text)
		}
	}
	got := s.Submit(t3.PF(5), scr)
	if !strings.Contains(got.Row(23), "POS0000W PF5 IS NOT ACTIVE") {
		t.Errorf("message line = %q", got.Row(23))
	}

	s = NewSession(&Config{SystemName: "SYS1", Title: "Customer Information System", Tagline: "Modern Mainframe Experience", Backend: f}, "TERM0001")
	if text := strings.Join(rows(s.Start()), "\n"); !strings.Contains(text, "M O D E R N   M A I N F R A M E   E X P E R I E N C E") {
		t.Errorf("logon screen lacks the tagline:\n%s", text)
	}
}

func rows(scr *t3.Screen) []string {
	out := make([]string, scr.Rows())
	for i := range out {
		out[i] = scr.Row(i + 1)
	}
	return out
}

// listenAPI counts the times the session connects to GET /v1/live.
type listenAPI struct {
	fakeAPI
	calls chan struct{}
}

func (l *listenAPI) Listen(ctx context.Context, opened func(), on func(string)) error {
	l.calls <- struct{}{}
	<-ctx.Done()
	return ctx.Err()
}

func TestListensOnlyWhenTheAppServesLive(t *testing.T) {
	for _, live := range []bool{false, true} {
		l := &listenAPI{calls: make(chan struct{}, 1)}
		s := NewSession(&Config{SystemName: "TEST", Backend: l, Live: live}, "TERM0001")
		s.show(&api.Screen{Map: "APP001", Rows: 24, Cols: 80})
		select {
		case <-l.calls:
			if !live {
				t.Error("listened to an app that does not serve /v1/live")
			}
		case <-time.After(100 * time.Millisecond):
			if live {
				t.Error("did not listen to an app that serves /v1/live")
			}
		}
		s.stopListening()
	}
}

// infoAPI is a backend whose app info Access only lets through after logon.
type infoAPI struct {
	fakeAPI
	asked int
}

func (f *infoAPI) Info(context.Context) (api.AppInfo, error) {
	f.asked++
	if !f.loggedOn {
		return api.AppInfo{}, errors.New("api: info: 302 Found")
	}
	return api.AppInfo{Title: "POINT OF SALE", Prefix: "POS", Live: true, Snapshot: true}, nil
}

func TestInfoIsAskedAgainAfterLogon(t *testing.T) {
	f := &infoAPI{}
	cfg := &Config{SystemName: "TEST", Backend: f}
	s := NewSession(cfg, "TERM0001")
	s.Submit(t3.AIDEnter, s.Start())
	if f.asked != 1 || !cfg.HaveInfo || !cfg.Live || !cfg.Snapshots || cfg.Prefix != "POS" || cfg.SystemName != "TEST" {
		t.Fatalf("info after logon: asked %d, %+v", f.asked, cfg)
	}
	// Known already: not asked again.
	known := &infoAPI{}
	k := NewSession(&Config{SystemName: "TEST", Backend: known, HaveInfo: true}, "TERM0001")
	k.Submit(t3.AIDEnter, k.Start())
	if known.asked != 0 {
		t.Fatalf("asked again: %d", known.asked)
	}
}
