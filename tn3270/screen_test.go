package tn3270

import (
	"os"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func form() *Screen { return formSize(MinRows, MinCols) }

func formSize(rows, cols int) *Screen {
	s := NewScreenSize(rows, cols)
	s.Text(2, 2, "NAME ===>")
	s.Input(2, 12, 5, "name", "")
	s.Text(3, 2, "ZIP  ===>")
	s.Input(3, 12, 3, "zip", "", Numeric)
	s.CursorHome()
	return s
}

func typeAll(t *testing.T, s *Screen, text string, insert bool) {
	t.Helper()
	for _, r := range text {
		if l := s.Type(r, insert); l != LockNone {
			t.Fatalf("typing %q: lock %v", r, l)
		}
	}
}

func TestTypeUppercasesAndAutoSkips(t *testing.T) {
	s := form()
	typeAll(t, s, "abcde", false)
	if got := s.Fields()["name"]; got != "ABCDE" {
		t.Fatalf("name = %q", got)
	}
	if s.FieldName(s.Cursor()) != "zip" {
		t.Fatalf("cursor did not skip to zip, at %v", s.Cursor())
	}
	if !s.Modified()["name"] || s.Modified()["zip"] {
		t.Fatalf("modified = %v", s.Modified())
	}
}

func TestLocks(t *testing.T) {
	s := form()
	s.Tab()
	if l := s.Type('x', false); l != LockNumeric {
		t.Fatalf("numeric field accepted a letter: %v", l)
	}
	s.SetCursor(2, 3)
	if l := s.Type('x', false); l != LockProtected {
		t.Fatalf("protected field accepted input: %v", l)
	}
	s.CursorHome()
	typeAll(t, s, "abcde", false)
	s.CursorHome()
	if l := s.Type('z', true); l != LockOverflow {
		t.Fatalf("insert into a full field: %v", l)
	}
}

func TestInsertDeleteErase(t *testing.T) {
	s := form()
	typeAll(t, s, "ace", false)
	s.CursorHome()
	s.Move(0, 1)
	typeAll(t, s, "b", true)
	if got := s.Fields()["name"]; got != "ABCE" {
		t.Fatalf("after insert: %q", got)
	}
	s.Backspace()
	if got := s.Fields()["name"]; got != "ACE" {
		t.Fatalf("after backspace: %q", got)
	}
	s.EraseEOF()
	if got := s.Fields()["name"]; got != "A" {
		t.Fatalf("after erase eof: %q", got)
	}
}

func TestTabbing(t *testing.T) {
	s := form()
	s.Tab()
	if s.FieldName(s.Cursor()) != "zip" {
		t.Fatal("tab did not reach zip")
	}
	s.Tab()
	if s.FieldName(s.Cursor()) != "name" {
		t.Fatal("tab did not wrap to name")
	}
	s.BackTab()
	if s.FieldName(s.Cursor()) != "zip" {
		t.Fatal("backtab did not wrap to zip")
	}
	s.Move(0, 2)
	s.BackTab()
	if r, c := s.RowCol(s.Cursor()); r != 3 || c != 12 {
		t.Fatalf("backtab inside a field should go to its start, got %d,%d", r, c)
	}
}

func TestInitialValuesAndHidden(t *testing.T) {
	s := NewScreen()
	s.Input(5, 10, 8, "pw", "SECRET", Hidden)
	if got := s.Fields()["pw"]; got != "SECRET" {
		t.Fatalf("pw = %q", got)
	}
	if !s.CursorTo("pw") {
		t.Fatal("CursorTo failed")
	}
	if r, c := s.RowCol(s.Cursor()); r != 5 || c != 10 {
		t.Fatalf("cursor at %d,%d", r, c)
	}
}

type echoHost struct{}

func (echoHost) Start() *Screen                { return form() }
func (echoHost) Redraw(rows, cols int) *Screen { return formSize(rows, cols) }
func (echoHost) Submit(aid AID, s *Screen) *Screen {
	n := NewScreenSize(s.Rows(), s.Cols())
	n.Text(1, 2, aid.String()+" "+s.Fields()["name"])
	return n
}

func TestTerminalRoundTrip(t *testing.T) {
	term := New(echoHost{}, Options{})
	term.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	_, cmd := term.Update(tea.KeyMsg{Type: tea.KeyF5})
	if term.lock != LockWait {
		t.Fatalf("keyboard not locked during host wait: %v", term.lock)
	}
	if !strings.Contains(term.View(), "X ()") {
		t.Fatal("OIA does not show the wait indicator")
	}
	term.Update(cmd())
	if term.lock != LockNone || !strings.Contains(term.View(), "PF5 HI") {
		t.Fatalf("host reply not displayed:\n%s", term.View())
	}
}

func TestEscDigitIsPFKey(t *testing.T) {
	term := New(echoHost{}, Options{})
	update(term, tea.KeyMsg{Type: tea.KeyEsc})
	if !strings.Contains(term.View(), "PF?") {
		t.Fatal("OIA does not show that Esc is waiting for a PF digit")
	}
	update(term, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("6")})
	if !strings.Contains(term.View(), "PF6") {
		t.Fatalf("Esc 6 did not send PF6:\n%s", term.View())
	}
	update(term, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("0"), Alt: true})
	if !strings.Contains(term.View(), "PF10") {
		t.Fatalf("Alt+0 did not send PF10:\n%s", term.View())
	}
	// Without Esc first, a digit is typed as usual.
	update(term, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("6")})
	if term.lock == LockWait || strings.Contains(term.View(), "PF?") {
		t.Fatal("a plain digit was taken as a PF key")
	}
}

// update applies msg and runs the commands it returns, as Bubble Tea would.
func update(term *Terminal, msg tea.Msg) {
	for _, cmd := term.Update(msg); cmd != nil; {
		_, cmd = term.Update(cmd())
	}
}

func TestResizeKeepsInput(t *testing.T) {
	term := New(echoHost{}, Options{})
	update(term, tea.WindowSizeMsg{Width: 80, Height: 26})
	term.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})

	_, cmd := term.Update(tea.WindowSizeMsg{Width: 132, Height: 45})
	if term.lock != LockWait {
		t.Fatal("keyboard not locked while the host lays out the screen")
	}
	update(term, cmd())
	if r, c := term.scr.Rows(), term.scr.Cols(); r != 43 || c != 132 {
		t.Fatalf("screen is %dx%d after resize, want 43x132", r, c)
	}
	if got := term.scr.Fields()["name"]; got != "HI" || !term.scr.Modified()["name"] {
		t.Fatalf("input lost on resize: %q modified=%v", got, term.scr.Modified())
	}
	if r, c := term.scr.RowCol(term.scr.Cursor()); r != 2 || c != 14 {
		t.Fatalf("cursor at %d,%d after resize, want 2,14", r, c)
	}
	lines := strings.Split(term.View(), "\n")
	if len(lines) != 45 {
		t.Fatalf("view has %d lines, want 45", len(lines))
	}
	if !strings.Contains(lines[44], "002/014") {
		t.Fatalf("OIA does not show the cursor: %q", lines[44])
	}

	// Too small for a Model 2: keep the last layout and say so.
	update(term, tea.WindowSizeMsg{Width: 60, Height: 20})
	if term.scr.Cols() != 132 || !strings.Contains(term.View(), "too small") {
		t.Fatal("expected the too-small notice")
	}
}

func TestResizeWaitsForHost(t *testing.T) {
	term := New(echoHost{}, Options{})
	update(term, tea.WindowSizeMsg{Width: 80, Height: 26})
	_, cmd := term.Update(tea.KeyMsg{Type: tea.KeyEnter})
	term.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	if term.scr.Cols() != 80 {
		t.Fatal("screen was redrawn while the host was busy")
	}
	update(term, cmd())
	if r, c := term.scr.Rows(), term.scr.Cols(); r != 28 || c != 100 {
		t.Fatalf("screen is %dx%d after the reply, want 28x100", r, c)
	}
}

type downHost struct{ echoHost }

func (downHost) Redraw(rows, cols int) *Screen { return nil }

func TestResizeWithHostDown(t *testing.T) {
	term := New(downHost{}, Options{})
	update(term, tea.WindowSizeMsg{Width: 100, Height: 30})
	if term.lock != LockNone || term.scr.Cols() != 80 {
		t.Fatalf("expected the old layout and an unlocked keyboard, got %v %d", term.lock, term.scr.Cols())
	}
}

func TestPrintScreen(t *testing.T) {
	dir := t.TempDir()
	scr := NewScreen()
	scr.Text(1, 2, "POSM00")
	term := New(stubHost{scr}, Options{PrintDir: dir})
	a, err := term.Print()
	if err != nil {
		t.Fatal(err)
	}
	b, err := term.Print()
	if err != nil || a == b {
		t.Fatalf("second print in the same second: %q %q %v", a, b, err)
	}
	got, _ := os.ReadFile(a)
	if lines := strings.Split(string(got), "\n"); len(lines) != 25 || lines[0] != " POSM00" {
		t.Fatalf("printed %d lines, first %q", len(lines), lines[0])
	}
}

type stubHost struct{ scr *Screen }

func (h stubHost) Start() *Screen              { return h.scr }
func (h stubHost) Redraw(int, int) *Screen     { return h.scr }
func (h stubHost) Submit(AID, *Screen) *Screen { return h.scr }

// liveHost serves a screen that asks to be refreshed, counting redraws.
type liveHost struct {
	echoHost
	redraws *int
}

func (h liveHost) Start() *Screen {
	s := form()
	s.SetRefresh(time.Second)
	return s
}

func (h liveHost) Submit(aid AID, s *Screen) *Screen { return h.Start() }

func (h liveHost) Redraw(rows, cols int) *Screen {
	*h.redraws++
	s := formSize(rows, cols)
	s.SetRefresh(time.Second)
	return s
}

func TestRefresh(t *testing.T) {
	n := 0
	term := New(liveHost{redraws: &n}, Options{})
	_, cmd := term.Update(tea.KeyMsg{Type: tea.KeyEnter})
	_, cmd = term.Update(cmd())
	if cmd == nil {
		t.Fatal("no refresh timer for a screen that asks for one")
	}
	gen := term.gen

	// The timer runs out: the terminal redraws and starts the next one.
	_, cmd = term.Update(refreshTick{gen: gen})
	if term.lock != LockWait {
		t.Fatal("keyboard not locked during the refresh")
	}
	if _, next := term.Update(cmd()); next == nil || n != 1 || term.lock != LockNone {
		t.Fatalf("refresh: %d redraws, lock %v, next timer %v", n, term.lock, next != nil)
	}

	// A tick for an older screen does nothing.
	if _, cmd = term.Update(refreshTick{gen: gen}); cmd != nil {
		t.Fatal("stale tick acted on")
	}

	// While the operator is typing, it waits rather than redraw.
	term.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	if _, cmd = term.Update(refreshTick{gen: term.gen}); cmd == nil || term.lock != LockNone {
		t.Fatal("expected another timer and no redraw while a field is modified")
	}
	if n != 1 {
		t.Fatalf("redrew while typing: %d", n)
	}
}

func TestStatusLineShowsSystemAndClock(t *testing.T) {
	at := time.Date(2026, 10, 26, 14, 5, 30, 0, time.Local)
	term := New(echoHost{}, Options{SystemName: "SYS1", LUName: "TERM0001", Now: func() time.Time { return at }})
	lines := strings.Split(term.View(), "\n")
	oia := lines[len(lines)-1]
	if !strings.Contains(oia, "SYS1") || !strings.Contains(oia, "14:05") || !strings.Contains(oia, "TERM0001") {
		t.Fatalf("OIA missing the system, clock or LU: %q", oia)
	}
}

func TestIdleTimeoutLogsOff(t *testing.T) {
	now := time.Date(2026, 10, 26, 14, 0, 0, 0, time.Local)
	term := New(echoHost{}, Options{IdleTimeout: 30 * time.Minute, Now: func() time.Time { return now }})

	// A key resets the timer.
	now = now.Add(20 * time.Minute)
	term.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("x")})
	now = now.Add(20 * time.Minute)
	if _, cmd := term.Update(idleTick{}); term.lock != LockNone || cmd == nil {
		t.Fatal("timed out although a key was pressed 20 minutes ago")
	}

	now = now.Add(11 * time.Minute)
	_, cmd := term.Update(idleTick{})
	if term.lock != LockWait {
		t.Fatal("no TIMEOUT sent after 31 idle minutes")
	}
	send := cmd().(tea.BatchMsg)[0] // the send; the other waits for the next timeout
	term.Update(send())
	if !strings.Contains(term.View(), "TIMEOUT") {
		t.Fatalf("host did not get TIMEOUT:\n%s", term.View())
	}

	// Esc then Up is PF24, RETRIEVE.
	update(term, tea.KeyMsg{Type: tea.KeyEsc})
	update(term, tea.KeyMsg{Type: tea.KeyUp})
	if !strings.Contains(term.View(), "PF24") {
		t.Fatalf("Esc Up did not send PF24:\n%s", term.View())
	}
}

// snapHost takes snapshots, recording the format and what the screen held.
type snapHost struct {
	echoHost
	got *[]string
}

func (h snapHost) Snapshot(s *Screen, format string) (string, error) {
	*h.got = append(*h.got, format+" "+s.Fields()["name"])
	return "/tmp/x." + format, nil
}

func TestSnapshotKeys(t *testing.T) {
	var got []string
	term := New(snapHost{got: &got}, Options{})
	update(term, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("ab")})
	_, cmd := term.Update(tea.KeyMsg{Type: tea.KeyCtrlS})
	if term.print != "SNAP..." || term.lock != LockNone || cmd == nil {
		t.Fatalf("after Ctrl+S: %q %v", term.print, term.lock)
	}
	update(term, cmd())
	if term.print != "SNAPPED" {
		t.Fatalf("after the snapshot: %q", term.print)
	}
	update(term, tea.KeyMsg{Type: tea.KeyEsc})
	_, cmd = term.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("s")})
	update(term, cmd())
	if strings.Join(got, ",") != "png AB,pdf AB" {
		t.Fatalf("snapshots: %q", got)
	}

	plain := New(echoHost{}, Options{})
	if _, cmd := plain.Update(tea.KeyMsg{Type: tea.KeyCtrlS}); cmd != nil || plain.print != "SNAP ERR" {
		t.Fatalf("host without snapshots: %q", plain.print)
	}
}
