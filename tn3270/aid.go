package tn3270

import "fmt"

// AID is an attention identifier: the key that sent the screen to the host.
type AID int

const (
	AIDNone AID = iota
	AIDEnter
	AIDClear
	AIDPA1
	AIDPA2
	AIDPA3
	AIDPF1
	AIDPF2
	AIDPF3
	AIDPF4
	AIDPF5
	AIDPF6
	AIDPF7
	AIDPF8
	AIDPF9
	AIDPF10
	AIDPF11
	AIDPF12
	AIDPF13
	AIDPF14
	AIDPF15
	AIDPF16
	AIDPF17
	AIDPF18
	AIDPF19
	AIDPF20
	AIDPF21
	AIDPF22
	AIDPF23
	AIDPF24

	// AIDTimeout is not a key: the terminal sends it when the operator has
	// left it idle too long, and the host logs the session off.
	AIDTimeout
)

// PF returns the AID for program function key n (1-24).
func PF(n int) AID { return AIDPF1 + AID(n-1) }

// PFNumber returns n for PFn, or 0 for any other AID. PF13-PF24 fold onto
// PF1-PF12 when fold is true, as most applications treat them.
func (a AID) PFNumber(fold bool) int {
	if a < AIDPF1 || a > AIDPF24 {
		return 0
	}
	n := int(a-AIDPF1) + 1
	if fold && n > 12 {
		n -= 12
	}
	return n
}

func (a AID) String() string {
	switch {
	case a == AIDEnter:
		return "ENTER"
	case a == AIDClear:
		return "CLEAR"
	case a >= AIDPA1 && a <= AIDPA3:
		return fmt.Sprintf("PA%d", int(a-AIDPA1)+1)
	case a >= AIDPF1 && a <= AIDPF24:
		return fmt.Sprintf("PF%d", a.PFNumber(false))
	case a == AIDTimeout:
		return "TIMEOUT"
	}
	return "NONE"
}

// Host is the application side of a terminal session. Submit is called on
// its own goroutine while the keyboard is locked; it must not modify the
// screen it is given and should return a new one.
type Host interface {
	// Start returns the first screen shown after connecting.
	Start() *Screen
	// Redraw lays out the current panel again for a presentation space of
	// rows by cols, and uses that size for the screens that follow. Like
	// Submit it runs on its own goroutine with the keyboard locked, and the
	// two are never called at once. A nil screen keeps the old layout.
	Redraw(rows, cols int) *Screen
	// Submit receives the screen as it was when the AID key was pressed and
	// returns the next screen. Returning a nil screen ends the session.
	Submit(aid AID, s *Screen) *Screen
}
