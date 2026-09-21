// Command signal is Depot's relay server (protocol.md §7). It is a
// stateless WebSocket router: it matches peers by session or Depot
// identity and forwards opaque envelopes between them. It never sees key
// material, file contents, or the SAS, and holds no state beyond what is
// needed to route currently-connected peers — a restart simply forces
// affected peers to retry.
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	addr := listenAddr()
	trustProxy := envOr("SIGNAL_TRUST_PROXY", "") != ""
	logger := log.New(os.Stdout, "signal ", log.LstdFlags|log.Lmsgprefix)

	hub := NewHub(logger)
	go sweepLoop(hub, 5*time.Minute)

	upgrader := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     func(r *http.Request) bool { return true },
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logger.Printf("upgrade failed: %v", err)
			return
		}
		handleConn(hub, ws, clientIP(r, trustProxy), logger)
	})

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Printf("listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	logger.Print("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func handleConn(hub *Hub, ws *websocket.Conn, ip string, logger *log.Logger) {
	c := newConn(ws, ip, logger)
	defer func() {
		hub.Remove(c)
		c.close()
	}()

	// Pairing sessions and reconnect challenges are small; nothing this
	// protocol sends legitimately approaches this size, so it also bounds
	// how much a hostile peer can make Signal buffer.
	ws.SetReadLimit(64 * 1024)

	// A Depot is a phone: it can lose the network without the TCP
	// connection ever closing. Without this, that half-open connection
	// stays registered forever and every reconnecting client is routed
	// into a void. Pings force the dead peer to be noticed within
	// pongWait, so Remove() can drop its presence.
	_ = ws.SetReadDeadline(time.Now().Add(pongWait))
	ws.SetPongHandler(func(string) error {
		return ws.SetReadDeadline(time.Now().Add(pongWait))
	})
	stopPing := startPinger(c)
	defer stopPing()

	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return
		}
		e, err := decodeEnvelope(raw)
		if err != nil {
			c.sendError(ReasonBadEnvelope)
			continue
		}
		hub.Dispatch(c, e)
	}
}

// pongWait is how long a connection may be silent before it is considered
// dead; pingPeriod must be meaningfully shorter so a live peer always gets
// a chance to answer.
const (
	pongWait   = 60 * time.Second
	pingPeriod = 25 * time.Second
)

// startPinger pings c until the returned stop function is called. The read
// loop's deadline is what actually drops a dead peer — this just guarantees
// there is always traffic for that deadline to measure.
func startPinger(c *conn) func() {
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(pingPeriod)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if err := c.ping(time.Now().Add(10 * time.Second)); err != nil {
					return
				}
			}
		}
	}()
	return func() { close(done) }
}

func sweepLoop(hub *Hub, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for range t.C {
		hub.limiter.Sweep()
	}
}

// clientIP identifies the peer for rate limiting. X-Forwarded-For is only
// honoured when SIGNAL_TRUST_PROXY is set, i.e. the operator has confirmed
// Signal sits behind a proxy that sets it correctly — otherwise a direct
// client could forge the header and bypass the per-IP pairing-session
// limit entirely.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			// Take the last entry, the one the trusted proxy appended.
			// Using the whole header would let a client prepend arbitrary
			// values and get a distinct rate-limit key on every request.
			parts := strings.Split(fwd, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// Where to listen, in the order a deployment is likely to say it.
//
// SIGNAL_ADDR is this program's own setting and wins. PORT is what every
// managed host injects — Render, Railway, Heroku, Cloud Run — and a
// server that ignores it binds a port nothing routes to, which presents
// as a deploy that builds, starts, reports healthy and refuses every
// connection.
func listenAddr() string {
	if v := os.Getenv("SIGNAL_ADDR"); v != "" {
		return v
	}
	if v := os.Getenv("PORT"); v != "" {
		return ":" + strings.TrimPrefix(v, ":")
	}
	return ":8080"
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
