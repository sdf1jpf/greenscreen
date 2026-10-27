package host

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/sdf1jpf/greenscreen/internal/api"
	t3 "github.com/sdf1jpf/greenscreen/tn3270"
)

// TestSharedKeyboardCases runs the keyboard cases in testdata/terminal.json,
// which the browser terminal's tests run too, so the two screen models edit
// fields alike.
func TestSharedKeyboardCases(t *testing.T) {
	b, err := os.ReadFile("../../testdata/terminal.json")
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Screen api.Screen
		Cases  []struct {
			Name string
			Keys []string
			Want struct {
				Fields   map[string]string
				Modified []string
				Cursor   [2]int
				Lock     string
			}
		}
	}
	if err := json.Unmarshal(b, &data); err != nil {
		t.Fatal(err)
	}
	for _, c := range data.Cases {
		t.Run(c.Name, func(t *testing.T) {
			scr := build(&data.Screen)
			lock := t3.LockNone
			insert := false
			for _, key := range c.Keys {
				op, arg, _ := strings.Cut(key, " ")
				n := func(i int) int {
					v, _ := strconv.Atoi(strings.Fields(arg)[i])
					return v
				}
				switch op {
				case "type":
					for _, r := range arg {
						if lock = scr.Type(r, insert); lock != t3.LockNone {
							break
						}
					}
				case "insert":
					insert = !insert
				case "reset":
					lock = t3.LockNone
				case "move":
					scr.Move(n(0), n(1))
				case "moveTo":
					scr.MoveTo(scr.Addr(n(0), n(1)))
				case "tab":
					scr.Tab()
				case "backtab":
					scr.BackTab()
				case "newline":
					scr.NewLine()
				case "home":
					scr.CursorHome()
				case "end":
					scr.EndOfField()
				case "backspace":
					lock = scr.Backspace()
				case "delete":
					lock = scr.Delete()
				case "eraseEOF":
					lock = scr.EraseEOF()
				case "eraseInput":
					scr.EraseInput()
				default:
					t.Fatalf("unknown key %q", key)
				}
			}
			modified := []string{}
			for name := range scr.Modified() {
				modified = append(modified, name)
			}
			sort.Strings(modified)
			row, col := scr.RowCol(scr.Cursor())
			if got := scr.Fields(); !reflect.DeepEqual(got, c.Want.Fields) {
				t.Errorf("fields = %v, want %v", got, c.Want.Fields)
			}
			if !reflect.DeepEqual(modified, c.Want.Modified) {
				t.Errorf("modified = %v, want %v", modified, c.Want.Modified)
			}
			if [2]int{row, col} != c.Want.Cursor {
				t.Errorf("cursor = %d/%d, want %v", row, col, c.Want.Cursor)
			}
			if lock.String() != c.Want.Lock {
				t.Errorf("lock = %q, want %q", lock, c.Want.Lock)
			}
		})
	}
}
