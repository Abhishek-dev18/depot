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
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	addr := envOr("SIGNAL_ADDR", ":8080")
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
			return fwd
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
