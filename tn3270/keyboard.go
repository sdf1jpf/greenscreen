package tn3270

import "unicode"

// Lock is the keyboard-inhibit state shown in the operator information
// area. Any lock other than LockNone rejects data keys until Reset.
type Lock int

const (
	LockNone      Lock = iota
	LockWait           // host is processing an AID ("X ()")
	LockProtected      // typed into a protected position ("X -f")
	LockNumeric        // non-numeric key in a numeric field ("X NUM")
	LockOverflow       // insert with no room left in the field ("X >")
)

func (l Lock) String() string {
	switch l {
	case LockWait:
		return "X ()"
	case LockProtected:
		return "X -f"
	case LockNumeric:
		return "X NUM"
	case LockOverflow:
		return "X >"
	}
	return ""
}

// Type enters a character at the cursor. It returns the resulting lock.
func (s *Screen) Type(r rune, insert bool) Lock {
	c := &s.buf[s.cursor]
	if c.isAttr {
		return LockProtected
	}
	fa := s.fieldAttr(s.cursor)
	a := &s.buf[fa].attr
	if a.Protected {
		return LockProtected
	}
	if a.Numeric && !(unicode.IsDigit(r) || r == '-' || r == '.') {
		return LockNumeric
	}
	if insert {
		start, n := s.fieldBounds(fa)
		last := s.wrap(start + n - 1)
		if ch := s.buf[last].ch; ch != 0 && ch != ' ' {
			return LockOverflow
		}
		for p := last; p != s.cursor; p = s.wrap(p - 1) {
			s.buf[p].ch = s.buf[s.wrap(p-1)].ch
		}
	}
	if !a.Mixed {
		r = unicode.ToUpper(r)
	}
	c.ch = r
	a.modified = true
	s.advanceAfterType()
	return LockNone
}

// advanceAfterType moves the cursor one position and, if that lands on an
// attribute byte (the end of the field), skips to the next input field,
// like the 3270 auto-skip behaviour.
func (s *Screen) advanceAfterType() {
	next := s.wrap(s.cursor + 1)
	if s.buf[next].isAttr {
		if a, ok := s.nextUnprotected(s.cursor); ok {
			s.cursor = a
			return
		}
	}
	s.cursor = next
}

// Backspace deletes the character left of the cursor within its field,
// shifting the remainder of the field left.
func (s *Screen) Backspace() Lock {
	fa := s.fieldAttr(s.cursor)
	start, _ := s.fieldBounds(fa)
	if s.buf[fa].attr.Protected || s.buf[s.cursor].isAttr {
		return LockProtected
	}
	if s.cursor == start {
		return LockNone
	}
	s.cursor = s.wrap(s.cursor - 1)
	return s.Delete()
}

// Delete removes the character at the cursor, shifting the rest of the
// field left and padding with a null.
func (s *Screen) Delete() Lock {
	if s.buf[s.cursor].isAttr {
		return LockProtected
	}
	fa := s.fieldAttr(s.cursor)
	if s.buf[fa].attr.Protected {
		return LockProtected
	}
	start, n := s.fieldBounds(fa)
	last := s.wrap(start + n - 1)
	for p := s.cursor; p != last; p = s.wrap(p + 1) {
		s.buf[p].ch = s.buf[s.wrap(p+1)].ch
	}
	s.buf[last].ch = 0
	s.buf[fa].attr.modified = true
	return LockNone
}

// EraseEOF clears from the cursor to the end of the current field.
func (s *Screen) EraseEOF() Lock {
	if s.buf[s.cursor].isAttr {
		return LockProtected
	}
	fa := s.fieldAttr(s.cursor)
	if s.buf[fa].attr.Protected {
		return LockProtected
	}
	start, n := s.fieldBounds(fa)
	end := s.wrap(start + n)
	for p := s.cursor; p != end; p = s.wrap(p + 1) {
		s.buf[p].ch = 0
	}
	s.buf[fa].attr.modified = true
	return LockNone
}

// EraseInput clears every unprotected field and homes the cursor.
func (s *Screen) EraseInput() {
	for i := range s.buf {
		if !s.buf[i].isAttr || s.buf[i].attr.Protected {
			continue
		}
		start, n := s.fieldBounds(i)
		for j := 0; j < n; j++ {
			s.buf[s.wrap(start+j)].ch = 0
		}
		s.buf[i].attr.modified = true
	}
	s.CursorHome()
}

// Tab moves to the start of the next unprotected field.
func (s *Screen) Tab() {
	if a, ok := s.nextUnprotected(s.cursor); ok {
		s.cursor = a
	}
}

// BackTab moves to the start of the current field, or of the previous
// unprotected field if already there.
func (s *Screen) BackTab() {
	fa := s.fieldAttr(s.cursor)
	if !s.buf[fa].attr.Protected && !s.buf[s.cursor].isAttr && s.wrap(fa+1) != s.cursor {
		s.cursor = s.wrap(fa + 1)
		return
	}
	if a, ok := s.prevUnprotected(s.cursor); ok {
		s.cursor = a
	}
}

// NewLine moves to the first unprotected field at or after the start of
// the next row.
func (s *Screen) NewLine() {
	row, _ := s.RowCol(s.cursor)
	if a, ok := s.nextUnprotected(s.Addr(row+1, 1) - 1); ok {
		s.cursor = a
	}
}

// EndOfField moves the cursor just past the last non-blank character in
// the current input field.
func (s *Screen) EndOfField() {
	fa := s.fieldAttr(s.cursor)
	if s.buf[fa].attr.Protected {
		return
	}
	start, n := s.fieldBounds(fa)
	pos := start
	for i := 0; i < n; i++ {
		if ch := s.buf[s.wrap(start+i)].ch; ch != 0 && ch != ' ' {
			pos = s.wrap(start + i + 1)
		}
	}
	if pos == s.wrap(start+n) {
		pos = s.wrap(start + n - 1)
	}
	s.cursor = pos
}

// Move shifts the cursor by drow/dcol with wrap-around, like the arrow keys.
func (s *Screen) Move(drow, dcol int) {
	s.cursor = s.wrap(s.cursor + drow*s.cols + dcol)
}

// MoveTo puts the cursor at an absolute buffer address (mouse click).
func (s *Screen) MoveTo(addr int) { s.cursor = s.wrap(addr) }
