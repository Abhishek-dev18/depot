package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"

	"github.com/gorilla/websocket"
)

func idOf(priv ed25519.PrivateKey) string {
	return base64.RawStdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))
}

// tryRegister runs the whole signed registration and reports whether
// Signal accepted it. Error-returning rather than fatal so goroutines
// can use it.
func tryRegister(ws *websocket.Conn, depotID string, priv ed25519.PrivateKey) error {
	if err := ws.WriteJSON(Envelope{Type: TypeRegister, DepotID: depotID}); err != nil {
		return err
	}
	var challenge Envelope
	if err := ws.ReadJSON(&challenge); err != nil {
		return err
	}
	if challenge.Type != TypeRegisterChallenge {
		return errors.New("expected " + TypeRegisterChallenge + ", got " + challenge.Type + " " + challenge.Reason)
	}
	var c registerChallenge
	if err := json.Unmarshal(challenge.Payload, &c); err != nil {
		return err
	}
	nonce, err := base64.RawStdEncoding.DecodeString(c.Nonce)
	if err != nil {
		return err
	}
	sig := ed25519.Sign(priv, registerSigningBytes(depotID, nonce))
	proof, _ := json.Marshal(registerProof{Sig: base64.RawStdEncoding.EncodeToString(sig)})
	return ws.WriteJSON(Envelope{Type: TypeRegister, DepotID: depotID, Payload: proof})
}

// registerAs registers ws as depotID and waits until Signal says it is
// reachable, so whatever the test does next cannot overtake it.
func registerAs(t *testing.T, ws *websocket.Conn, depotID string, priv ed25519.PrivateKey) {
	t.Helper()
	if err := tryRegister(ws, depotID, priv); err != nil {
		t.Fatalf("register: %v", err)
	}
	if got := recvEnvelope(t, ws); got.Type != TypeRegistered || got.DepotID != depotID {
		t.Fatalf("expected %s, got %+v", TypeRegistered, got)
	}
}

// registerDepot registers ws under a fresh identity and returns its id.
func registerDepot(t *testing.T, ws *websocket.Conn) string {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	id := idOf(priv)
	registerAs(t, ws, id, priv)
	return id
}

// Anyone who knows a depotId — any Client ever paired with it — could
// otherwise register as that Depot, push the real one off, and revoke its
// Clients here. Knowing the id is not enough; holding its key is.
func TestRegisteringAsSomeoneElsesDepotIsRefused(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	real := dial(t, url)
	depotID := registerDepot(t, real)

	_, impostorKey, _ := ed25519.GenerateKey(nil)
	impostor := dial(t, url)
	if err := tryRegister(impostor, depotID, impostorKey); err != nil {
		t.Fatalf("register: %v", err)
	}
	if got := recvEnvelope(t, impostor); got.Type != TypeError || got.Reason != ReasonUnauthorized {
		t.Fatalf("expected %s, got %+v", ReasonUnauthorized, got)
	}

	// And the real Depot is still the one Clients reach.
	client := dial(t, url)
	send(t, client, Envelope{Type: TypeConnect, DepotID: depotID, ClientID: "c1"})
	if got := recvEnvelope(t, real); got.Type != TypeIncoming || got.ClientID != "c1" {
		t.Fatalf("real Depot lost its route: %+v", got)
	}
}

// Asking without answering registers nothing: a Client connecting then
// hears the Depot is offline rather than being routed to the asker.
func TestAChallengeAloneRegistersNothing(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	_, priv, _ := ed25519.GenerateKey(nil)
	depotID := idOf(priv)
	asker := dial(t, url)
	send(t, asker, Envelope{Type: TypeRegister, DepotID: depotID})
	if got := recvEnvelope(t, asker); got.Type != TypeRegisterChallenge {
		t.Fatalf("expected %s, got %+v", TypeRegisterChallenge, got)
	}

	client := dial(t, url)
	send(t, client, Envelope{Type: TypeConnect, DepotID: depotID, ClientID: "c1"})
	if got := recvEnvelope(t, client); got.Reason != ReasonDepotOffline {
		t.Fatalf("expected %s, got %+v", ReasonDepotOffline, got)
	}
}

// A signature is good for the nonce it was made for, once. Replaying a
// proof seen on one connection gets nowhere on another.
func TestARegistrationProofCannotBeReplayed(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	_, priv, _ := ed25519.GenerateKey(nil)
	depotID := idOf(priv)

	// A genuine proof, captured.
	first := dial(t, url)
	send(t, first, Envelope{Type: TypeRegister, DepotID: depotID})
	var c registerChallenge
	_ = json.Unmarshal(recvEnvelope(t, first).Payload, &c)
	nonce, _ := base64.RawStdEncoding.DecodeString(c.Nonce)
	proof, _ := json.Marshal(registerProof{
		Sig: base64.RawStdEncoding.EncodeToString(ed25519.Sign(priv, registerSigningBytes(depotID, nonce))),
	})

	// Replayed on a connection that was issued a different nonce.
	replayer := dial(t, url)
	send(t, replayer, Envelope{Type: TypeRegister, DepotID: depotID})
	recvEnvelope(t, replayer)
	send(t, replayer, Envelope{Type: TypeRegister, DepotID: depotID, Payload: proof})
	if got := recvEnvelope(t, replayer); got.Reason != ReasonUnauthorized {
		t.Fatalf("expected %s, got %+v", ReasonUnauthorized, got)
	}

	// Replayed without asking at all.
	cold := dial(t, url)
	send(t, cold, Envelope{Type: TypeRegister, DepotID: depotID, Payload: proof})
	if got := recvEnvelope(t, cold); got.Reason != ReasonUnauthorized {
		t.Fatalf("expected %s, got %+v", ReasonUnauthorized, got)
	}
}

// A depotId that is not a public key cannot be proved, so it is refused
// up front rather than handed a nonce nobody can sign.
func TestRegisteringANonKeyIsRefused(t *testing.T) {
	hub := newHubForTest()
	srv, url := testServer(t, hub)
	defer srv.Close()

	ws := dial(t, url)
	send(t, ws, Envelope{Type: TypeRegister, DepotID: "depot-1"})
	if got := recvEnvelope(t, ws); got.Reason != ReasonBadEnvelope {
		t.Fatalf("expected %s, got %+v", ReasonBadEnvelope, got)
	}
}

// Pinned against the web and Android signers: the same bytes, or no
// Depot can register at all.
func TestRegisterSigningBytes(t *testing.T) {
	got := registerSigningBytes("AB", []byte{1, 2})
	want := append([]byte{0, 24}, []byte("depot-signal-register/v1")...)
	want = append(want, 0, 2, 'A', 'B', 0, 2, 1, 2)
	if string(got) != string(want) {
		t.Fatalf("got %x, want %x", got, want)
	}
}
