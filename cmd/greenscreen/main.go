// Command greenscreen is a 3270-style terminal for any Greenscreen
// application. It runs in your local terminal and talks to the
// application's API over HTTP; the application names itself through
// GET /v1/screen/info, so one binary serves every app.
package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/sdf1jpf/greenscreen/internal/api"
	"github.com/sdf1jpf/greenscreen/internal/host"
	"github.com/sdf1jpf/greenscreen/tn3270"
)

func main() {
	defaultURL := os.Getenv("GREENSCREEN_API_URL")
	if defaultURL == "" {
		defaultURL = "http://localhost:8787" // wrangler dev
	}
	var (
		apiURL  = flag.String("api", defaultURL, "the application's base URL (or set GREENSCREEN_API_URL)")
		sysName = flag.String("system", "", "system name shown on screens (default: the application's, else SYS1)")
		lu      = flag.String("lu", "TERM0001", "terminal name shown in the status line")
		latency = flag.Duration("latency", 0, "extra delay added to every host response, for effect")
		idle    = flag.Duration("idle", 30*time.Minute, "log off after this long without a key pressed (0 never)")
		prints  = flag.String("print-dir", defaultPrintDir(), "where the PRINT key (Ctrl+P) saves screens, and files the host sends are saved")
	)
	flag.Parse()

	acc := access(*apiURL)
	if acc != nil && !private(*apiURL) {
		fmt.Fprintf(os.Stderr, "greenscreen: %s is plain HTTP: use https:// so the Access credentials aren't sent in the clear\n", *apiURL)
		os.Exit(2)
	}
	client := api.NewClient(*apiURL, acc)
	cfg := &host.Config{SystemName: *sysName, Backend: client, DownloadDir: *prints}
	// The application names itself. If it can't be reached yet, the logon
	// screen says so when Enter is pressed; if Access keeps it from us until
	// then, the host asks again after logon.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	if info, err := client.Info(ctx); err == nil {
		cfg.SetInfo(info)
	}
	cancel()
	if cfg.SystemName == "" {
		cfg.SystemName = "SYS1"
	}
	sess := host.NewSession(cfg, *lu)
	term := tn3270.New(sess, tn3270.Options{
		LUName: *lu, SystemName: cfg.SystemName, Latency: *latency, PrintDir: *prints, IdleTimeout: *idle,
	})
	p := tea.NewProgram(term, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// access picks how to get through Cloudflare Access: a service token from
// the environment, nothing for a local `wrangler dev`, or else a browser
// sign-in with cloudflared.
func access(apiURL string) api.Access {
	if id, secret := os.Getenv("CF_ACCESS_CLIENT_ID"), os.Getenv("CF_ACCESS_CLIENT_SECRET"); id != "" && secret != "" {
		return api.ServiceToken{ID: id, Secret: secret}
	}
	if u, err := url.Parse(apiURL); err == nil && loopback(u.Hostname()) {
		return nil
	}
	return api.Cloudflared{App: apiURL}
}

// private says credentials sent to apiURL can't be read on the way: it is
// HTTPS, or it is on this machine.
func private(apiURL string) bool {
	u, err := url.Parse(apiURL)
	return err == nil && (u.Scheme == "https" || loopback(u.Hostname()))
}

func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// defaultPrintDir is ~/terminal-prints, or the current directory if there
// is no home directory.
func defaultPrintDir() string {
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, "terminal-prints")
	}
	return "."
}
