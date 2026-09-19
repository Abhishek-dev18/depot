# web

Depot's browser Client — and a **Depot simulator** that implements the phone's half of the
protocol so pairing, reconnection and file transfer can be exercised end to end without an
Android device.

Implements `../docs/protocol.md` §3 (pairing), §4 (reconnection), §5 (transport) and §6
(revocation). React 19 + TypeScript + Vite, libsodium for crypto, WebRTC DataChannels for
transfer.

## The Client

The Client is built to the project's interface spec — the [Depot — Interface
Design](https://claude.ai/artifact/CMxsYXcZNY8XTzkoSGYwPn) artifact — and has three
states, which are that spec's three browser frames:

| Frame | Where |
|---|---|
| PAIR · awaiting approval | `components/PairPanel.tsx` |
| FILES · browse & transfer | `components/FilesPanel.tsx` |
| FALLBACK · no direct route | `components/NoRoutePanel.tsx` |

There is no fourth "logged out" state, because there is no account to log out of.
What this browser holds is a credential; losing it means pairing again.

The Client fills the window; the simulator keeps the narrow column it was built
in, because it is a form and a form as wide as a desktop is harder to use, not
easier.

## End-to-end check

`npm test` exercises the transport over a fake DataChannel pair, which is fast
and precise and cannot tell you that WebRTC negotiated, that the relay routed,
or that the screen showed what happened. `scripts/e2e.mjs` drives two real
browser tabs through pairing, the SAS comparison, reconnection, browsing and a
verified transfer:

```bash
npm i -D playwright                       # once
cd ../signal && go run .                  # terminal 1
npm run build && npx vite preview --port 4173   # terminal 2
node scripts/e2e.mjs                      # terminal 3
```

It prints both SAS codes so you can see them match, lists what came back over
`LIST`, and leaves screenshots in `/tmp`.

## The mark

The Depot crate exists in five places — this app's favicon, two CSS
pseudo-element constructions, and the Android launcher and notification
vectors. `public/favicon.svg` is the reference; the rest are built to match it.

```bash
node scripts/check-mark.mjs
```

renders each one, measures where its seam and corner block actually land as
fractions of its own box, and exits non-zero if any has drifted more than 0.03
from the favicon. For the two Android vectors it also checks the mark fits its
mask: a launcher may crop an adaptive icon to a circle, and a square mark is
limited by its diagonal rather than its width — which is how an icon that
looked comfortably inside its canvas lost its corners on a real phone. They had previously drifted into four visibly different
shapes, and side-by-side eyeballing is not sensitive enough to catch it.

The Depot simulator stays at `?role=depot`. It stands in for the phone so the
protocol can be exercised in two tabs — it is a development tool, the interface spec
does not cover it, and the real Depot is the Android app.

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
