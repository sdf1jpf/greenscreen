package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/ssh"
	"github.com/charmbracelet/wish"
	"github.com/charmbracelet/wish/activeterm"
	bm "github.com/charmbracelet/wish/bubbletea"
	"github.com/charmbracelet/wish/logging"
	"github.com/muesli/termenv"
	gossh "golang.org/x/crypto/ssh"

	"github.com/sdf1jpf/greenscreen/internal/api"
	"github.com/sdf1jpf/greenscreen/internal/host"
	"github.com/sdf1jpf/greenscreen/tn3270"
)

// serveSSH runs `greenscreen serve-ssh`: an SSH server whose every session
// is this terminal, so anyone with an SSH client can use the application
// without installing anything. Each person signs on with their SSH key,
// which the users file names an email for; the server sends their requests
// with its own service token, naming them in the Greenscreen-User header,
// and the application trusts it to with gatewayAuth.
func serveSSH(args []string) error {
	fs := flag.NewFlagSet("serve-ssh", flag.ExitOnError)
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "usage: greenscreen serve-ssh [flags]\n\nServe the terminal over SSH, signing people on by their SSH keys.")
		fs.PrintDefaults()
	}
	defaultURL := os.Getenv("GREENSCREEN_API_URL")
	if defaultURL == "" {
		defaultURL = "http://localhost:8787"
	}
	var (
		listen  = fs.String("listen", ":2222", "address to listen on")
		apiURL  = fs.String("api", defaultURL, "the application's base URL (or set GREENSCREEN_API_URL)")
		sysName = fs.String("system", "", "system name shown on screens (default: the application's, else SYS1)")
		hostKey = fs.String("host-key", defaultHostKey(), "the server's private host key, made if it doesn't exist")
		users   = fs.String("users", "users", "who may sign on: lines of an email and the public key that signs them on")
		idle    = fs.Duration("idle", 30*time.Minute, "log off after this long without a key pressed (0 never)")
	)
	fs.Parse(args)

	gw, err := gatewayAccess(*apiURL)
	if err != nil {
		return err
	}
	if _, err := loadUsers(*users); err != nil {
		return err // the file is read again on each sign-on, but should work from the start
	}
	cfg := &host.Config{SystemName: *sysName}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	if info, err := api.NewClient(*apiURL, nil).Info(ctx); err == nil {
		cfg.SetInfo(info)
	}
	cancel()
	if cfg.SystemName == "" {
		cfg.SystemName = "SYS1"
	}
	srv, err := newSSHServer(sshConfig{
		Listen: *listen, HostKey: *hostKey, Users: &userFile{path: *users},
		API: *apiURL, Gateway: gw, Host: cfg, Idle: *idle,
	})
	if err != nil {
		return err
	}

	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-done
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()
	log.Printf("greenscreen: serving %s over SSH on %s", *apiURL, *listen)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, ssh.ErrServerClosed) {
		return err
	}
	return nil
}

// gatewayAccess is the server's own way through Cloudflare Access: a
// service token from the environment, or nothing for a local `wrangler dev`.
// There is no browser to sign in with.
func gatewayAccess(apiURL string) (api.Access, error) {
	id, secret := os.Getenv("CF_ACCESS_CLIENT_ID"), os.Getenv("CF_ACCESS_CLIENT_SECRET")
	if id == "" || secret == "" {
		if a := access(apiURL); a != nil {
			return nil, errors.New("serve-ssh needs the gateway's service token: set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET")
		}
		return nil, nil
	}
	if !private(apiURL) {
		return nil, fmt.Errorf("%s is plain HTTP: use https:// so the service token isn't sent in the clear", apiURL)
	}
	return api.ServiceToken{ID: id, Secret: secret}, nil
}

type sshConfig struct {
	Listen  string
	HostKey string
	Users   *userFile
	API     string
	Gateway api.Access   // nil for a local `wrangler dev`
	Host    *host.Config // copied for each session, with its own Backend
	Idle    time.Duration
}

// newSSHServer returns the server, not yet listening.
func newSSHServer(c sshConfig) (*ssh.Server, error) {
	var lus atomic.Uint32
	session := func(s ssh.Session) (tea.Model, []tea.ProgramOption) {
		// The key the client proved it holds, not one it only offered:
		// look the person up again rather than trust what auth saw.
		email, ok := c.Users.lookup(s.PublicKey())
		if !ok {
			wish.Fatalln(s, "greenscreen: your key is no longer allowed to sign on")
			return nil, nil
		}
		cfg := *c.Host
		cfg.Backend = api.NewClient(c.API, api.OnBehalf{Gateway: c.Gateway, User: email})
		cfg.DownloadDir = "" // it would be this server's disk, not theirs
		cfg.SignOn = []string{"Your SSH key signs you on as", strings.ToUpper(clip(email, 54)) + "."}
		lu := fmt.Sprintf("SSH%05d", lus.Add(1)%100000)
		sess := host.NewSession(&cfg, lu)
		go func() {
			<-s.Context().Done()
			sess.Close()
		}()
		term := tn3270.New(sess, tn3270.Options{
			LUName: lu, SystemName: cfg.SystemName, IdleTimeout: c.Idle, NoPrint: true, Renderer: bm.MakeRenderer(s),
		})
		return term, []tea.ProgramOption{tea.WithAltScreen(), tea.WithMouseCellMotion()}
	}
	return wish.NewServer(
		wish.WithAddress(c.Listen),
		wish.WithHostKeyPath(c.HostKey),
		wish.WithPublicKeyAuth(func(_ ssh.Context, key ssh.PublicKey) bool {
			_, ok := c.Users.lookup(key)
			return ok
		}),
		wish.WithMiddleware(
			bm.MiddlewareWithColorProfile(session, termenv.ANSI), // the eight 3270 colors
			activeterm.Middleware(),                              // a terminal, not a command
			logging.Middleware(),
		),
	)
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n-3] + "..."
	}
	return s
}

// defaultHostKey is greenscreen/ssh_host_ed25519_key in the user's config
// directory, or in the current directory if there is none.
func defaultHostKey() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "greenscreen", "ssh_host_ed25519_key")
	}
	return "ssh_host_ed25519_key"
}

// userFile is the users file, read again whenever it changes, so people
// are added and removed without a restart.
type userFile struct {
	path string

	mu    sync.Mutex
	mod   time.Time
	size  int64
	users map[string]string // marshalled public key -> email
}

// lookup returns the email key signs on, if any.
func (u *userFile) lookup(key ssh.PublicKey) (string, bool) {
	if key == nil {
		return "", false
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if fi, err := os.Stat(u.path); err != nil {
		log.Printf("greenscreen: %v", err)
	} else if u.users == nil || !fi.ModTime().Equal(u.mod) || fi.Size() != u.size {
		if users, err := loadUsers(u.path); err != nil {
			log.Printf("greenscreen: %v (keeping the users from before)", err)
		} else {
			u.users, u.mod, u.size = users, fi.ModTime(), fi.Size()
		}
	}
	email, ok := u.users[string(key.Marshal())]
	return email, ok
}

func loadUsers(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("users file: %w", err)
	}
	defer f.Close()
	users, err := parseUsers(f)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return users, nil
}

var email = regexp.MustCompile(`^[^\s@]+@[^\s@]+$`)

// parseUsers reads lines of an email and a public key as authorized_keys
// writes it, such as
//
//	john.smith@example.com ssh-ed25519 AAAAC3Nza... john@laptop
//
// with # comments and blank lines. A person may have several keys; a key
// signs on one person.
func parseUsers(r io.Reader) (map[string]string, error) {
	users := map[string]string{}
	sc := bufio.NewScanner(r)
	sc.Buffer(nil, 1<<20)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		who, rest, _ := strings.Cut(line, " ")
		if !email.MatchString(who) {
			return nil, fmt.Errorf("line %d: %q is not an email", n, who)
		}
		key, _, _, _, err := gossh.ParseAuthorizedKey([]byte(strings.TrimSpace(rest)))
		if err != nil {
			return nil, fmt.Errorf("line %d: %v", n, err)
		}
		k := string(key.Marshal())
		if other, ok := users[k]; ok && other != strings.ToLower(who) {
			return nil, fmt.Errorf("line %d: the key already signs on %s", n, other)
		}
		users[k] = strings.ToLower(who)
	}
	return users, sc.Err()
}
