package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// stub answers like the Worker does for a few fixed requests.
func stub(t *testing.T, access Access) *Client {
	t.Helper()
	mux := http.NewServeMux()
	reply := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(v)
	}
	fail := func(w http.ResponseWriter, status int, code, field string) {
		reply(w, status, map[string]any{"error": map[string]string{"code": code, "message": "msg " + code, "field": field}})
	}
	// Like Access: no token is redirected to login, a token for someone the
	// policy does not allow is refused with a bare 403.
	gate := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			switch r.Header.Get("CF-Access-Client-Id") {
			case "":
				http.Redirect(w, r, "https://team.cloudflareaccess.com/cdn-cgi/access/login", http.StatusFound)
			case "id":
				next(w, r)
			default:
				http.Error(w, "Forbidden", http.StatusForbidden)
			}
		}
	}

	mux.HandleFunc("POST /v1/session", gate(func(w http.ResponseWriter, r *http.Request) {
		reply(w, 201, map[string]string{"userid": "IBMUSER"})
	}))
	mux.HandleFunc("POST /v1/screen", gate(func(w http.ResponseWriter, r *http.Request) {
		var req ScreenRequest
		json.NewDecoder(r.Body).Decode(&req)
		if req.V != ScreenVersion || req.AID != "PF3" || req.State != "s1" || req.Fields["opt"] != "A&B" {
			fail(w, 400, "bad_request", "")
			return
		}
		reply(w, 200, map[string]any{"v": 1, "state": "s2", "screen": map[string]any{
			"map": "M1", "rows": 24, "cols": 80, "cursor": map[string]any{"field": "x"},
			"fields": []map[string]any{{"row": 1, "col": 2, "text": "HI", "color": "blue"}, {"row": 3, "col": 2, "name": "x", "length": 4}},
		}})
	}))
	mux.HandleFunc("GET /v1/expired", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://team.cloudflareaccess.com/cdn-cgi/access/login", http.StatusFound)
	})
	mux.HandleFunc("GET /v1/broken", func(w http.ResponseWriter, r *http.Request) { fail(w, 500, "internal", "") })

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return NewClient(srv.URL+"/", access)
}

func TestClient(t *testing.T) {
	c := stub(t, ServiceToken{"id", "secret"})
	ctx := context.Background()
	req := ScreenRequest{AID: "PF3", State: "s1", Fields: map[string]string{"opt": "A&B"}}

	if _, err := c.Screen(ctx, req); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("screen before logon: %v", err)
	}
	if user, err := c.Logon(ctx); err != nil || user != "IBMUSER" {
		t.Fatalf("logon: %q %v", user, err)
	}

	resp, err := c.Screen(ctx, req)
	if err != nil || resp.State != "s2" || resp.Screen == nil || len(resp.Screen.Fields) != 2 ||
		resp.Screen.Fields[1].Name != "x" || resp.Screen.Cursor.Field != "x" || resp.Logoff != nil {
		t.Fatalf("screen: %+v %v", resp, err)
	}
	if err := c.do(ctx, http.MethodGet, "/v1/broken", nil, nil); err == nil || err.Error() != "api: msg internal" {
		t.Fatalf("other errors keep the API's message: %v", err)
	}
	if err := c.Logoff(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Screen(ctx, req); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("headers kept after logoff: %v", err)
	}
	if c.Host() == "" {
		t.Fatal("no host")
	}
}

func TestClientAccessRefusals(t *testing.T) {
	ctx := context.Background()
	if _, err := stub(t, nil).Logon(ctx); !errors.Is(err, ErrBadLogon) {
		t.Fatalf("redirected to Access login: %v", err)
	}
	if _, err := stub(t, ServiceToken{"other", "secret"}).Logon(ctx); !errors.Is(err, ErrBadLogon) {
		t.Fatalf("refused by Access policy: %v", err)
	}

	c := stub(t, ServiceToken{"id", "secret"})
	if _, err := c.Logon(ctx); err != nil {
		t.Fatal(err)
	}
	if err := c.do(ctx, http.MethodGet, "/v1/expired", nil, nil); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Access token expired: %v", err)
	}
	if _, err := c.Screen(ctx, ScreenRequest{}); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("headers kept after expiry: %v", err)
	}
}

func TestClientHostDown(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", nil)
	if _, err := c.Logon(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("got %v", err)
	}
}

func TestInfo(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/screen/info" {
			http.Redirect(w, r, "https://team.cloudflareaccess.com/cdn-cgi/access/login", http.StatusFound)
			return
		}
		w.Write([]byte(`{"v":1,"title":"POINT OF SALE","system":"POS1","prefix":"POS","banner":["STORE 42"]}`))
	}))
	defer srv.Close()
	info, err := NewClient(srv.URL, nil).Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.Title != "POINT OF SALE" || info.Prefix != "POS" || info.System != "POS1" || len(info.Banner) != 1 {
		t.Errorf("info = %+v", info)
	}
	if _, err := NewClient(srv.URL+"/behind-access", nil).Info(context.Background()); err == nil {
		t.Error("an Access redirect should be an error")
	}
}
