# Depot Protocol Specification

**Version:** 0.1 (draft)
**Status:** Pre-implementation
**Scope:** Device pairing, session establishment, encrypted transport, revocation.

---

## 1. Overview

Depot turns an Android phone into a personal file server that authorised browsers
can reach from anywhere. The phone holds the files. A browser session is granted
access only after an explicit, human-verified pairing step.

### 1.1 Roles

| Role | Description |
|---|---|
| **Depot** | The Android device. Holds all files. Sole source of truth. Grants and revokes access. |
| **Client** | A web browser session on a laptop or desktop. Holds no persistent file data. |
| **Signal** | A stateless WebSocket server operated by the project. Routes opaque blobs between a Depot and a Client. Never sees plaintext. |

### 1.2 Trust model

The Depot is the root of authority. The Signal server is **untrusted**: it is
assumed to be capable of reading, dropping, reordering, replaying and *modifying*
every message it routes. The protocol must remain secure under that assumption.

Specifically, Signal must not be able to:
- read file contents, file names, or directory structure
- impersonate a Client to a Depot, or a Depot to a Client
- gain access that survives a revocation

Signal **is** trusted for availability only. If it misbehaves, the correct outcome
is a failed connection, never a silent compromise.

### 1.3 What we do not defend against

- A compromised Depot device (the files are on it; game over)
- A compromised Client browser during an active session
- Traffic analysis: Signal can observe session timing, byte counts and IP addresses
- Physical shoulder-surfing of the pairing screen

---

## 2. Cryptographic primitives

All primitives from libsodium. No custom constructions.

| Purpose | Primitive |
|---|---|
| Key agreement | X25519 |
| Key derivation | BLAKE2b (keyed, via `crypto_generichash`) |
| AEAD | XChaCha20-Poly1305 |
| Signatures | Ed25519 |
| Random | `crypto_randombytes` / `crypto.getRandomValues` |

**Why XChaCha20-Poly1305 rather than AES-GCM:** mid-range Android devices
frequently lack AES hardware acceleration. ChaCha20 is a software stream cipher
and outperforms software AES substantially on those devices, with lower battery
cost. The 192-bit nonce also removes any practical nonce-collision concern.

### 2.1 Key inventory

| Key | Held by | Lifetime | Purpose |
|---|---|---|---|
| `DepotIdentity` (Ed25519) | Depot | Permanent, per install | Identifies this Depot |
| `ClientIdentity` (Ed25519) | Client | Permanent, per browser profile | Identifies this Client across sessions |
| `EphemeralKP` (X25519) | Both | One pairing / one session | Forward secrecy |
| `SessionKeys` | Both | One connection | Payload encryption |

`ClientIdentity` is generated on first visit and stored in IndexedDB. It is what
the Depot remembers and what revocation removes. Clearing browser storage
destroys it and requires re-pairing — this is intended behaviour, not a bug.

---

## 3. Pairing

Pairing happens once per Client. It establishes long-term mutual trust.

### 3.1 QR payload

The Client displays a QR code. The Depot reads it with the camera.

```json
{
  "v": 1,
  "s": "<signalUrl>",
  "id": "<sessionId>",
  "ek": "<clientEphemeralPublicKey>",
  "ik": "<clientIdentityPublicKey>",
  "n": "<nonce>"
}
```

| Field | Size | Why it is here |
|---|---|---|
| `v` | int | Protocol version. Lets the Depot refuse an incompatible Client cleanly. |
| `s` | string | Which Signal server to connect to. Allows self-hosting without a rebuild. |
| `id` | 16 B b64 | Random pairing session identifier. Lets Signal route the two peers to each other. Carries no authority. |
| `ek` | 32 B b64 | Client's ephemeral X25519 public key. **Transferred out-of-band via the camera — this is the security anchor.** |
| `ik` | 32 B b64 | Client's long-term Ed25519 public key, so the Depot knows what to store and trust in future. |
| `n` | 16 B b64 | Random nonce, bound into the SAS and the transcript. Prevents replay of an old QR. |

**The QR contains no secret and no token.** Photographing the screen grants
nothing by itself, because completing the pairing requires the Depot owner to
approve on the phone, and because the ephemeral key is single-use.

The pairing session expires **120 seconds** after the QR is generated. After
expiry the Client must generate a fresh `sessionId`, `EphemeralKP` and nonce.

### 3.2 Flow

```
CLIENT                          SIGNAL                        DEPOT
  │                               │                             │
  ├─ WS connect ─────────────────>│                             │
  ├─ HELLO {sessionId} ──────────>│                             │
  │                               │                             │
  │  display QR                   │                             │
  │  ═══════ camera (out of band) ══════════════════════════════>│
  │                               │                             │
  │                               │<──── WS connect ────────────┤
  │                               │<──── JOIN {sessionId} ──────┤
  │                               │                             │
  │<──── PAIR_RESPONSE ───────────┼─────────────────────────────┤
  │      {depotEk, depotIk, sig}  │                             │
  │                               │                             │
  │  both derive shared secret    │       both derive           │
  │  both compute SAS             │       both compute SAS      │
  │                               │                             │
  │  display SAS                  │       display SAS + prompt  │
  │                               │                             │
  │  ◄═══ human compares the two numbers, taps Approve ═══►     │
  │                               │                             │
  │<──── PAIR_CONFIRM ────────────┼─────────────────────────────┤
  │      {credential}             │                             │
  │                               │                             │
  │  store credential             │       store ClientIdentity  │
```

### 3.3 Key derivation

Both sides compute:

```
shared      = X25519(ownEphemeralPrivate, peerEphemeralPublic)

transcript  = v ‖ sessionId ‖ clientEk ‖ clientIk ‖ depotEk ‖ depotIk ‖ nonce

master      = BLAKE2b-32(key = shared, message = transcript)

K_c2d       = BLAKE2b-32(key = master, message = "depot/v1/c2d")
K_d2c       = BLAKE2b-32(key = master, message = "depot/v1/d2c")
SAS_seed    = BLAKE2b-8 (key = master, message = "depot/v1/sas")
```

Separate keys per direction so an attacker cannot reflect a message back at its
sender. `‖` is length-prefixed concatenation — every field is preceded by its
length as a `uint16` big-endian, so no two distinct transcripts can produce the
same byte string.

### 3.4 Short Authentication String (SAS)

```
SAS = decimal(SAS_seed mod 10000), zero-padded to 4 digits
```

Displayed on both the Client screen and the Depot's approval dialog. The Depot
owner approves only if the two match.

**Why this step is not optional — read this carefully.**

The Client's ephemeral public key reaches the Depot through the camera. Signal
cannot alter it; it never touches it. That direction is authenticated by physics.

The Depot's ephemeral public key reaches the Client **through Signal.** Signal can
replace it with a key of its own. If it does:

```
Client ←─ shared secret A ─→ SIGNAL ←─ shared secret B ─→ Depot
```

Both ends complete pairing successfully. Neither sees an error. Signal decrypts
everything from one side, reads it, re-encrypts it for the other. A full
man-in-the-middle, invisible to both parties.

The SAS defeats this because it is derived from the **master secret**, which is
derived from the shared secret. Under the attack above, the Client's master comes
from secret A and the Depot's from secret B. The two SAS values will differ, with
a 1-in-10,000 chance of accidental collision per attempt. The human comparing them
is the only entity in the system that has a channel Signal cannot touch.

This is the same mechanism as Signal's safety numbers and ZRTP's short
authentication strings. There is no way to remove the human step without
introducing a pre-shared secret or a trusted third party, and we have neither.

**Mitigating the 1-in-10,000 collision:** a Depot MUST rate-limit failed pairing
attempts — maximum 5 attempts per 10 minutes — so an attacker cannot brute-force
repeated pairings hoping for a SAS match.

### 3.5 Device record

On approval, the Depot stores:

```json
{
  "clientIdentityPub": "<32 B>",
  "label": "Chrome on Windows",
  "createdAt": "<timestamp>",
  "lastSeenAt": "<timestamp>",
  "grantedPaths": ["<SAF tree URI>", "..."],
  "revoked": false
}
```

`label` is derived from the Client's User-Agent and is **advisory only**. It is
attacker-controlled and must never be used for any authorisation decision. It
exists so the owner can recognise the device in a list.

### 3.6 Credential

The Depot returns a credential the Client presents on future connections:

```json
{
  "depotId": "<Depot identity public key>",
  "clientId": "<Client identity public key>",
  "issuedAt": 1234567890,
  "expiresAt": 1250000000,
  "sig": "<Ed25519 signature by DepotIdentity over the above>"
}
```

Default lifetime: **90 days**. The credential is a claim of prior pairing, not a
bearer token — see §4.

---

## 4. Reconnection

A paired Client reconnecting does **not** repeat the QR flow, but must prove it
holds the private half of `ClientIdentity`.

```
CLIENT                          SIGNAL                        DEPOT
  ├─ RECONNECT {credential, clientEk} ───────────────────────>│
  │                                                            │
  │<─── CHALLENGE {depotEk, challengeNonce} ───────────────────┤
  │                                                            │
  ├─ RESPONSE {Ed25519_sign(ClientIdentityPriv, transcript)} ─>│
  │                                                            │
  │<─── SESSION_OK ────────────────────────────────────────────┤
```

The Depot verifies:
1. The credential signature is valid and made by its own `DepotIdentity`
2. The credential has not expired
3. `clientId` exists in the device list and `revoked == false`
4. The Ed25519 signature over the fresh transcript verifies against the stored
   `clientIdentityPub`

Step 4 is what makes a stolen credential useless. The credential is not a bearer
token — possession alone proves nothing, because the Client must sign a nonce the
Depot chose *in this session*. Without the private key, that signature cannot be
produced.

New ephemeral keys are generated per reconnection, so compromise of one session's
keys does not expose past or future sessions.

---

## 5. Transport

### 5.1 Path selection

ICE selects the best available path, in order:

| Rung | Path | Cost to project |
|---|---|---|
| 1 | Host candidate — same LAN | None |
| 2 | Server-reflexive — STUN hole-punch | None (public STUN) |
| 3 | Relay — TURN | None (**user-supplied**) |

The project operates **no TURN server**. Users may configure their own in
settings; a `docker-compose.yml` for coturn ships in the repository. When all
rungs fail, the Client surfaces an explicit `ICE_FAILED` state with guidance.

The resolved candidate type is displayed to the user so they can see whether the
connection is direct or relayed.

### 5.2 Channels

Two SCTP DataChannels:

| Channel | Config | Carries |
|---|---|---|
| `ctl` | ordered, reliable | JSON control messages |
| `data` | **unordered**, reliable | Binary chunk frames |

`data` is unordered deliberately: ordering causes head-of-line blocking, so on a
lossy link one delayed packet stalls every chunk behind it. Chunks are
independently addressed and reassembled by index, so ordering buys nothing.

### 5.3 Frame format

Binary. **Never base64** — base64 inflates every payload by 33%, which on a file
transfer protocol is unacceptable.

```
┌────────┬─────────┬─────────┬────────┬──────────────────┐
│ type   │ transfer│ chunkIdx│ flags  │ ciphertext       │
│ 1 byte │ 4 bytes │ 4 bytes │ 1 byte │ variable         │
└────────┴─────────┴─────────┴────────┴──────────────────┘
```

`flags` bit 0: payload is zstd-compressed.

**Nonce construction — no nonce is transmitted.** Both sides derive it:

```
nonce = direction(1B) ‖ transferId(4B) ‖ chunkIndex(4B) ‖ zeros(15B)
```

Saves 24 bytes per chunk and eliminates an entire class of nonce-reuse bug.
Uniqueness holds because `transferId` is never reused within a session and
`chunkIndex` is unique within a transfer.

### 5.4 Capability negotiation

Immediately after `SESSION_OK`, both sides exchange:

```json
{
  "type": "CAPS",
  "protocolVersion": 1,
  "compression": ["zstd", "none"],
  "maxChunkSize": 1048576,
  "features": ["cdc", "thumbnails", "range"]
}
```

The intersection governs the session. This message is what allows new transports,
compression algorithms and features to be added later without breaking older
clients.

### 5.5 Adaptive chunk sizing

| Link quality | Chunk size |
|---|---|
| RTT < 20 ms, loss < 0.1% | 1 MB |
| RTT < 100 ms, loss < 1% | 256 KB |
| Worse | 32–64 KB |

Rules to prevent oscillation, all mandatory:
- EWMA-smoothed measurements, never raw samples
- Discrete steps only, one step per adjustment
- Minimum 5 s cooldown between adjustments
- Hysteresis: different thresholds for stepping up vs down

### 5.6 Compression

Sample the first 64 KB of a chunk and estimate entropy. High entropy — already
compressed media, archives, encrypted data — is sent raw. Low entropy uses zstd
level 3.

Compressing an MP4 costs CPU and battery for near-zero gain; on a phone that is
measurable heat. Text, code, CSV and logs compress 60–90% and are worth it.

### 5.7 Transfer flow

```
1. Client requests file
2. Depot sends MANIFEST {name, size, chunkCount, hash[] per chunk}
3. Client replies NEED {indices it does not already hold}
4. Depot sends only those chunks
5. Client verifies each chunk hash, reassembles, verifies whole-file hash
```

Step 3 is what makes resumption free: a reconnected Client simply re-sends `NEED`
with the indices it is still missing. No separate resume mechanism is required.

Chunk boundaries use content-defined chunking (FastCDC) rather than fixed
offsets, so that inserting bytes into a file does not invalidate every subsequent
chunk.

### 5.8 Wire messages and implementation notes

As with §7.1, this document specifies transport *behaviour* but left several
wire-level details to whoever implemented it first. Recorded here so the
running code and this document don't drift apart:

**WebRTC signaling.** SDP offer/answer and trickle ICE candidates travel as
opaque relay messages over the same signal connection used for §4
(`RTC_OFFER`, `RTC_ANSWER`, `RTC_ICE` — Signal never inspects their
contents, same as everything else it relays). The Client is always the
WebRTC offerer and creates both DataChannels; the Depot is always the
answerer. This is an arbitrary but fixed convention — nothing in §5 depends
on which side offers.

**`ctl` channel messages.** `CAPS` (§5.4), `REQUEST_FILE` (Client → Depot,
requests whatever file the Depot is currently offering — this
implementation doesn't do file browsing/selection-by-path, since that's a
product-level concern for the Android app's own UI, not part of this
protocol), `MANIFEST` (Depot → Client, carries `transferId`, `size`, and
each chunk's `offset`/`length`/`hash` since chunks are content-defined and
therefore variable-length), `NEED` (Client → Depot), and `ERROR` (either
direction).

**Frame `type` byte (§5.3).** Only one value is defined today: `1` = CHUNK.
Reserved so a future frame kind can be added without changing the header
layout.

**§5.5 tiers.** Implemented as three discrete steps — 64 KB / 256 KB / 1 MB,
matching the table — with EWMA smoothing (α = 0.3), a 5s cooldown, and
stricter thresholds to step up than to step down (hysteresis). RTT comes
from `RTCPeerConnection.getStats()`'s selected candidate pair; standard
`getStats()` doesn't expose a reliable cross-browser loss fraction for SCTP
data channels, so loss is treated as 0 (optimistic) rather than
overclaiming precision sizing can't actually get today.

**§5.6 compression codec.** This implementation uses the browser's native
`CompressionStream('deflate-raw')` instead of zstd, to avoid adding a wasm
zstd codec as a build dependency for a demo-stage feature. The entropy-gated
decision (§5.6) and the wire flag (`FLAG_COMPRESSED`) are unchanged — this
is a codec substitution, not a protocol change, and swapping in real zstd
later touches only the compression module.

---

## 6. Revocation

```
1. Owner taps Revoke on the Depot
2. Device record marked revoked = true
3. Any live DataChannel to that Client is closed immediately
4. Depot sends REVOKE {clientId} to Signal
5. Signal drops any routing entry for that Client and refuses future JOINs
```

Step 3 is the one that matters. Steps 4–5 are an optimisation: **revocation must
be correct even if Signal ignores the message entirely**, because Signal is
untrusted. Correctness comes from the Depot refusing the §4 handshake, not from
Signal's cooperation.

Revocation is immediate and unconditional. There is no grace period and no
"revoke after current transfer completes."

---

## 7. Signal server

Stateless. Holds pairing sessions in memory only; all state is lost on restart,
which is acceptable because a lost pairing session simply means the user rescans.

What Signal sees:
- Session IDs
- Connection timing and IP addresses
- Opaque ciphertext byte counts

What Signal never sees:
- File names, contents or directory structure
- Any key material capable of decrypting anything
- The SAS

Rate limits: 10 pairing sessions per IP per minute; 2 peers maximum per session ID.

### 7.1 Wire messages

The rest of this document specifies message *contents* (PAIR_RESPONSE,
CHALLENGE, SESSION_OK, …) but not how Signal itself routes them. That routing
layer is implementation, not protocol — Signal treats those message bodies as
opaque `payload` and never inspects them — but it has to be specified
somewhere, so it lives here rather than being reinvented per client. Every
frame is one JSON envelope:

```json
{ "type": "...", "sessionId": "...", "depotId": "...", "clientId": "...", "payload": { } }
```

Types Signal owns (everything else is forwarded verbatim as opaque `payload`
to whichever peer the connection is currently routed to — this is how
PAIR_RESPONSE, PAIR_CONFIRM, CHALLENGE, RESPONSE, SESSION_OK, CAPS, and all
SDP/ICE signaling travel):

| Type | Direction | Fields used | Effect |
|---|---|---|---|
| `hello` | Client → Signal | `sessionId` | Opens a pairing room. Replied to with `session_created` once the room exists — **the Client must wait for this before rendering the QR**, otherwise a Depot that joins before the room is created sees `session_not_found`. |
| `join` | Depot → Signal | `sessionId` | Joins an existing room (max 2 peers). Both sides then receive `peer_joined` and are relayed to each other. |
| `register` | Depot → Signal | `depotId` | Announces presence for §4 reconnection. A later `register` with the same `depotId` supersedes the earlier connection. |
| `connect` | Client → Signal | `depotId`, `clientId`, `payload` (the RECONNECT body) | Requests a route to an online Depot. Forwarded to the Depot as `incoming` with the same `payload`, saving a round trip. |
| `revoke` | Depot → Signal | `clientId` | Routing-only optimisation for §6: future `connect`s for this `clientId` are rejected with `client_revoked`, and any in-flight route is torn down. Correctness never depends on this — see §6. |

Signal-originated notices: `session_created`, `peer_joined`, `peer_left`,
`incoming`, and `error` (with a `reason`: `session_expired`, `session_full`,
`session_not_found`, `depot_offline`, `client_revoked`, `rate_limited`,
`no_route`, `bad_envelope`, `already_connected`).

A Depot's `register` connection is long-lived and may have several clients
mid-reconnect concurrently; Signal demultiplexes by tagging relayed envelopes
with `clientId` in both directions on that connection only.

---

## 8. Open questions

To be resolved before implementation of the relevant phase:

1. **File indexing:** does the Depot pre-hash files in the background, or hash on
   demand? Pre-indexing makes `NEED` instant but costs battery and requires
   invalidation on file change. Leaning on-demand with an LRU cache for v1.
2. **Credential renewal:** silent renewal on connection, or re-approval at 90 days?
3. **Multiple Depots per Client:** does one browser profile pair with several
   phones? The data model allows it; the UI does not yet.
4. **Thumbnail generation:** on demand or pre-generated on file index?
5. **SAS length:** 4 digits with rate limiting, or 6 digits for margin?

---

## 9. Changelog

| Version | Date | Change |
|---|---|---|
| 0.1 | 2026-09-15 | Initial draft |