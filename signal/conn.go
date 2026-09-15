package main

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

// conn wraps a websocket connection with a write mutex, since gorilla's
// Conn permits only one concurrent writer, but a peer's messages and a
// room-teardown notice can originate from different goroutines.
type conn struct {
	ws  *websocket.Conn
	ip  string
	mu  sync.Mutex
	log *log.Logger
}

func newConn(ws *websocket.Conn, ip string, logger *log.Logger) *conn {
	return &conn{ws: ws, ip: ip, log: logger}
}

func (c *conn) send(e Envelope) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ws.WriteJSON(e)
}

func (c *conn) sendError(reason string) {
	if err := c.send(Envelope{Type: TypeError, Reason: reason}); err != nil {
		c.log.Printf("send error to %s failed: %v", c.ip, err)
	}
}

func (c *conn) close() {
	_ = c.ws.Close()
}

func decodeEnvelope(raw []byte) (Envelope, error) {
	var e Envelope
	err := json.Unmarshal(raw, &e)
	return e, err
}
