package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
)

// Access gets requests through Cloudflare Access, which guards the API.
// Headers returns what to add to each request, signing the user in first
// if needed, which may open a browser.
type Access interface {
	Headers(ctx context.Context) (http.Header, error)
}

// ServiceToken is an Access service token, for scripts and CI.
type ServiceToken struct{ ID, Secret string }

func (t ServiceToken) Headers(context.Context) (http.Header, error) {
	h := http.Header{}
	h.Set("CF-Access-Client-Id", t.ID)
	h.Set("CF-Access-Client-Secret", t.Secret)
	return h, nil
}

// Cloudflared signs in with the cloudflared CLI, which opens a browser for
// the team's identity provider and caches the resulting app token.
type Cloudflared struct {
	App  string // the API's base URL
	Path string // cloudflared binary; default "cloudflared" on $PATH
}

var ErrNoCloudflared = errors.New("cloudflared not found: install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/")

func (c Cloudflared) Headers(ctx context.Context) (http.Header, error) {
	tok, err := c.run(ctx, "access", "token", "-app="+c.App)
	if err != nil && !errors.Is(err, ErrNoCloudflared) {
		// No cached token, or it expired: sign in through the browser.
		if _, err = c.run(ctx, "access", "login", "--quiet", c.App); err == nil {
			tok, err = c.run(ctx, "access", "token", "-app="+c.App)
		}
	}
	if err != nil {
		return nil, err
	}
	h := http.Header{}
	h.Set("cf-access-token", tok)
	return h, nil
}

func (c Cloudflared) run(ctx context.Context, args ...string) (string, error) {
	bin := c.Path
	if bin == "" {
		bin = "cloudflared"
	}
	path, err := exec.LookPath(bin)
	if err != nil {
		return "", ErrNoCloudflared
	}
	var out, errOut bytes.Buffer
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errOut.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("cloudflared %s: %s", args[1], msg)
	}
	tok := strings.TrimSpace(out.String())
	if args[1] == "token" && (tok == "" || strings.Contains(tok, " ")) {
		return "", fmt.Errorf("cloudflared token: no token for %s", c.App)
	}
	return tok, nil
}
