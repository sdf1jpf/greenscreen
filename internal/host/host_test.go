package host

import (
	"context"
	"strings"
	"testing"

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
}

func rows(scr *t3.Screen) []string {
	out := make([]string, scr.Rows())
	for i := range out {
		out[i] = scr.Row(i + 1)
	}
	return out
}
