package main

import "encoding/json"

// Envelope is the only shape Signal itself understands. Every WebSocket text
// frame is one Envelope. Fields Signal does not need for routing (payload
// contents, key material, signatures, ciphertext) travel inside Payload,
// which Signal never inspects.
type Envelope struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId,omitempty"`
	DepotID   string          `json:"depotId,omitempty"`
	ClientID  string          `json:"clientId,omitempty"`
	Reason    string          `json:"reason,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// Message types Signal owns. Anything else is treated as opaque and simply
// relayed to the current peer once a route exists (PAIR_RESPONSE,
// PAIR_CONFIRM, CHALLENGE, RESPONSE, SESSION_OK, CAPS, WebRTC SDP/ICE
// exchange, and all later data-channel signaling all pass through here).
const (
	TypeHello    = "hello"    // Client -> Signal: open a pairing room
	TypeJoin     = "join"     // Depot  -> Signal: join a pairing room
	TypeRegister = "register" // Depot  -> Signal: announce presence for reconnection
	TypeConnect  = "connect"  // Client -> Signal: request a route to a registered Depot
	TypeRevoke   = "revoke"   // Depot  -> Signal: revoke a clientId (routing optimisation only)
	TypeWatch    = "watch"    // Client -> Signal: tell me when this Depot registers

	TypeSessionCreated = "session_created" // Signal -> Client: room exists, safe to display the QR now
	TypePeerJoined     = "peer_joined"     // Signal -> both: room is now paired
	TypePeerLeft       = "peer_left"       // Signal -> remaining peer: other side disconnected
	TypeIncoming       = "incoming"        // Signal -> Depot: a client is requesting reconnection
	TypeError          = "error"           // Signal -> either: request could not be satisfied
	TypeDepotOnline    = "depot_online"    // Signal -> watching Client: it just registered
)

// Error reasons.
const (
	ReasonSessionExpired   = "session_expired"
	ReasonSessionFull      = "session_full"
	ReasonSessionNotFound  = "session_not_found"
	ReasonDepotOffline     = "depot_offline"
	ReasonClientRevoked    = "client_revoked"
	ReasonRateLimited      = "rate_limited"
	ReasonNoRoute          = "no_route"
	ReasonBadEnvelope      = "bad_envelope"
	ReasonAlreadyConnected = "already_connected"
)
