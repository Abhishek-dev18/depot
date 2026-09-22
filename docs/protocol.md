# Depot Protocol Specification

**Version:** 0.13 (draft)
**Status:** Implemented on both sides
**Scope:** Device pairing, session establishment, encrypted transport, browsing, revocation.

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
SAS = decimal(SAS_seed mod 1000000), zero-padded to 6 digits
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
a 1-in-1,000,000 chance of accidental collision per attempt. The human comparing
them is the only entity in the system that has a channel Signal cannot touch.

This is the same mechanism as Signal's safety numbers and ZRTP's short
authentication strings. There is no way to remove the human step without
introducing a pre-shared secret or a trusted third party, and we have neither.

**Mitigating the collision chance:** a Depot MUST rate-limit failed pairing
attempts — maximum 5 attempts per 10 minutes — so an attacker cannot brute-force
repeated pairings hoping for a SAS match. §8.5 settled on 6 digits over 4: the
change is a one-line constant, the collision odds go from 1-in-10,000 to
1-in-1,000,000, and comparing six digits instead of four costs the owner nothing
worth trading away that margin for.

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

### 4.1 Credential renewal

`SESSION_OK` MAY carry a freshly issued credential:

```json
{ "type": "SESSION_OK", "credential": { "...": "..." } }
```

§8.2 settled this on **silent renewal**, not forced re-approval: the security
property §4 step 4 describes — a stolen credential is useless without the
private key — is re-proven on *every* reconnection, renewed credential or not.
Requiring the owner to redo the §3 QR+SAS flow every 90 days for a device they
reconnect to daily buys no additional security, only friction.

The Depot issues a renewed credential when the current one has less than 30 of
its 90 days left (any threshold works; this just avoids renewing on literally
every reconnection). The Client overwrites its stored credential for that Depot
on receipt. A device that stops reconnecting before its credential expires gets
no silent renewal — because it never asks for one — and simply has to re-pair
via §3 next time, which is the correct outcome for a device that may no longer
be trusted or in the owner's possession.

### 4.2 Rejection

A Depot that refuses a reconnection tells the Client rather than going silent:

```json
{ "type": "REJECTED", "payload": { "reason": "not a known, un-revoked device" } }
```

The reason travels in the **payload**, not the envelope's `reason` field: Signal
populates that field only on errors it generates itself, and drops it when
relaying between peers (§7.1), so a Depot cannot use it.

This discloses nothing useful. The reasons say only whether a credential is
still honoured, which the outcome reveals anyway — a peer that is refused learns
nothing it could not infer from never receiving a `CHALLENGE`. What it buys is
that a revoked device is told it was revoked, instead of appearing to the user
as an unexplained timeout.

Rejection is advisory, not a security boundary: a Depot that crashes or vanishes
sends nothing, so a Client must still treat a timeout as failure.

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
| `ctl` | ordered, reliable | Encrypted control frames (JSON plaintext) |
| `data` | **unordered**, reliable | Encrypted chunk frames |

`data` is unordered deliberately: ordering causes head-of-line blocking, so on a
lossy link one delayed packet stalls every chunk behind it. Chunks are
independently addressed and reassembled by index, so ordering buys nothing.

**Both channels are encrypted with the session keys.** DTLS alone is not
sufficient: the SDP that carries the DTLS fingerprints is relayed through
Signal, which is untrusted (§1.2), so a hostile relay can substitute
fingerprints and terminate DTLS itself. Anything protected only by DTLS is
therefore readable and forgeable by Signal. Since §1.2 promises Signal cannot
read *file names*, and the `MANIFEST` carries the file name, size and every
chunk hash, `ctl` must be encrypted end to end like `data` is.

### 5.3 Frame format

Binary. **Never base64** — base64 inflates every payload by 33%, which on a file
transfer protocol is unacceptable.

A leading `type` byte distinguishes the two frame kinds: `1` = chunk (on
`data`), `2` = control (on `ctl`).

**Chunk frame** (`type = 1`):

```
┌────────┬─────────┬─────────┬────────┬──────────────────┐
│ type   │ transfer│ chunkIdx│ flags  │ ciphertext       │
│ 1 byte │ 4 bytes │ 4 bytes │ 1 byte │ variable         │
└────────┴─────────┴─────────┴────────┴──────────────────┘
```

`flags` bit 0: payload is compressed.

**Control frame** (`type = 2`) — the plaintext is the JSON of one §5.8 `ctl`
message, UTF-8 encoded:

```
┌────────┬──────────┬──────────────────┐
│ type   │ counter  │ ciphertext       │
│ 1 byte │ 8 bytes  │ variable         │
└────────┴──────────┴──────────────────┘
```

`counter` starts at 0 and increments per message **per direction**. A receiver
rejects any counter it has already accepted, so Signal cannot replay a captured
control frame. Renumbering a captured frame does not help either: the counter
feeds the nonce, so a rewritten header simply fails to decrypt.

**Nonce construction — no nonce is transmitted.** Both sides derive it:

```
chunk: nonce = direction(1B)        ‖ transferId(4B) ‖ chunkIndex(4B) ‖ zeros(15B)
ctl:   nonce = 0x80|direction(1B)   ‖ counter(8B)                     ‖ zeros(15B)
```

Saves 24 bytes per frame and eliminates an entire class of nonce-reuse bug.
Uniqueness holds because `transferId` is never reused within a session and
`chunkIndex` is unique within a transfer. The two nonce spaces are **disjoint by
construction** — a chunk nonce's leading byte is 0 or 1, a control nonce's is
`0x80` or `0x81` — so the two frame kinds can safely share one directional key.

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

**`maxChunkSize` is bounded by what the transport will carry, not only by what
the implementation would like to build.** SCTP negotiates a maximum message size
and enforces it — a browser throws, and libwebrtc returns false without a word —
so a peer MUST advertise the smaller of its own ceiling and the figure its data
channel reports, and MUST NOT build a frame larger than the result. Where the
negotiated figure cannot be read, 64 KB is the value RFC 8831 §6.6 requires every
implementation to handle and is therefore the largest that is safe to assume. A
very large reported figure should not be taken at face value: implementations
disagree about fragmenting messages that far, and chunks past 256 KB buy little.

**`network` and `metered` are optional and advisory.** They say what the sender
is connected by (`"wifi"`, `"cellular"`, `"other"`, `"unknown"`) and whether it
pays for the bytes it moves. Only one end can know this — a browser cannot see
its peer's data plan — and §5.6 is the only thing that reads it. A peer that
sends neither field is not making a claim, and nothing may depend on them.

**A Depot MUST NOT wait for the Client's `CAPS` before treating the session as
live.** It sends its own, starts answering, and applies the Client's when it
arrives; until then it assumes the peer accepts no more than the smallest chunk
size in §5.5 — never more than it might have asked for. Gating on `CAPS` looks
safer and is not: the ctl handler is already answering `LIST` by then, so a
`CAPS` that is late or lost produces a Depot that browses perfectly and is, as
far as its own bookkeeping knows, connected to nobody — §5.9 notices go
nowhere, and a file shared afterwards appears only when the Client is reloaded.
A Client has nothing to serve and MAY treat the Depot's `CAPS` as the point its
session opens.

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

**Entropy answers whether a chunk *can* shrink; it does not answer whether
shrinking it is worth the delay.** Compression is not overlapped with sending —
a sender packs a chunk and then puts it on the wire — so the codec's throughput
is a ceiling on the transfer. Ordering the three costs gives

```
compressing wins while   1/compress + ratio/link + 1/decompress  <  1/link
```

which for this implementation's codec comes out around 120 Mbps. Below it the
saving is large and one-sided: on an 8 Mbps mobile link a compressible megabyte
takes about 160 ms packed against 1000 ms raw. Above it the codec becomes the
slow part, and compressing an ordinary text file over a direct LAN connection
more than doubles the time it takes.

A metered connection changes the question rather than the answer. The comparison
above is between processor time and wire time; where the wire is billed by the
byte it costs money as well as time and the processor does not, so a peer that
§5.4 reports as `metered` SHOULD have its chunks compressed whatever the link
measures. The peer is the only one that can know this, which is why it travels
in CAPS rather than being inferred.

So a Depot SHOULD weigh the link's own speed alongside entropy, measured from
the transfer rather than probed for, and SHOULD compress while it has no
measurement — most links are far below the threshold, and the start of a
transfer is exactly when there is nothing to measure from. The threshold belongs
well under the sender's measured figure, because what actually bounds the
decision is the *peer's* decompression speed, which the sender cannot know.

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

**`ctl` channel messages.** `CAPS` (§5.4), `LIST` and `LIST_OK` (§5.9),
`SHARED_CHANGED` (§5.9), `REQUEST_FILE` (Client → Depot, naming a handle
from §5.9 or, with no handle, whatever file the Depot is currently
offering), `MANIFEST` (Depot →
Client, carries `transferId`, `size`, and each chunk's
`offset`/`length`/`hash` since chunks are content-defined and therefore
variable-length), `NEED` (Client → Depot), and `ERROR` (either direction).

Each of these is carried inside an encrypted control frame (§5.3), one
message per frame — Signal sees only ciphertext and a monotonic counter.

**`REJECTED` (§4.2).** Sent by the Depot over the same relay route as
`CHALLENGE`, carrying its reason in the payload.

**Frame `type` byte (§5.3).** `1` = CHUNK, `2` = CTL. Further kinds can be
added without changing either header layout.

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

### 5.9 Browsing

A Depot grants access per folder. §5.7 alone lets a Client ask for "the file
the Depot is offering", which is enough to prove the transport works and not
enough to be a file server. Browsing adds two messages on `ctl`:

```json
{ "type": "LIST", "handle": "" }
```

```json
{
  "type": "LIST_OK",
  "handle": "",
  "entries": [
    { "handle": "k3f9…", "name": "Camera",   "kind": "dir",  "modifiedAt": 1757808000000,
      "writable": true },
    { "handle": "9a21…", "name": "IMG_0001.jpg", "kind": "file", "size": 4404019, "modifiedAt": 1757808000000,
      "mime": "image/jpeg" }
  ]
}
```

An empty `handle` lists the grants themselves — the folders the user has
chosen to share. Any other handle lists that directory's children.
`REQUEST_FILE` (§5.8) gains an optional `handle` naming which file to send;
omitting it keeps the older meaning, "whatever the Depot is currently
offering", so a Client that predates this section still works. A Depot may
offer several files at once outside any folder, each listed as its own entry
with its own handle; a handle-less `REQUEST_FILE` then means the first of
them, since a Client old enough to send no handle has no way to say which.

**Handles are opaque and minted per session.** They are not paths, not
document IDs and not anything the Client can construct — the Depot keeps a
table mapping each handle it has issued to a real location, and resolves
incoming handles only through that table. A Client that invents a handle
gets `ERROR`; one that replays a handle from a previous session gets
`ERROR`, because the table does not outlive the session.

**Within a session a handle is stable, and it names a file rather than a
slot.** Listing the same directory twice MUST return the same handle for
each entry that has not changed, and a Depot MUST NOT reuse a handle for a
different file — so "the file I am currently offering" does not keep one
constant handle across two different picks. Neither rule is about access
control, which the paragraph above already settles; both are about a Client
being able to recognise a file it has already received. A Client is entitled
to treat an unchanged handle as meaning unchanged bytes, and to reuse what
it holds instead of asking again. A Depot that mints a fresh handle on every
listing makes that impossible and sends every file twice; one that reuses a
handle for different bytes makes it wrong, and the Client shows the old file
under the new name.

A Depot cannot always tell two files apart without reading them — name and
length are usually all a listing knows — so a Client MUST also offer the user
some way to ask for a file again regardless of what it holds.

`writable` is optional, directories only, and absent means no. It is how a
Client knows where §5.10 will be accepted, so it can offer that and nothing
else. It is a statement of intent, not an authorisation: a Depot checks the
grant again when the `PUT` arrives, because the listing it sent may be old and
because nothing a Client echoes back decides what the Depot will do.

`mime` is optional and advisory: what the Depot's storage layer calls the
file, where it knows. It exists because a display name is not always enough
— Android content providers routinely return names with no extension, and a
Client that reads only extensions treats those files as unidentifiable.

A Client MUST NOT let `mime` widen what it is willing to do with the bytes.
It is the Depot talking, and a Depot may be a phone someone else is holding.
It may select among renderers the Client would already have used for a known
extension; it must never turn a file into a document the Client would not
otherwise have parsed. A Depot claiming `text/html` gets whatever the Client
does with text, not an HTML parser.

This is the whole of the access control, and it is deliberately not a path
check. Validating a path means writing a correct traversal check and being
right about `..`, symlinks, Unicode normalisation and whatever the platform's
storage layer does with them. There is no such check here, because the Client
never names a location at all: it can only echo back something the Depot
already decided to tell it about. A Depot must therefore never mint a handle
for anything outside a grant — that, and not the shape of any string, is the
property to preserve.

A Depot may refuse `LIST` for a handle that is a file rather than a
directory, and must refuse `REQUEST_FILE` for a handle that is a directory;
both are `ERROR`.

A Depot whose shared set changes while a Client is connected — a folder
granted or withdrawn, a file offered — sends:

```json
{ "type": "SHARED_CHANGED" }
```

It carries nothing. It means only "what you were told is now out of date",
and the Client re-issues `LIST` for whatever it is showing. Sending the new
listing unasked would be worse: the Depot does not know which directory the
Client is looking at, and a Client that has navigated elsewhere would have
to discard it.

This is advisory. A Client that never sees it — because the message was
lost, or because it predates this section — is stale rather than broken,
and re-listing at any point puts it right. A Depot must therefore never
treat having sent it as proof the Client knows.

Listing carries no file contents, but it does carry names, sizes and
timestamps, which §1.2 promises Signal cannot see. Both messages are
therefore ordinary encrypted `ctl` frames (§5.3) like everything else on
that channel.

### 5.10 Upload

Everything above moves files off the phone. This moves one on to it, and it is
the only place in the protocol where a Client causes the Depot to write.

That asymmetry is the whole design. A Depot serves any folder the user granted;
it accepts into **only** those the user separately marked writable, and that flag
defaults to off. Granting a folder to read from is not consent to have things put
in it, and the two are asked for separately because they are different questions.

**A Depot SHOULD also expose an inbox of its own, needing no grant at all.** The
rule above is the right one for writing into someone's Downloads. It is the wrong
one for receiving *anything*, because it made sending from a browser conditional
on a setup step taken on the phone, for a file the phone's owner had just asked
for — and a feature reachable only after configuration is one most people never
find. Such an inbox is listed like any other writable directory and is subject to
every other rule in this section; what makes it safe to offer unconditionally is
that it is storage the Depot application owns, not the user's own. Nothing written
there is visible to anything else on the device until the user moves it out, so
the consent the writable flag was protecting is still asked for — about one real
file, at the moment it means something, rather than in advance about a folder.

**What bounds an upload is storage, not memory.** A Depot SHOULD gather an
upload somewhere that does not grow with its size — writing each verified chunk
to its place in a scratch file, and hashing the result back off disk — and
refuse up front, before the Client sends anything, when there is not room to
gather and then publish it. Holding the chunks in memory ties the largest
acceptable file to the heap, which on a phone is small and not the user's to
choose; the implementation this replaced needed twice an upload's size in
memory and would have been killed well inside the limit it advertised.

**A reservation that is not filled MUST be released.** Reserving a name before
any bytes arrive is what makes "never overwrite" a property of the destination
rather than a rule each transfer has to remember — but where reserving means
creating the file, an upload that dies leaves an empty one behind, still holding
its name, so the retry lands beside it as `photo (1).jpg`. A Depot MUST therefore
give the name back when an upload fails, is abandoned, or is still in flight when
the session ends, and SHOULD abandon one that has gone quiet rather than holding
its reservation for the life of the connection.

Only a Client that has completed §3 and holds a valid credential can reach it, so
this widens what a *paired* device may do and nothing else. A Depot that offers
one MUST still show what arrived, and MUST NOT publish it anywhere the rest of the
device can see without the user saying so.

```json
{
  "type": "PUT",
  "handle": "k3f9…",
  "name": "scan.pdf",
  "size": 182000,
  "chunkCount": 2,
  "chunks": [ { "index": 0, "offset": 0, "length": 91000, "hash": "…" }, … ],
  "fileHash": "…",
  "mime": "application/pdf"
}
```

`handle` is a directory handle the Depot minted (§5.9) — the Client still names
no location. The rest is a manifest of the same shape §5.7 uses, built by the
Client over the file it holds.

```json
{ "type": "PUT_OK", "uploadId": 7, "need": [0, 1] }
```

The Depot answers with an upload id and the chunk indices it wants. `need` may be
shorter than the manifest on a retry, which is how a resumed upload works: the
same content-addressed chunks §5.7 uses mean an interrupted upload does not
restart. The Client then sends those chunks on `data`, encrypted Client→Depot,
framed exactly as §5.3 describes with `uploadId` in place of `transferId`.

```json
{ "type": "PUT_DONE", "uploadId": 7, "name": "scan (1).pdf" }
```

`name` is what the file was actually called once written, which is not always
what was asked for — see collisions below.

**A Depot MUST refuse a `PUT` unless all of these hold**, answering `ERROR`:

1. `handle` resolves to a directory it minted this session.
2. That directory lies inside a grant the user marked writable.
3. `name` is a single path component: no `/`, no `\`, no `..`, no leading dot,
   no control characters, and not empty. A Depot MUST NOT interpret it as a path.
4. The manifest is internally consistent — chunks tile the file exactly, lengths
   are within the negotiated `maxChunkSize`, the count matches the list.
5. `size` is within whatever the Depot is willing to accept, and within the space
   it has.

**A Depot MUST NOT overwrite an existing file.** A name that is already taken is
written under a fresh one, and `PUT_DONE` reports what that was. Overwriting is
how an upload feature becomes a way to destroy things, and there is no version
history here to recover from.

**A Depot MUST verify before publishing.** Each chunk is checked against its hash
as it arrives, and the whole file against `fileHash` before the file is put where
the user can see it. A file that fails either is discarded, not left as a partial
with a plausible name.

Rule 3 is not the security boundary — rule 1 is, and rule 2 is what makes it
consent. A handle already names a directory the Depot chose to mention, so there
is no path to escape from; rule 3 exists because a display name that contains a
separator would be confusing and might be interpreted as a path by something
downstream that is not this protocol.

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
| `watch` | Client → Signal | `depotId` | Asks to be told when that Depot registers. Answered with one `depot_online`, at once if it is already registered, and the Client's socket must stay open to receive it. Signal forgets the watcher when it sends the notice or when the socket goes. |

**A Depot MUST be listening before it sends `register`.** Registering is the
moment Signal begins routing Clients to it and tells any that were watching, so
the first `incoming` can arrive within one round trip of it. On a runtime that
reads its socket on another thread — OkHttp on Android, among many — a message
can be delivered between the `register` call returning and the next line
running, and one that arrives before a listener exists is simply gone. The
Client then waits out its timeout for a CHALLENGE that is never coming. This
was invisible on the web Depot, where JavaScript cannot deliver a message
between two synchronous calls, and cost twenty to thirty seconds on every
phone reconnection once `watch` made the first request prompt.

**A Client SHOULD wait on `watch` rather than asking again.** A Depot's owner
switching it on is a moment Signal knows about exactly when it happens, and
asking on a timer cannot be both immediate and cheap: four seconds is a long
time to stare at a phone that is already on, and shorter intervals are waste
multiplied by every waiting browser. Polling remains the fallback, because a
notice can be lost — Signal keeps no state across restarts by design, and a
socket held open for hours may be dropped by something in between — but it
should be the thing that catches the rare miss rather than the mechanism.

Signal-originated notices: `session_created`, `peer_joined`, `peer_left`,
`incoming`, `depot_online`, and `error` (with a `reason`: `session_expired`, `session_full`,
`session_not_found`, `depot_offline`, `client_revoked`, `rate_limited`,
`no_route`, `bad_envelope`, `already_connected`).

A Depot's `register` connection is long-lived and may have several clients
mid-reconnect concurrently; Signal demultiplexes by tagging relayed envelopes
with `clientId` in both directions on that connection only.

---

## 8. Design decisions

Resolved. Recorded here rather than deleted, so the reasoning survives for
whoever builds the Android app against this spec.

1. **File indexing: on-demand, with an LRU cache.** Pre-hashing every file in
   the background on install would make `NEED` responses instant, but costs
   real battery/CPU scanning a phone's entire storage up front and needs
   invalidation logic for every file-change event. On-demand hashing —
   computing chunk hashes only when a Client actually requests that file, and
   caching the result so a resumed or repeated transfer doesn't re-hash — costs
   nothing for the (typical) files nobody ever pulls remotely, and needs no
   invalidation logic at all: a changed file just hashes differently next
   time it's requested.
2. **Credential renewal: silent, not forced re-approval.** See §4.1.
3. **Multiple Depots per Client: supported, already built.** The data model
   (one `Pairing` record per `depotId`) already allowed it and the Client's
   web implementation already lists every paired Depot and reconnects to
   whichever one you pick — this was never actually blocked on a decision.
4. **Thumbnail generation: on-demand, via Android's MediaStore.** Android
   already generates and caches thumbnails for photos system-wide
   (`MediaStore`/`loadThumbnail()`); the Depot app should serve those instead
   of building and maintaining a parallel thumbnail cache that duplicates
   what the OS already does for free.
5. **SAS length: 6 digits.** See §3.4. The change from 4 was a one-line
   constant with no architectural cost, and it moves the accidental-collision
   odds from 1-in-10,000 to 1-in-1,000,000 for the trivial added cost of
   comparing two more digits.

---

## 9. Changelog

| Version | Date | Change |
|---|---|---|
| 0.5 | 2026-09-19 | Add `SHARED_CHANGED` (§5.9): a Depot tells a connected Client its listing is stale rather than leaving it showing a snapshot from when it connected. Advisory and payload-free — the Client re-issues `LIST`. |
| 0.6 | 2026-09-19 | §5.9: require handles to be stable within a session and to name a file rather than a slot, so a Client can recognise what it already holds and stop fetching the same bytes twice. Both Depot implementations were re-minting on every listing. |
| 0.7 | 2026-09-20 | §5.9: add the optional, advisory `mime` to a listing entry. Advisory only — a Client may use it to pick among renderers it would already have used, never to parse something it otherwise would not. Added because providers return display names with no extension, leaving a Client unable to identify perfectly ordinary photographs. |
| 0.13 | 2026-09-24 | §7.1: a Depot MUST be listening before it sends `register`. On a runtime that reads its socket on another thread a message can arrive between the two, and the first `incoming` after a registration — prompt since `watch` — was being dropped, costing twenty to thirty seconds on every phone reconnection and never reproducing on the JavaScript Depot. §5.10: what bounds an upload is storage, not memory, and a Depot should gather one on disk and refuse up front when there is no room. |
| 0.12 | 2026-09-23 | §7.1: add `watch` / `depot_online`, so a Client waiting for a Depot is told the moment it registers instead of asking again on a timer. No polling interval is both immediate and cheap, and the one in use left someone watching a failure screen for half a minute after switching their phone on. Polling stays as the fallback for a notice that goes missing. §5.10: a reservation that is not filled MUST be released — where reserving means creating the file, every failed upload was leaving an empty one behind that still held its name. |
| 0.11 | 2026-09-22 | §5.4: bound `maxChunkSize` by what the data channel will carry in one message, not only by what an implementation would like to build. SCTP negotiates a maximum and enforces it, and nothing consulted it: every session starts at §5.5's 64 KB tier, whose frames fit everywhere, so this only appeared once a link measured well and the tier climbed — a download went silent because libwebrtc drops a refused frame without a word, and an upload failed with the browser's exception. Also §5.4: optional advisory `network` and `metered`, which only one end can know. §5.6: a metered peer's chunks are compressed whatever the link measures, because where bytes are billed the comparison is no longer processor time against wire time. |
| 0.10 | 2026-09-22 | §5.10: a Depot SHOULD also expose an inbox of its own that needs no grant. Requiring a writable folder made receiving conditional on a setup step taken on the phone, for a file its owner had just asked for, and a feature reachable only after configuration is one most people never find. Storage the Depot application owns is not the user's own storage, so nothing reaches the device at large until the user moves it — the consent the flag protected is asked about one real file instead of in advance about a folder. §5.6: the compression decision now also weighs the link's measured speed, because packing a chunk is not overlapped with sending it and a codec slower than the wire costs more time than it saves. |
| 0.9 | 2026-09-21 | §5.4: forbid waiting for the peer's `CAPS` before treating the session as live, and fix the assumed chunk size for a peer that has said nothing to §5.5's floor. Both Depots gated on it, so a lost `CAPS` produced a session that answered `LIST` but was recorded as nobody — `SHARED_CHANGED` went nowhere and a newly shared file appeared only on a reload. §5.9: say that several files may be offered at once outside any folder, and what a handle-less `REQUEST_FILE` means when there are. |
| 0.8 | 2026-09-20 | Add §5.10 upload — `PUT` / `PUT_OK` / `PUT_DONE`, the one direction in which a Client causes the Depot to write. Gated on a per-grant writable flag that defaults to off, because granting a folder to read from is not consent to have things put in it. Never overwrites; verifies before publishing. |
| 0.4 | 2026-09-19 | Add §5.9 browsing: `LIST`/`LIST_OK` over `ctl`, and an optional handle on `REQUEST_FILE`. Handles are opaque and minted per session, so a Client never names a location and there is no path to traverse. Backwards compatible — a `REQUEST_FILE` with no handle keeps its old meaning. |
| 0.3 | 2026-09-16 | Add §4.2 REJECTED: a Depot refusing a reconnection now says why, so a revoked or unpaired device sees the reason instead of an unexplained timeout. |
| 0.2 | 2026-09-15 | Encrypt the `ctl` channel with the session keys (§5.2, §5.3). DTLS alone left the `MANIFEST` — file name, size, chunk hashes — readable and forgeable by a Signal that substitutes DTLS fingerprints in the SDP it relays, contradicting §1.2. Adds the CTL frame kind, a per-direction counter with replay rejection, and a disjoint nonce space. |
| 0.1 | 2026-09-15 | Initial draft |