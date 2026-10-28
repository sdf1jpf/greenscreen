package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
	gossh "golang.org/x/crypto/ssh"

	"github.com/sdf1jpf/greenscreen/internal/api"
	"github.com/sdf1jpf/greenscreen/internal/host"
)

func newKey(t *testing.T) (gossh.Signer, string) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := gossh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return signer, strings.TrimSpace(string(gossh.MarshalAuthorizedKey(signer.PublicKey())))
}

func TestParseUsers(t *testing.T) {
	a, ak := newKey(t)
	_, bk := newKey(t)
	users, err := parseUsers(strings.NewReader("# who may sign on\n\nJohn.Smith@Example.com " + ak + " john@laptop\nann@example.com " + bk + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got := users[string(a.PublicKey().Marshal())]; got != "john.smith@example.com" || len(users) != 2 {
		t.Errorf("users = %v", users)
	}
	for _, bad := range []string{
		ak,                      // no email
		"john@example.com",      // no key
		"john@example.com AAAA", // not a key
		"john@example.com " + ak + "\nann@example.com " + ak, // one key, two people
	} {
		if _, err := parseUsers(strings.NewReader(bad)); err == nil {
			t.Errorf("parseUsers(%q) took it", bad)
		}
	}
}

func TestUserFileRereads(t *testing.T) {
	a, ak := newKey(t)
	b, bk := newKey(t)
	path := filepath.Join(t.TempDir(), "users")
	os.WriteFile(path, []byte("ann@example.com "+ak+"\n"), 0o600)
	u := &userFile{path: path}
	if who, ok := u.lookup(a.PublicKey()); !ok || who != "ann@example.com" {
		t.Fatalf("lookup = %q, %v", who, ok)
	}
	if _, ok := u.lookup(b.PublicKey()); ok {
		t.Fatal("an unknown key signed on")
	}
	os.WriteFile(path, []byte("bob@example.com "+bk+"\n"), 0o600)
	os.Chtimes(path, time.Now(), time.Now().Add(time.Minute))
	if _, ok := u.lookup(a.PublicKey()); ok {
		t.Error("a removed key still signs on")
	}
	if who, _ := u.lookup(b.PublicKey()); who != "bob@example.com" {
		t.Errorf("an added key signs on %q", who)
	}
	os.WriteFile(path, []byte("not a users file"), 0o600)
	os.Chtimes(path, time.Now(), time.Now().Add(2*time.Minute))
	if who, _ := u.lookup(b.PublicKey()); who != "bob@example.com" {
		t.Errorf("a broken file lost the users from before: %q", who)
	}
}

// TestServeSSH signs on over SSH and checks the application hears who for.
func TestServeSSH(t *testing.T) {
	var mu sync.Mutex
	var seen []string // Greenscreen-User of each signed-on request
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/screen/info" {
			json.NewEncoder(w).Encode(api.AppInfo{Title: "TEST SYSTEM", System: "SYS9", Prefix: "TST"})
			return
		}
		mu.Lock()
		seen = append(seen, r.Header.Get(api.UserHeader)+" "+r.Header.Get("CF-Access-Client-Id"))
		mu.Unlock()
		switch r.URL.Path {
		case "/v1/session":
			json.NewEncoder(w).Encode(api.LogonResponse{UserID: "JOHNSMIT"})
		case "/v1/screen":
			json.NewEncoder(w).Encode(api.ScreenResponse{V: 1, State: "s", Screen: &api.Screen{
				Map: "TEST", Rows: 24, Cols: 80, Fields: []api.Field{{Row: 1, Col: 2, Text: "WELCOME JOHNSMIT"}},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer app.Close()

	signer, key := newKey(t)
	stranger, _ := newKey(t)
	dir := t.TempDir()
	users := filepath.Join(dir, "users")
	os.WriteFile(users, []byte("john.smith@example.com "+key+"\n"), 0o600)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv, err := newSSHServer(sshConfig{
		HostKey: filepath.Join(dir, "host_key"), Users: &userFile{path: users}, API: app.URL,
		Gateway: api.ServiceToken{ID: "ssh.access", Secret: "s3cret"},
		Host:    &host.Config{SystemName: "SYS9", Title: "TEST SYSTEM"},
	})
	if err != nil {
		t.Fatal(err)
	}
	go srv.Serve(ln)
	defer srv.Close()

	dial := func(s gossh.Signer) (*gossh.Client, error) {
		return gossh.Dial("tcp", ln.Addr().String(), &gossh.ClientConfig{
			User: "anyone", Auth: []gossh.AuthMethod{gossh.PublicKeys(s)},
			HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: 5 * time.Second,
		})
	}
	if c, err := dial(stranger); err == nil {
		c.Close()
		t.Fatal("a key not in the users file signed on")
	}
	c, err := dial(signer)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var out syncBuffer
	s.Stdout = &out
	in, _ := s.StdinPipe()
	if err := s.RequestPty("xterm-256color", 30, 100, gossh.TerminalModes{}); err != nil {
		t.Fatal(err)
	}
	if err := s.Shell(); err != nil {
		t.Fatal(err)
	}
	in.Write([]byte("\x1b]11;rgb:0000/0000/0000\x07\x1b[?62c")) // the terminal answers the queries
	waitFor(t, &out, "JOHN.SMITH@EXAMPLE.COM")
	in.Write([]byte("\r")) // Enter logs on
	waitFor(t, &out, "WELCOME JOHNSMIT")

	mu.Lock()
	defer mu.Unlock()
	if len(seen) < 2 {
		t.Fatalf("requests: %q", seen)
	}
	for _, s := range seen {
		if s != "john.smith@example.com ssh.access" {
			t.Errorf("a request went as %q", s)
		}
	}
}

func waitFor(t *testing.T, out *syncBuffer, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(ansi.Strip(out.String()), want) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("never showed %q:\n%s", want, out.String())
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}
