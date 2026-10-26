package main

import "testing"

func TestPrivate(t *testing.T) {
	for url, want := range map[string]bool{
		"https://pos.example.com":  true,
		"http://localhost:8787":    true,
		"http://127.0.0.1:8787":    true,
		"http://[::1]:8787":        true,
		"http://pos.example.com":   false,
		"http://192.168.1.20:8787": false,
		"ftp://pos.example.com":    false,
	} {
		if got := private(url); got != want {
			t.Errorf("private(%q) = %v, want %v", url, got, want)
		}
	}
}
