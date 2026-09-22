package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
)

// A depotId is the Depot's Ed25519 public key (protocol.md §2), so a
// Depot can prove it is the one registering by signing something fresh.
// Without that, anyone who knows a depotId — every Client it was ever
// paired with, revoked or not — could register as it, knock the real
// Depot off, and then revoke its Clients here until Signal restarts.
//
// Signal holds the signed nonce only for the connection that asked, and
// forgets it the moment it is answered: nothing about this outlives a
// restart, as §7 requires of everything here.

// registerLabel keeps these bytes distinct from everything else a
// DepotIdentity signs (credentials, PAIR_RESPONSE, CHALLENGE).
const registerLabel = "depot-signal-register/v1"

const registerNonceBytes = 32

// registerSigningBytes is §3.3's length-prefixed transcript of the label,
// the depotId as sent, and the nonce Signal issued.
func registerSigningBytes(depotID string, nonce []byte) []byte {
	var out []byte
	for _, f := range [][]byte{[]byte(registerLabel), []byte(depotID), nonce} {
		out = binary.BigEndian.AppendUint16(out, uint16(len(f)))
		out = append(out, f...)
	}
	return out
}

// depotKey decodes a depotId into the public key it names. Clients
// encode without padding; padded input is accepted too.
func depotKey(depotID string) (ed25519.PublicKey, bool) {
	raw, err := base64.RawStdEncoding.DecodeString(depotID)
	if err != nil {
		raw, err = base64.StdEncoding.DecodeString(depotID)
	}
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, false
	}
	return ed25519.PublicKey(raw), true
}

func newRegisterNonce() ([]byte, error) {
	nonce := make([]byte, registerNonceBytes)
	_, err := rand.Read(nonce)
	return nonce, err
}

type registerChallenge struct {
	Nonce string `json:"nonce"`
}

type registerProof struct {
	Sig string `json:"sig"`
}

// provesRegistration reports whether payload carries a valid signature by
// depotID's key over the nonce this connection was given.
func provesRegistration(depotID string, nonce []byte, payload json.RawMessage) bool {
	key, ok := depotKey(depotID)
	if !ok || nonce == nil {
		return false
	}
	var proof registerProof
	if err := json.Unmarshal(payload, &proof); err != nil || proof.Sig == "" {
		return false
	}
	sig, err := base64.RawStdEncoding.DecodeString(proof.Sig)
	if err != nil {
		sig, err = base64.StdEncoding.DecodeString(proof.Sig)
	}
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(key, registerSigningBytes(depotID, nonce), sig)
}
