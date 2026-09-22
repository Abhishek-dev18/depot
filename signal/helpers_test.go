package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// clientIP decides the rate-limit key, so getting it wrong is not a
// cosmetic bug: a client that can choose its own key has no rate limit.
func TestClientIPIgnoresForwardedHeaderUnlessTrusted(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	r.RemoteAddr = "203.0.113.9:54321"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")

	if got := clientIP(r, false); got != "203.0.113.9" {
		t.Fatalf("untrusted proxy: header was believed, got %q", got)
	}
}

func TestClientIPTakesTheLastForwardedEntry(t *testing.T) {
	// The header is a list the client can prepend to. Only the final
	// entry was appended by the proxy we trust; taking the first, or the
	// whole string, hands every client a fresh key per request and with
	// it an unlimited allowance.
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "spoofed, also-spoofed, 198.51.100.7")

	if got := clientIP(r, true); got != "198.51.100.7" {
		t.Fatalf("want the proxy's own entry, got %q", got)
	}
}

func TestClientIPFallsBackWhenTheHeaderIsAbsentOrAddressIsOdd(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	r.RemoteAddr = "192.0.2.5:9999"
	if got := clientIP(r, true); got != "192.0.2.5" {
		t.Fatalf("trusted proxy, no header: got %q", got)
	}

	// A RemoteAddr with no port is not something net/http produces, but
	// returning "" would collapse every such caller onto one key.
	r2 := httptest.NewRequest(http.MethodGet, "/ws", nil)
	r2.RemoteAddr = "not-a-host-port"
	if got := clientIP(r2, false); got != "not-a-host-port" {
		t.Fatalf("unparseable address: got %q", got)
	}
}

func TestEnvOr(t *testing.T) {
	const key = "DEPOT_SIGNAL_TEST_ENVOR"
	t.Setenv(key, "")
	if got := envOr(key, "fallback"); got != "fallback" {
		t.Fatalf("empty should fall back, got %q", got)
	}
	if err := os.Setenv(key, "set"); err != nil {
		t.Fatal(err)
	}
	if got := envOr(key, "fallback"); got != "set" {
		t.Fatalf("want the value, got %q", got)
	}
}

// Sweep is what stops the limiter's map growing for the life of the
// process — one key per address that ever connected.
func TestRateLimiterSweepDropsExpiredKeysOnly(t *testing.T) {
	r := NewRateLimiter(5, 50*time.Millisecond)

	if !r.Allow("stale") {
		t.Fatal("first hit should be allowed")
	}
	time.Sleep(80 * time.Millisecond)
	if !r.Allow("fresh") {
		t.Fatal("fresh hit should be allowed")
	}

	r.Sweep()

	r.mu.Lock()
	_, staleKept := r.hits["stale"]
	_, freshKept := r.hits["fresh"]
	size := len(r.hits)
	r.mu.Unlock()

	if staleKept {
		t.Error("a key with nothing inside the window was kept")
	}
	if !freshKept {
		t.Error("a key with a live hit was dropped, which would reset its allowance")
	}
	if size != 1 {
		t.Errorf("want exactly the live key, have %d", size)
	}
}

func TestRateLimiterSweepIsSafeWhenEmpty(t *testing.T) {
	NewRateLimiter(1, time.Second).Sweep()
}

func TestRateLimiterAllowsAgainOnceTheWindowPasses(t *testing.T) {
	r := NewRateLimiter(2, 40*time.Millisecond)
	if !r.Allow("k") || !r.Allow("k") {
		t.Fatal("the first two should be allowed")
	}
	if r.Allow("k") {
		t.Fatal("the third inside the window should not be")
	}
	time.Sleep(60 * time.Millisecond)
	if !r.Allow("k") {
		t.Fatal("the window passed; it should be allowed again")
	}
}

// The error paths in the relay handlers: each one is a case where Signal
// must refuse rather than route, and refusing is the whole of its job.
func TestRelayFromAnUnknownConnectionIsRefused(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	ws := dial(t, url)
	defer ws.Close()

	// No hello, no join, no register — this connection has no role.
	send(t, ws, Envelope{Type: "pair_response", Payload: []byte(`{}`)})
	if got := recvEnvelope(t, ws); got.Reason != ReasonNoRoute {
		t.Fatalf("want %q, got %q", ReasonNoRoute, got.Reason)
	}
}

func TestRevokeFromAClientIsRefused(t *testing.T) {
	// Only the Depot may revoke. A Client that could would be able to
	// cut off its siblings.
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	ws := dial(t, url)
	defer ws.Close()
	send(t, ws, Envelope{Type: TypeHello, SessionID: "s-revoke-test"})
	if got := recvEnvelope(t, ws); got.Type != TypeSessionCreated {
		t.Fatalf("want the room to open first, got %q", got.Type)
	}

	send(t, ws, Envelope{Type: TypeRevoke, ClientID: "someone"})
	if got := recvEnvelope(t, ws); got.Reason != ReasonBadEnvelope {
		t.Fatalf("want %q, got %q", ReasonBadEnvelope, got.Reason)
	}
}

func TestRevokeWithoutAClientIDIsRefused(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	depot := dial(t, url)
	defer depot.Close()
	registerDepot(t, depot)

	send(t, depot, Envelope{Type: TypeRevoke})
	if got := recvEnvelope(t, depot); got.Reason != ReasonBadEnvelope {
		t.Fatalf("want %q, got %q", ReasonBadEnvelope, got.Reason)
	}
}

func TestDepotRelayWithoutAClientIDIsRefused(t *testing.T) {
	// A Depot's relay has to name which Client it is answering; without
	// it there is nowhere to send and nothing to guess from.
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	depot := dial(t, url)
	defer depot.Close()
	registerDepot(t, depot)

	send(t, depot, Envelope{Type: "challenge", Payload: []byte(`{}`)})
	if got := recvEnvelope(t, depot); got.Reason != ReasonBadEnvelope {
		t.Fatalf("want %q, got %q", ReasonBadEnvelope, got.Reason)
	}
}
