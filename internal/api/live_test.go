package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestListen(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/live" || r.Header.Get("CF-Access-Client-Id") != "id" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for _, m := range []string{"pong", `{"event":"syslog","seq":7}`, `{"event":"message"}`} {
			conn.Write(r.Context(), websocket.MessageText, []byte(m))
		}
		conn.Close(websocket.StatusNormalClosure, "")
	}))
	defer srv.Close()

	c := NewClient(srv.URL, ServiceToken{ID: "id", Secret: "secret"})
	if err := c.Listen(context.Background(), func() {}, func(string) {}); err != ErrUnauthorized {
		t.Fatalf("Listen before logon = %v, want ErrUnauthorized", err)
	}
	c.setHeaders(http.Header{"Cf-Access-Client-Id": {"id"}})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	opened := false
	var got []string
	err := c.Listen(ctx, func() { opened = true }, func(e string) { got = append(got, e) })
	if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("Listen = %v, want a normal close", err)
	}
	if !opened || len(got) != 2 || got[0] != "syslog" || got[1] != "message" {
		t.Fatalf("opened %v, events %q", opened, got)
	}
}
