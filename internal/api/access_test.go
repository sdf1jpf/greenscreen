package api

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// fakeCloudflared writes a stand-in for cloudflared that has no token until
// "access login" has run.
func fakeCloudflared(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell script stand-in")
	}
	dir := t.TempDir()
	script := `#!/bin/sh
state="` + dir + `/signed-in"
case "$2" in
token) [ -f "$state" ] && echo "jwt-for-$3" && exit 0; echo "Unable to find token" >&2; exit 1 ;;
login) touch "$state" ;;
esac
`
	path := filepath.Join(dir, "cloudflared")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCloudflaredSignsInWhenNeeded(t *testing.T) {
	c := Cloudflared{App: "https://api.example", Path: fakeCloudflared(t)}
	for range 2 { // first signs in, second uses the cached token
		h, err := c.Headers(context.Background())
		if err != nil || h.Get("cf-access-token") != "jwt-for--app=https://api.example" {
			t.Fatalf("headers: %v %v", h, err)
		}
	}
}

func TestCloudflaredMissing(t *testing.T) {
	c := Cloudflared{App: "https://api.example", Path: filepath.Join(t.TempDir(), "nope")}
	if _, err := c.Headers(context.Background()); !errors.Is(err, ErrNoCloudflared) {
		t.Fatalf("got %v", err)
	}
}
