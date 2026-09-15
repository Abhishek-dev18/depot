# web

Depot's browser Client — and a **Depot simulator** that implements the phone's half of the
protocol so pairing, reconnection and file transfer can be exercised end to end without an
Android device.

Implements `../docs/protocol.md` §3 (pairing), §4 (reconnection), §5 (transport) and §6
(revocation). React 19 + TypeScript + Vite, libsodium for crypto, WebRTC DataChannels for
transfer.

## Run

```bash
npm install
npm run dev
```

Needs the relay running — see [`../signal/`](../signal/):

```bash
cd ../signal && go run .
```

Then open two tabs: <http://localhost:5173/> is the Client, and
<http://localhost:5173/?role=depot> is the Depot simulator. The signal URL and an optional
TURN server are configurable under **Show connection settings** and persist in
`localStorage`.

## Layout

| Path | Responsibility |
|---|---|
| `src/crypto/` | Key generation, length-prefixed transcripts, X25519/BLAKE2b derivation, SAS, Ed25519 credentials, AEAD |
| `src/pairing/` | The four flows: Client and Depot sides of pairing (§3) and reconnection (§4) |
| `src/transport/` | WebRTC negotiation, binary frames with derived nonces, FastCDC chunking, manifests, compression, adaptive chunk sizing |
| `src/signal/` | WebSocket client speaking the Go relay's envelope protocol (§7.1) |
| `src/storage/` | IndexedDB persistence for identities, pairings and device records |
| `src/components/` | UI, styled to the dark/amber terminal design that the Android app will also follow |

## Checks

```bash
npm test          # vitest — crypto and transport unit tests
npm run lint
npx tsc -b --noEmit
npm run build
```
