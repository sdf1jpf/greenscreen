package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Client calls the application's API on behalf of one logged-on user.
type Client struct {
	base   string
	http   *http.Client
	slow   *http.Client // for snapshots, which start a browser
	access Access       // nil when the API is not behind Cloudflare Access

	mu  sync.Mutex
	hdr http.Header // Access headers for the logged-on user; nil when logged off
}

func (c *Client) headers() http.Header {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hdr
}

func (c *Client) setHeaders(h http.Header) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.hdr = h
}

// NewClient returns a client for the API at baseURL. access may be nil, for
// a local `wrangler dev`.
func NewClient(baseURL string, access Access) *Client {
	// Access answers a missing or expired token with a redirect to its
	// login page; report that rather than following it.
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{
		base:   strings.TrimRight(baseURL, "/"),
		access: access,
		http:   &http.Client{Timeout: 10 * time.Second, CheckRedirect: noRedirect},
		slow:   &http.Client{Timeout: 60 * time.Second, CheckRedirect: noRedirect},
	}
}

// Host returns the server's host:port, for display.
func (c *Client) Host() string {
	if u, err := url.Parse(c.base); err == nil && u.Host != "" {
		return u.Host
	}
	return c.base
}

// Logon signs in through Cloudflare Access, which may open a browser, and
// returns the userid the API knows the user by.
func (c *Client) Logon(ctx context.Context) (string, error) {
	hdr := http.Header{}
	if c.access != nil {
		h, err := c.access.Headers(ctx)
		if err != nil {
			return "", err
		}
		hdr = h
	}
	c.setHeaders(hdr)
	var resp LogonResponse
	if err := c.do(ctx, http.MethodPost, "/v1/session", nil, &resp); err != nil {
		c.setHeaders(nil)
		if errors.Is(err, ErrUnauthorized) {
			err = ErrBadLogon
		}
		return "", err
	}
	return resp.UserID, nil
}

// Info asks the application what it calls itself. It needs no logon,
// though Access must let the path through (a Bypass policy) for it to work
// before sign-in.
func (c *Client) Info(ctx context.Context) (AppInfo, error) {
	var info AppInfo
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/v1/screen/info", nil)
	if err != nil {
		return info, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return info, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return info, fmt.Errorf("api: info: %s", resp.Status)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&info); err != nil {
		return info, fmt.Errorf("api: bad response: %w", err)
	}
	return info, nil
}

// Logoff forgets the user locally. Access sessions end on their own.
func (c *Client) Logoff(context.Context) error {
	c.setHeaders(nil)
	return nil
}

// Screen sends an AID key and the screen's input to the API and returns
// the next screen.
func (c *Client) Screen(ctx context.Context, req ScreenRequest) (ScreenResponse, error) {
	req.V = ScreenVersion
	var out ScreenResponse
	err := c.do(ctx, http.MethodPost, "/v1/screen", req, &out)
	return out, err
}

// MaxDownload is the largest file Download will take.
const MaxDownload = 32 << 20

// Download fetches a file from the API, such as a PDF a screen sent along.
func (c *Client) Download(ctx context.Context, path string) ([]byte, error) {
	resp, err := c.send(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, MaxDownload+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if len(b) > MaxDownload {
		return nil, errors.New("api: file too large")
	}
	return b, nil
}

// Snapshot has the API draw a screen as a PNG or PDF and returns the file
// and the name the API gave it.
func (c *Client) Snapshot(ctx context.Context, req SnapshotRequest) ([]byte, string, error) {
	resp, err := c.sendVia(ctx, c.slow, http.MethodPost, "/v1/snapshot", req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, MaxDownload+1))
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if len(b) > MaxDownload {
		return nil, "", errors.New("api: file too large")
	}
	_, params, _ := mime.ParseMediaType(resp.Header.Get("Content-Disposition"))
	return b, params["filename"], nil
}

// do sends a request and decodes the response into out. API errors are
// mapped to the package's sentinel errors.
func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
	resp, err := c.send(ctx, method, path, in)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("api: bad response: %w", err)
	}
	return nil
}

// send makes a request and returns a successful response, whose body the
// caller closes. API errors are mapped to the package's sentinel errors.
func (c *Client) send(ctx context.Context, method, path string, in any) (*http.Response, error) {
	return c.sendVia(ctx, c.http, method, path, in)
}

func (c *Client) sendVia(ctx context.Context, hc *http.Client, method, path string, in any) (*http.Response, error) {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return nil, err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	hdr := c.headers()
	if hdr == nil {
		return nil, ErrUnauthorized
	}
	for k, v := range hdr {
		req.Header[k] = v
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if resp.StatusCode < 300 {
		return resp, nil
	}
	defer resp.Body.Close()
	var eb errorBody
	json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&eb)
	switch {
	case eb.Error.Code == codeUnauthorized, eb.Error.Code == "" && (resp.StatusCode < 400 || resp.StatusCode == 401):
		// From the Worker, or Access redirecting to its login page.
		c.setHeaders(nil)
		return nil, ErrUnauthorized
	case eb.Error.Code == "" && resp.StatusCode == 403:
		return nil, ErrBadLogon // Access policy does not allow this user
	}
	msg := eb.Error.Message
	if msg == "" {
		msg = resp.Status
	}
	return nil, fmt.Errorf("api: %s", msg)
}
