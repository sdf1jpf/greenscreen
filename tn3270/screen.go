// Package tn3270 implements a block-mode, field-oriented display that
// behaves like an IBM 3278 terminal: a presentation space made of fields,
// each introduced by an attribute byte that occupies a screen position and
// controls protection, intensity, color and data type. The space is 24x80
// (a Model 2) or larger, sized to the window the way emulators with a
// dynamic screen size are.
package tn3270

import (
	"strings"
	"time"
)

// MinRows and MinCols are the smallest presentation space, a 3278 Model 2.
const (
	MinRows = 24
	MinCols = 80
)

// Color is a 3270 extended-attribute color.
type Color int

const (
	Default Color = iota
	Blue
	Red
	Pink
	Green
	Turquoise
	Yellow
	White
)

// Highlight is a 3270 extended highlighting mode.
type Highlight int

const (
	HlNone Highlight = iota
	HlUnderscore
	HlReverse
	HlBlink
)

// Attr describes a field. It is stored in the attribute-byte position that
// starts the field.
type Attr struct {
	Protected bool
	Numeric   bool
	Intense   bool
	Hidden    bool // non-display, e.g. password fields
	Mixed     bool // keep lower case; otherwise input is folded to upper
	Color     Color
	Highlight Highlight

	name     string
	modified bool // MDT
}

// Opt tweaks an Attr when building a screen.
type Opt func(*Attr)

func Bright(a *Attr)      { a.Intense = true }
func Numeric(a *Attr)     { a.Numeric = true }
func Hidden(a *Attr)      { a.Hidden = true }
func Underline(a *Attr)   { a.Highlight = HlUnderscore }
func Reverse(a *Attr)     { a.Highlight = HlReverse }
func Blink(a *Attr)       { a.Highlight = HlBlink }
func NoUnderline(a *Attr) { a.Highlight = HlNone }
func MixedCase(a *Attr)   { a.Mixed = true }
func Modified(a *Attr)    { a.modified = true } // set the MDT, as if typed
func WithColor(c Color) Opt {
	return func(a *Attr) { a.Color = c }
}

type cell struct {
	ch     rune // 0 is a null
	isAttr bool
	attr   Attr
}

// Screen is a 3270 presentation space plus a cursor address.
type Screen struct {
	rows, cols int
	buf        []cell
	cursor     int
	refresh    time.Duration
}

// SetRefresh asks the terminal to redraw the screen every d while the
// operator leaves it alone, for screens that show live data. Zero (the
// default) never does.
func (s *Screen) SetRefresh(d time.Duration) { s.refresh = d }

// Refresh returns the screen's refresh interval, or zero.
func (s *Screen) Refresh() time.Duration { return s.refresh }

// NewScreen returns a cleared, formatted 24x80 screen.
func NewScreen() *Screen { return NewScreenSize(MinRows, MinCols) }

// NewScreenSize returns a cleared, formatted screen of the given size, no
// smaller than 24x80. Position 0 holds a protected attribute so the whole
// screen is protected until fields are defined.
func NewScreenSize(rows, cols int) *Screen {
	rows, cols = max(rows, MinRows), max(cols, MinCols)
	s := &Screen{rows: rows, cols: cols, buf: make([]cell, rows*cols)}
	s.buf[0] = cell{isAttr: true, attr: Attr{Protected: true}}
	s.cursor = 1
	return s
}

// Clone returns a copy of the screen, input and modified tags included.
func (s *Screen) Clone() *Screen {
	c := *s
	c.buf = append([]cell(nil), s.buf...)
	return &c
}

// Rows and Cols return the size of the presentation space.
func (s *Screen) Rows() int { return s.rows }
func (s *Screen) Cols() int { return s.cols }

// Addr converts a 1-based row and column into a buffer address.
func (s *Screen) Addr(row, col int) int {
	return s.wrap((row-1)*s.cols + (col - 1))
}

func (s *Screen) wrap(a int) int {
	a %= len(s.buf)
	if a < 0 {
		a += len(s.buf)
	}
	return a
}

// RowCol converts a buffer address into a 1-based row and column.
func (s *Screen) RowCol(addr int) (int, int) { return addr/s.cols + 1, addr%s.cols + 1 }

func (s *Screen) setAttr(addr int, a Attr) {
	s.buf[s.wrap(addr)] = cell{isAttr: true, attr: a}
}

// Text places a protected field whose data begins at row/col. The
// attribute byte occupies the position immediately before it, as with a
// BMS map.
func (s *Screen) Text(row, col int, text string, opts ...Opt) {
	a := Attr{Protected: true}
	for _, o := range opts {
		o(&a)
	}
	start := s.Addr(row, col)
	s.setAttr(start-1, a)
	for i, r := range []rune(text) {
		s.buf[s.wrap(start+i)] = cell{ch: r}
	}
	s.stopper(start + len([]rune(text)))
}

// Input places a named, unprotected field of the given length. A protected
// "stopper" attribute is placed after it unless another field begins there.
func (s *Screen) Input(row, col, length int, name, value string, opts ...Opt) {
	a := Attr{Highlight: HlUnderscore, name: name}
	for _, o := range opts {
		o(&a)
	}
	start := s.Addr(row, col)
	s.setAttr(start-1, a)
	v := []rune(value)
	for i := 0; i < length; i++ {
		c := cell{}
		if i < len(v) {
			c.ch = v[i]
		}
		s.buf[s.wrap(start+i)] = c
	}
	s.stopper(start + length)
}

func (s *Screen) stopper(addr int) {
	addr = s.wrap(addr)
	if !s.buf[addr].isAttr {
		s.buf[addr] = cell{isAttr: true, attr: Attr{Protected: true}}
	}
}

// SetCursor positions the cursor at a 1-based row and column.
func (s *Screen) SetCursor(row, col int) { s.cursor = s.Addr(row, col) }

// CursorTo places the cursor at the first position of the named field.
// It reports whether the field exists.
func (s *Screen) CursorTo(name string) bool {
	for i := range s.buf {
		if s.buf[i].isAttr && s.buf[i].attr.name == name {
			s.cursor = s.wrap(i + 1)
			return true
		}
	}
	return false
}

// CursorHome moves the cursor to the first unprotected field, as the Home
// key and the host's default cursor placement do.
func (s *Screen) CursorHome() {
	if a, ok := s.nextUnprotected(len(s.buf) - 1); ok {
		s.cursor = a
	}
}

// Cursor returns the cursor address.
func (s *Screen) Cursor() int { return s.cursor }

// fieldAttr returns the address of the attribute byte governing addr.
func (s *Screen) fieldAttr(addr int) int {
	for i := 0; i < len(s.buf); i++ {
		a := s.wrap(addr - i)
		if s.buf[a].isAttr {
			return a
		}
	}
	return 0
}

// fieldBounds returns the first data address and the length of the field
// governed by the attribute at fa.
func (s *Screen) fieldBounds(fa int) (start, length int) {
	start = s.wrap(fa + 1)
	for i := 0; i < len(s.buf)-1; i++ {
		if s.buf[s.wrap(start+i)].isAttr {
			return start, i
		}
	}
	return start, len(s.buf) - 1
}

// nextUnprotected returns the first data address of the next unprotected
// field strictly after addr.
func (s *Screen) nextUnprotected(addr int) (int, bool) {
	for i := 1; i <= len(s.buf); i++ {
		a := s.wrap(addr + i)
		if s.buf[a].isAttr && !s.buf[a].attr.Protected {
			if _, n := s.fieldBounds(a); n > 0 {
				return s.wrap(a + 1), true
			}
		}
	}
	return 0, false
}

// prevUnprotected returns the data start of the closest unprotected field
// beginning strictly before addr.
func (s *Screen) prevUnprotected(addr int) (int, bool) {
	for i := 1; i <= len(s.buf); i++ {
		a := s.wrap(addr - i)
		if s.buf[a].isAttr && !s.buf[a].attr.Protected && s.wrap(a+1) != addr {
			if _, n := s.fieldBounds(a); n > 0 {
				return s.wrap(a + 1), true
			}
		}
	}
	return 0, false
}

// Fields returns the current contents of every named input field, with
// nulls removed and trailing blanks trimmed, as the host would see them
// after a Read Modified.
func (s *Screen) Fields() map[string]string {
	out := map[string]string{}
	for i := range s.buf {
		c := s.buf[i]
		if !c.isAttr || c.attr.Protected || c.attr.name == "" {
			continue
		}
		out[c.attr.name] = s.fieldText(i)
	}
	return out
}

// Modified reports which named fields have their modified data tag set.
func (s *Screen) Modified() map[string]bool {
	out := map[string]bool{}
	for i := range s.buf {
		c := s.buf[i]
		if c.isAttr && c.attr.name != "" && c.attr.modified {
			out[c.attr.name] = true
		}
	}
	return out
}

func (s *Screen) fieldText(fa int) string {
	start, n := s.fieldBounds(fa)
	var b strings.Builder
	for i := 0; i < n; i++ {
		if r := s.buf[s.wrap(start+i)].ch; r != 0 {
			b.WriteRune(r)
		}
	}
	return strings.TrimRight(b.String(), " ")
}

// Area is one field of the presentation space as it shows: where its data
// starts, what is in it (nulls as blanks) and how it looks.
type Area struct {
	Row, Col int
	Text     string
	Attr     Attr
}

// Areas lists the screen's fields for a snapshot: every input field, and
// the protected ones that show something.
func (s *Screen) Areas() []Area {
	var out []Area
	for fa, c := range s.buf {
		if !c.isAttr {
			continue
		}
		start, n := s.fieldBounds(fa)
		text := make([]rune, n)
		for i := range text {
			text[i] = s.buf[s.wrap(start+i)].ch
			if text[i] == 0 {
				text[i] = ' '
			}
		}
		if n == 0 || c.attr.Protected && strings.TrimSpace(string(text)) == "" {
			continue
		}
		row, col := s.RowCol(start)
		out = append(out, Area{Row: row, Col: col, Text: string(text), Attr: c.attr})
	}
	return out
}

// FieldName returns the name of the field under addr, if it is a named
// input field.
func (s *Screen) FieldName(addr int) string {
	return s.buf[s.fieldAttr(addr)].attr.name
}

// Carry copies the operator's input from old into s: the contents and
// modified tags of the named input fields old has changed, cut to fit, and
// the cursor if it was in a named field. The terminal uses it when the host
// lays out the current panel again for a new window size, so that a resize
// does not lose anything already typed.
func (s *Screen) Carry(old *Screen) {
	fields := map[string]int{}
	for i, c := range s.buf {
		if c.isAttr && !c.attr.Protected && c.attr.name != "" {
			fields[c.attr.name] = i
		}
	}
	for i, c := range old.buf {
		if !c.isAttr || !c.attr.modified || c.attr.name == "" {
			continue
		}
		fa, ok := fields[c.attr.name]
		if !ok {
			continue
		}
		from, n := old.fieldBounds(i)
		to, m := s.fieldBounds(fa)
		for j := 0; j < m; j++ {
			var ch rune
			if j < n {
				ch = old.buf[old.wrap(from+j)].ch
			}
			s.buf[s.wrap(to+j)].ch = ch
		}
		s.buf[fa].attr.modified = true
	}
	ofa := old.fieldAttr(old.cursor)
	if name := old.buf[ofa].attr.name; name != "" && !old.buf[old.cursor].isAttr {
		if fa, ok := fields[name]; ok {
			off := old.wrap(old.cursor - ofa - 1)
			to, m := s.fieldBounds(fa)
			s.cursor = s.wrap(to + min(off, max(m-1, 0)))
		}
	}
}

// Row returns the text of a 1-based row, with attribute positions and
// nulls shown as blanks and hidden fields left out.
func (s *Screen) Row(row int) string {
	var b strings.Builder
	start := s.Addr(row, 1)
	for i := 0; i < s.cols; i++ {
		c := s.buf[start+i]
		if c.isAttr || c.ch == 0 || s.buf[s.fieldAttr(start+i)].attr.Hidden {
			b.WriteByte(' ')
			continue
		}
		b.WriteRune(c.ch)
	}
	return b.String()
}
