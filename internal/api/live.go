package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// keepalive is how often Listen pings, so idle proxies keep the
// connection open. The Worker answers "ping" with "pong".
const keepalive = 30 * time.Second

// Listen connects to GET /v1/live, a WebSocket on which the API says when
// the screen should be redrawn: {"event":"syslog"} when the system log has
// moved, {"event":"message"} when a SEND has come for this user. It calls
// opened once connected, then on with each event's name, until the
// connection drops or ctx ends, and returns why.
func (c *Client) Listen(ctx context.Context, opened func(), on func(event string)) error {
	hdr := c.headers()
	if hdr == nil {
		return ErrUnauthorized
	}
	u := "ws" + strings.TrimPrefix(c.base, "http") + "/v1/live"
	conn, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: hdr.Clone()})
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer conn.CloseNow()
	opened()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		t := time.NewTicker(keepalive)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				conn.Write(ctx, websocket.MessageText, []byte("ping"))
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var ev struct {
			Event string `json:"event"`
		}
		if json.Unmarshal(data, &ev) == nil && ev.Event != "" { // not a "pong"
			on(ev.Event)
		}
	}
}
