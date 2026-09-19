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

The race detector is not optional decoration here — a real data race lived
in `hub.go` (a `*conn` read outside the mutex) and this is what caught it.

**On Windows**, `-race` needs cgo, and cgo needs a 64-bit gcc. If you see

```
# runtime/cgo
cc1.exe: sorry, unimplemented: 64-bit mode not compiled in
```

the gcc on your PATH is a 32-bit build. Either install a 64-bit toolchain —
in MSYS2, `pacman -S mingw-w64-x86_64-gcc` from the MINGW64 shell — or drop
the flag:

```bash
go test ./...
```

That still runs every test, just without race instrumentation. CI runs the
`-race` build on Linux on every push, so nothing goes unchecked either way.
