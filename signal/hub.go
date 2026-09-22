package main

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"sync"
	"time"
)

type role int

const (
	roleNone role = iota
	rolePairingClient
	rolePairingDepot
	roleDepotHub
	roleReconnectClient
)

// conn-side routing state. Added to conn via the hub, not stored on conn
// itself, so hub.go owns all routing state in one place.
type connState struct {
	role    role
	peer    *conn // rolePairingClient / rolePairingDepot: the other side of the room
	session *room // rolePairingClient / rolePairingDepot: room this conn belongs to

	depotID  string // roleDepotHub, roleReconnectClient
	clientID string // roleReconnectClient

	// The nonce this connection was asked to sign for registerFor, until
	// it answers. Single use: cleared on the first answer, right or wrong.
	registerNonce []byte
	registerFor   string
}

// room is one in-flight pairing (§3 of protocol.md). Sessions are ephemeral
// and single-use: once paired or expired they are discarded.
type room struct {
	sessionID string
	client    *conn
	depot     *conn
	createdAt time.Time
	timer     *time.Timer
}

// presence is a Depot that is online and reachable for reconnection (§4).
// routes tracks clients currently mid-reconnect or connected through this
// hub connection, keyed by clientId, so a single Depot connection can
// demultiplex several concurrent reconnecting clients.
type presence struct {
	depotID string
	hub     *conn
	revoked map[string]bool
	routes  map[string]*conn
}

// watchers are Clients waiting for a Depot that is not registered yet.
//
// Without this a Client has only one way to find out its Depot came back:
// ask again, and again. Four seconds between asks is already a long time
// to stare at a phone you have just switched on, and no interval is short
// enough to feel immediate without being wasteful — the Client was
// reported sitting on a failure screen for half a minute, and the
// suggestion that came back was to reload the page every second.
//
// Signal knows the answer the instant it is true. Telling the Client is
// one map and one message, and it makes the poll a fallback rather than
// the mechanism.
type watchers struct {
	mu sync.Mutex
	by map[string]map[*conn]bool
}

func newWatchers() *watchers {
	return &watchers{by: make(map[string]map[*conn]bool)}
}

func (w *watchers) add(depotID string, c *conn) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.by[depotID] == nil {
		w.by[depotID] = make(map[*conn]bool)
	}
	w.by[depotID][c] = true
}

func (w *watchers) remove(c *conn) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for depotID, set := range w.by {
		delete(set, c)
		if len(set) == 0 {
			delete(w.by, depotID)
		}
	}
}

// take returns everyone waiting on depotID and forgets them: the notice
// is sent once, and a Client that wants another waits again.
func (w *watchers) take(depotID string) []*conn {
	w.mu.Lock()
	defer w.mu.Unlock()
	set := w.by[depotID]
	if len(set) == 0 {
		return nil
	}
	out := make([]*conn, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	delete(w.by, depotID)
	return out
}

// Hub holds all server state. Signal is otherwise stateless across
// restarts by design (protocol.md §7): everything here lives in memory
// only and a restart simply forces affected peers to retry.
type Hub struct {
	mu      sync.Mutex
	states  map[*conn]*connState
	rooms   map[string]*room
	depots  map[string]*presence
	waiting *watchers
	limiter *RateLimiter
	log     *log.Logger

	sessionTTL time.Duration
}

func NewHub(logger *log.Logger) *Hub {
	return &Hub{
		states:     make(map[*conn]*connState),
		rooms:      make(map[string]*room),
		depots:     make(map[string]*presence),
		waiting:    newWatchers(),
		limiter:    NewRateLimiter(10, time.Minute), // §7: 10 pairing sessions / IP / minute
		log:        logger,
		sessionTTL: 120 * time.Second, // §3.1: pairing session expiry
	}
}

func (h *Hub) stateFor(c *conn) *connState {
	st, ok := h.states[c]
	if !ok {
		st = &connState{}
		h.states[c] = st
	}
	return st
}

// Dispatch routes one decoded envelope from c. Called from the connection's
// read loop, so it must not block on network I/O for other peers longer
// than a single WriteJSON call.
func (h *Hub) Dispatch(c *conn, e Envelope) {
	switch e.Type {
	case TypeHello:
		h.handleHello(c, e)
	case TypeJoin:
		h.handleJoin(c, e)
	case TypeRegister:
		h.handleRegister(c, e)
	case TypeConnect:
		h.handleConnect(c, e)
	case TypeWatch:
		h.handleWatch(c, e)
	case TypeRevoke:
		h.handleRevoke(c, e)
	default:
		// Everything else is opaque and simply relayed to whichever peer
		// this connection currently has a route to. Signal does not parse
		// or need to understand PAIR_RESPONSE, PAIR_CONFIRM, CHALLENGE,
		// RESPONSE, SESSION_OK, CAPS, or SDP/ICE payloads.
		h.handleRelay(c, e)
	}
}

func (h *Hub) handleHello(c *conn, e Envelope) {
	if e.SessionID == "" {
		c.sendError(ReasonBadEnvelope)
		return
	}
	if !h.limiter.Allow(c.ip) {
		c.sendError(ReasonRateLimited)
		return
	}

	h.mu.Lock()
	if _, exists := h.rooms[e.SessionID]; exists {
		h.mu.Unlock()
		c.sendError(ReasonAlreadyConnected)
		return
	}

	r := &room{sessionID: e.SessionID, client: c, createdAt: time.Now()}
	r.timer = time.AfterFunc(h.sessionTTL, func() { h.expireRoom(e.SessionID) })
	h.rooms[e.SessionID] = r

	st := h.stateFor(c)
	st.role = rolePairingClient
	st.session = r
	h.mu.Unlock()

	// The Client must not render the QR (and so the Depot must not be able
	// to join) until the room provably exists, otherwise a join racing an
	// in-flight hello can land first and be rejected as session_not_found.
	_ = c.send(Envelope{Type: TypeSessionCreated, SessionID: e.SessionID})
}

func (h *Hub) handleJoin(c *conn, e Envelope) {
	if e.SessionID == "" {
		c.sendError(ReasonBadEnvelope)
		return
	}

	h.mu.Lock()
	r, exists := h.rooms[e.SessionID]
	if !exists {
		h.mu.Unlock()
		c.sendError(ReasonSessionNotFound)
		return
	}
	if r.depot != nil {
		h.mu.Unlock()
		c.sendError(ReasonSessionFull)
		return
	}

	r.timer.Stop()
	r.depot = c

	clientState := h.stateFor(r.client)
	clientState.peer = c
	depotState := h.stateFor(c)
	depotState.role = rolePairingDepot
	depotState.peer = r.client
	depotState.session = r
	h.mu.Unlock()

	joined := Envelope{Type: TypePeerJoined, SessionID: e.SessionID}
	_ = r.client.send(joined)
	_ = c.send(joined)
}

func (h *Hub) expireRoom(sessionID string) {
	h.mu.Lock()
	r, exists := h.rooms[sessionID]
	if !exists || r.depot != nil {
		h.mu.Unlock()
		return
	}
	delete(h.rooms, sessionID)
	h.mu.Unlock()

	r.client.sendError(ReasonSessionExpired)
}

func (h *Hub) handleRegister(c *conn, e Envelope) {
	if _, ok := depotKey(e.DepotID); !ok {
		c.sendError(ReasonBadEnvelope)
		return
	}

	// First the Depot asks, and is handed a nonce; then it answers with
	// that nonce signed. Only the answer registers anything.
	if len(e.Payload) == 0 {
		nonce, err := newRegisterNonce()
		if err != nil {
			c.sendError(ReasonBadEnvelope)
			return
		}
		h.mu.Lock()
		st := h.stateFor(c)
		st.registerNonce = nonce
		st.registerFor = e.DepotID
		h.mu.Unlock()
		challenge, _ := json.Marshal(registerChallenge{Nonce: base64.RawStdEncoding.EncodeToString(nonce)})
		_ = c.send(Envelope{Type: TypeRegisterChallenge, DepotID: e.DepotID, Payload: challenge})
		return
	}

	h.mu.Lock()
	st := h.stateFor(c)
	nonce, askedFor := st.registerNonce, st.registerFor
	st.registerNonce, st.registerFor = nil, ""
	h.mu.Unlock()
	if askedFor != e.DepotID || !provesRegistration(e.DepotID, nonce, e.Payload) {
		c.sendError(ReasonUnauthorized)
		return
	}

	h.mu.Lock()
	p, exists := h.depots[e.DepotID]
	if !exists {
		p = &presence{depotID: e.DepotID, revoked: make(map[string]bool), routes: make(map[string]*conn)}
		h.depots[e.DepotID] = p
	}
	old := p.hub
	if old != nil && old != c {
		delete(h.states, old)
	}
	p.hub = c

	st = h.stateFor(c)
	st.role = roleDepotHub
	st.depotID = e.DepotID
	h.mu.Unlock()

	if old != nil && old != c {
		// A new connection from the same Depot identity supersedes the old
		// one (e.g. reconnect after a network blip).
		old.sendError(ReasonAlreadyConnected)
		old.close()
	}
	_ = c.send(Envelope{Type: TypeRegistered, DepotID: e.DepotID})

	// Anyone who asked to be told. Sent outside the lock: these are
	// writes to other sockets and one of them being slow must not hold
	// up the registration that has already happened.
	for _, waiter := range h.waiting.take(e.DepotID) {
		_ = waiter.send(Envelope{Type: TypeDepotOnline, DepotID: e.DepotID})
	}
}

// handleWatch records a Client's interest in a Depot that is not here
// yet. If it turns out to be here already, the answer goes back at once
// rather than waiting for a registration that has been and gone.
func (h *Hub) handleWatch(c *conn, e Envelope) {
	if e.DepotID == "" {
		c.sendError(ReasonBadEnvelope)
		return
	}
	h.mu.Lock()
	_, online := h.depots[e.DepotID]
	h.mu.Unlock()

	if online {
		_ = c.send(Envelope{Type: TypeDepotOnline, DepotID: e.DepotID})
		return
	}
	h.waiting.add(e.DepotID, c)
}

func (h *Hub) handleConnect(c *conn, e Envelope) {
	if e.DepotID == "" || e.ClientID == "" {
		c.sendError(ReasonBadEnvelope)
		return
	}

	h.mu.Lock()
	p, exists := h.depots[e.DepotID]
	if !exists {
		h.mu.Unlock()
		c.sendError(ReasonDepotOffline)
		return
	}
	if p.revoked[e.ClientID] {
		h.mu.Unlock()
		c.sendError(ReasonClientRevoked)
		return
	}
	p.routes[e.ClientID] = c

	st := h.stateFor(c)
	st.role = roleReconnectClient
	st.depotID = e.DepotID
	st.clientID = e.ClientID
	depotHub := p.hub
	h.mu.Unlock()

	// Forward the RECONNECT payload straight through as "incoming" so the
	// Depot can start the challenge-response of §4 without a round trip.
	_ = depotHub.send(Envelope{Type: TypeIncoming, ClientID: e.ClientID, Payload: e.Payload})
}

func (h *Hub) handleRevoke(c *conn, e Envelope) {
	h.mu.Lock()
	st := h.states[c]
	if st == nil || st.role != roleDepotHub {
		h.mu.Unlock()
		c.sendError(ReasonBadEnvelope)
		return
	}
	if e.ClientID == "" {
		h.mu.Unlock()
		c.sendError(ReasonBadEnvelope)
		return
	}
	p, exists := h.depots[st.depotID]
	if !exists {
		h.mu.Unlock()
		return
	}
	p.revoked[e.ClientID] = true
	route, hasRoute := p.routes[e.ClientID]
	delete(p.routes, e.ClientID)
	h.mu.Unlock()

	// Best-effort only: this is the routing optimisation of protocol.md §6
	// steps 4-5. Correctness of revocation comes from the Depot itself
	// refusing the §4 handshake, not from Signal's cooperation.
	if hasRoute {
		route.sendError(ReasonClientRevoked)
	}
}

func (h *Hub) handleRelay(c *conn, e Envelope) {
	h.mu.Lock()
	st := h.states[c]
	if st == nil {
		h.mu.Unlock()
		c.sendError(ReasonNoRoute)
		return
	}

	switch st.role {
	case rolePairingClient, rolePairingDepot:
		peer := st.peer
		h.mu.Unlock()
		if peer == nil {
			c.sendError(ReasonNoRoute)
			return
		}
		_ = peer.send(Envelope{Type: e.Type, Payload: e.Payload})

	case roleReconnectClient:
		p, exists := h.depots[st.depotID]
		var depotHub *conn
		if exists {
			depotHub = p.hub
		}
		h.mu.Unlock()
		if !exists {
			c.sendError(ReasonDepotOffline)
			return
		}
		_ = depotHub.send(Envelope{Type: e.Type, ClientID: st.clientID, Payload: e.Payload})

	case roleDepotHub:
		p, exists := h.depots[st.depotID]
		if !exists || e.ClientID == "" {
			h.mu.Unlock()
			c.sendError(ReasonBadEnvelope)
			return
		}
		dst, hasRoute := p.routes[e.ClientID]
		h.mu.Unlock()
		if !hasRoute {
			c.sendError(ReasonNoRoute)
			return
		}
		_ = dst.send(Envelope{Type: e.Type, Payload: e.Payload})

	default:
		h.mu.Unlock()
		c.sendError(ReasonNoRoute)
	}
}

// Remove tears down all routing state for a connection that has
// disconnected, notifying whatever peer it was paired with.
func (h *Hub) Remove(c *conn) {
	// Before anything else, and regardless of role: a socket that has
	// gone cannot be told about anything.
	h.waiting.remove(c)

	h.mu.Lock()
	st, ok := h.states[c]
	if !ok {
		h.mu.Unlock()
		return
	}
	delete(h.states, c)

	switch st.role {
	case rolePairingClient, rolePairingDepot:
		var sessionID string
		if st.session != nil {
			sessionID = st.session.sessionID
			delete(h.rooms, sessionID)
			if st.session.timer != nil {
				st.session.timer.Stop()
			}
		}
		peer := st.peer
		h.mu.Unlock()
		if peer != nil {
			peer.send(Envelope{Type: TypePeerLeft, SessionID: sessionID})
		}

	case roleDepotHub:
		p, exists := h.depots[st.depotID]
		if exists && p.hub == c {
			delete(h.depots, st.depotID)
		}
		// Snapshot under the lock: p.routes stays reachable by other
		// goroutines when this connection was already superseded, so
		// iterating the live map after unlocking would race with them.
		var routes []*conn
		if exists {
			for _, client := range p.routes {
				routes = append(routes, client)
			}
		}
		h.mu.Unlock()
		for _, client := range routes {
			client.sendError(ReasonDepotOffline)
		}

	case roleReconnectClient:
		p, exists := h.depots[st.depotID]
		var depotHub *conn
		if exists {
			if p.routes[st.clientID] == c {
				delete(p.routes, st.clientID)
			}
			depotHub = p.hub
		}
		h.mu.Unlock()
		if depotHub != nil {
			depotHub.send(Envelope{Type: TypePeerLeft, ClientID: st.clientID})
		}

	default:
		h.mu.Unlock()
	}
}
