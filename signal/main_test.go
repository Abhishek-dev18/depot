package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func testServer(t *testing.T, hub *Hub) (*httptest.Server, string) {
	t.Helper()
	mux := http.NewServeMux()
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	logger := log.New(testWriter{t}, "", 0)
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade: %v", err)
		}
		handleConn(hub, ws, clientIP(r, false), logger)
	})
	srv := httptest.NewServer(mux)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	return srv, wsURL
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

func dial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { ws.Close() })
	return ws
}

func send(t *testing.T, ws *websocket.Conn, e Envelope) {
	t.Helper()
	if err := ws.WriteJSON(e); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func recvEnvelope(t *testing.T, ws *websocket.Conn) Envelope {
	t.Helper()
	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	var e Envelope
	if err := ws.ReadJSON(&e); err != nil {
		t.Fatalf("read: %v", err)
	}
	return e
}

func newHubForTest() *Hub {
	h := NewHub(log.New(logDiscard{}, "", 0))
	return h
}

type logDiscard struct{}

func (logDiscard) Write(p []byte) (int, error) { return len(p), nil }

// --- Pairing flow (protocol.md §3.2) ---

func TestPairingHappyPath(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	client := dial(t, url)
	depot := dial(t, url)

	send(t, client, Envelope{Type: TypeHello, SessionID: "sess-1"})
	if e := recvEnvelope(t, client); e.Type != TypeSessionCreated {
		t.Fatalf("expected session_created, got %+v", e)
	}
	send(t, depot, Envelope{Type: TypeJoin, SessionID: "sess-1"})

	// Both sides get peer_joined.
	if e := recvEnvelope(t, client); e.Type != TypePeerJoined {
		t.Fatalf("client expected peer_joined, got %+v", e)
	}
	if e := recvEnvelope(t, depot); e.Type != TypePeerJoined {
		t.Fatalf("depot expected peer_joined, got %+v", e)
	}

	// Depot -> Client: PAIR_RESPONSE relayed opaquely.
	payload := json.RawMessage(`{"depotEk":"abc","depotIk":"def","sig":"xyz"}`)
	send(t, depot, Envelope{Type: "PAIR_RESPONSE", Payload: payload})
	got := recvEnvelope(t, client)
	if got.Type != "PAIR_RESPONSE" || string(got.Payload) != string(payload) {
		t.Fatalf("unexpected relay: %+v", got)
	}

	// Client -> Depot direction also relays.
	confirmAck := json.RawMessage(`{"ok":true}`)
	send(t, client, Envelope{Type: "ACK", Payload: confirmAck})
	got = recvEnvelope(t, depot)
	if got.Type != "ACK" || string(got.Payload) != string(confirmAck) {
		t.Fatalf("unexpected relay to depot: %+v", got)
	}
}

func TestPairingSessionFull(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	client := dial(t, url)
	depotA := dial(t, url)
	depotB := dial(t, url)

	send(t, client, Envelope{Type: TypeHello, SessionID: "sess-2"})
	recvEnvelope(t, client) // session_created
	send(t, depotA, Envelope{Type: TypeJoin, SessionID: "sess-2"})
	recvEnvelope(t, client) // peer_joined
	recvEnvelope(t, depotA)

	send(t, depotB, Envelope{Type: TypeJoin, SessionID: "sess-2"})
	e := recvEnvelope(t, depotB)
	if e.Type != TypeError || e.Reason != ReasonSessionFull {
		t.Fatalf("expected session_full, got %+v", e)
	}
}

func TestPairingSessionNotFound(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	depot := dial(t, url)
	send(t, depot, Envelope{Type: TypeJoin, SessionID: "does-not-exist"})
	e := recvEnvelope(t, depot)
	if e.Type != TypeError || e.Reason != ReasonSessionNotFound {
		t.Fatalf("expected session_not_found, got %+v", e)
	}
}

func TestPairingSessionExpiry(t *testing.T) {
	hub := newHubForTest()
	hub.sessionTTL = 100 * time.Millisecond
	srv, url := testServer(t, hub)
	defer srv.Close()

	client := dial(t, url)
	send(t, client, Envelope{Type: TypeHello, SessionID: "sess-expire"})
	recvEnvelope(t, client) // session_created

	e := recvEnvelope(t, client)
	if e.Type != TypeError || e.Reason != ReasonSessionExpired {
		t.Fatalf("expected session_expired, got %+v", e)
	}
}

func TestPairingPeerLeftOnDisconnect(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	client := dial(t, url)
	depot := dial(t, url)

	send(t, client, Envelope{Type: TypeHello, SessionID: "sess-3"})
	recvEnvelope(t, client) // session_created
	send(t, depot, Envelope{Type: TypeJoin, SessionID: "sess-3"})
	recvEnvelope(t, client)
	recvEnvelope(t, depot)

	depot.Close()

	e := recvEnvelope(t, client)
	if e.Type != TypePeerLeft {
		t.Fatalf("expected peer_left, got %+v", e)
	}
}

func TestRateLimitPairingSessions(t *testing.T) {
	hub := newHubForTest()
	hub.limiter = NewRateLimiter(2, time.Minute)
	srv, url := testServer(t, hub)
	defer srv.Close()

	ok1 := dial(t, url)
	send(t, ok1, Envelope{Type: TypeHello, SessionID: "s1"})
	recvEnvelope(t, ok1) // session_created

	ok2 := dial(t, url)
	send(t, ok2, Envelope{Type: TypeHello, SessionID: "s2"})
	recvEnvelope(t, ok2) // session_created

	blocked := dial(t, url)
	send(t, blocked, Envelope{Type: TypeHello, SessionID: "s3"})
	e := recvEnvelope(t, blocked)
	if e.Type != TypeError || e.Reason != ReasonRateLimited {
		t.Fatalf("expected rate_limited, got %+v", e)
	}
}

// --- Reconnection flow (protocol.md §4) ---

func TestReconnectionHappyPath(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	depot := dial(t, url)
	send(t, depot, Envelope{Type: TypeRegister, DepotID: "depot-1"})

	client := dial(t, url)
	reconnectPayload := json.RawMessage(`{"credential":"cred","clientEk":"ek"}`)
	send(t, client, Envelope{Type: TypeConnect, DepotID: "depot-1", ClientID: "client-1", Payload: reconnectPayload})

	incoming := recvEnvelope(t, depot)
	if incoming.Type != TypeIncoming || incoming.ClientID != "client-1" {
		t.Fatalf("expected incoming for client-1, got %+v", incoming)
	}
	if string(incoming.Payload) != string(reconnectPayload) {
		t.Fatalf("payload not forwarded intact: %s", incoming.Payload)
	}

	challenge := json.RawMessage(`{"depotEk":"dek","challengeNonce":"n"}`)
	send(t, depot, Envelope{Type: "CHALLENGE", ClientID: "client-1", Payload: challenge})
	got := recvEnvelope(t, client)
	if got.Type != "CHALLENGE" || string(got.Payload) != string(challenge) {
		t.Fatalf("client did not get challenge: %+v", got)
	}

	response := json.RawMessage(`{"sig":"signature"}`)
	send(t, client, Envelope{Type: "RESPONSE", Payload: response})
	got = recvEnvelope(t, depot)
	if got.Type != "RESPONSE" || got.ClientID != "client-1" || string(got.Payload) != string(response) {
		t.Fatalf("depot did not get tagged response: %+v", got)
	}

	send(t, depot, Envelope{Type: "SESSION_OK", ClientID: "client-1"})
	got = recvEnvelope(t, client)
	if got.Type != "SESSION_OK" {
		t.Fatalf("client did not get session_ok: %+v", got)
	}
}

func TestReconnectionDepotOffline(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	client := dial(t, url)
	send(t, client, Envelope{Type: TypeConnect, DepotID: "ghost", ClientID: "c1"})
	e := recvEnvelope(t, client)
	if e.Type != TypeError || e.Reason != ReasonDepotOffline {
		t.Fatalf("expected depot_offline, got %+v", e)
	}
}

func TestRevocationBlocksFutureConnect(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	depot := dial(t, url)
	send(t, depot, Envelope{Type: TypeRegister, DepotID: "depot-rev"})

	send(t, depot, Envelope{Type: TypeRevoke, ClientID: "bad-client"})

	client := dial(t, url)
	send(t, client, Envelope{Type: TypeConnect, DepotID: "depot-rev", ClientID: "bad-client"})
	e := recvEnvelope(t, client)
	if e.Type != TypeError || e.Reason != ReasonClientRevoked {
		t.Fatalf("expected client_revoked, got %+v", e)
	}
}

func TestRevocationClosesActiveRoute(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	depot := dial(t, url)
	send(t, depot, Envelope{Type: TypeRegister, DepotID: "depot-live"})

	client := dial(t, url)
	send(t, client, Envelope{Type: TypeConnect, DepotID: "depot-live", ClientID: "live-client"})
	recvEnvelope(t, depot) // incoming

	send(t, depot, Envelope{Type: TypeRevoke, ClientID: "live-client"})
	e := recvEnvelope(t, client)
	if e.Type != TypeError || e.Reason != ReasonClientRevoked {
		t.Fatalf("expected client_revoked on active route, got %+v", e)
	}
}

func TestDepotGoingOfflineNotifiesActiveClients(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	depot := dial(t, url)
	send(t, depot, Envelope{Type: TypeRegister, DepotID: "depot-drop"})

	client := dial(t, url)
	send(t, client, Envelope{Type: TypeConnect, DepotID: "depot-drop", ClientID: "c1"})
	recvEnvelope(t, depot)

	depot.Close()

	e := recvEnvelope(t, client)
	if e.Type != TypeError || e.Reason != ReasonDepotOffline {
		t.Fatalf("expected depot_offline, got %+v", e)
	}
}

func TestBadEnvelope(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	ws := dial(t, url)
	if err := ws.WriteMessage(websocket.TextMessage, []byte("not json")); err != nil {
		t.Fatalf("write: %v", err)
	}
	e := recvEnvelope(t, ws)
	if e.Type != TypeError || e.Reason != ReasonBadEnvelope {
		t.Fatalf("expected bad_envelope, got %+v", e)
	}
}
