# signal

Depot's relay server — implements `docs/protocol.md` §7. A stateless
WebSocket router that matches peers by pairing session or by Depot
identity and forwards opaque envelopes between them. See
[`../docs/protocol.md#7-signal-server`](../docs/protocol.md#7-signal-server)
for the trust model, and §7.1 there for the exact wire messages this
server implements.

## Run

```bash
go run .
# or
SIGNAL_ADDR=:9000 go run .
```

Endpoints:

- `GET /healthz` — liveness check
- `GET /ws` — WebSocket upgrade, all protocol traffic

## Config

| Env var | Default | Purpose |
|---|---|---|
| `SIGNAL_ADDR` | `:8080` | Listen address |
| `SIGNAL_TRUST_PROXY` | unset | Honour `X-Forwarded-For` for per-IP rate limiting. Only set this if Signal sits behind a proxy you control that sets the header correctly — otherwise a direct client can forge it and bypass the pairing rate limit. |

## Test

```bash
go test ./... -race
```
