# android

The Depot app — the phone side of the protocol, and the real product. The
Depot simulator in [`../web`](../web) exists only to develop against until this
is complete.

Implements [`../docs/protocol.md`](../docs/protocol.md). Kotlin + Jetpack
Compose, libsodium via lazysodium.

## Status

| Piece | State |
|---|---|
| Crypto core (§3.3, §3.6, §4, §5.3) | ✅ implemented, verified against shared vectors |
| Signal client (§7.1) | ✅ implemented |
| Pairing flow + SAS screen (§3) | ✅ implemented |
| QR camera scanning | ✅ implemented (paste remains as fallback) |
| Reconnection §4 (challenge-response, renewal, revoke) | ✅ implemented |
| WebRTC transport (§5) | ✅ implemented (sender side, streamed) |
| Adaptive chunk sizing (§5.5) | ✅ implemented |
| Folder grants + browsing (§5.9) | ✅ implemented |
| Revocation (§6) | ✅ implemented |
| Foreground service | ✅ implemented |
| Interface, per the design spec | ✅ implemented |

## Interface

The screens follow the project's interface spec — the [Depot — Interface
Design](https://claude.ai/artifact/CMxsYXcZNY8XTzkoSGYwPn) artifact — rather
than Material defaults, and share their tokens with `web/src/index.css` so the
phone and the browser read as one product.

`ui/components/` holds the spec's CSS classes translated one for one into
Compose (`.status-hero`, `.dev`, `.lbl`, `.cta`, `.sheet`, `.conn`), which is
what stops the design drifting screen by screen. The screens themselves are the
artifact's phone frames:

| Frame | Where |
|---|---|
| HOME · DEPOT STATUS | `ui/HomeScreen.kt` |
| SCAN · READ QR | `ui/QrScanner.kt` |
| APPROVE · SAS CHECK | `ui/LinkFlow.kt` |
| ACCESS · folder grants | `ui/GrantsScreen.kt` |

There is no tab bar because the spec has none: a Depot has one home screen, and
scanning, approving, a device and the settings all arrive over it and then go
away, which keeps the terminal's own state continuously in view.

Four deliberate departures from the artifact, all because the app cannot yet
honestly draw what it shows:

- **Grants are folders, and the ACCESS screen is real.** With `LIST` in the
  protocol, the spec's folder toggles stopped being a mock.
- **The SAS is six digits, not four.** protocol.md §3.3 is the authority; the
  treatment is the spec's.
- **Grant rows count immediate children, not the whole tree.** The spec's
  "2,418 FILES · 28.4 GB" is real here, read off the Storage Access
  Framework — but for a folder's direct contents only. Walking a deep photo
  library to refine a figure that exists to convey rough scale would cost far
  more than the refinement is worth.
- **The approval sheet does not name a city or a browser.** The artifact shows
  "Chrome on Windows · DELHI, INDIA". At that moment the Depot genuinely knows
  neither, and a Client could assert anything about itself. It shows the Signal
  server the request arrived through instead, and asks for a name *after*
  pairing — which is also why `DeviceStore.rename` exists.
- **Reject is a real button.** Telling someone the digits might not match and
  then offering no way to say so makes §3.4 theatre, so `onSas` now carries a
  `reject` alongside `approve`.

## Staying registered

`DepotSession` supervises its Signal connection rather than making it once.
A WebSocket does not survive a phone sleeping, changing network, or sitting
idle behind a NAT that gives up on it — and when one dies the Depot stops
being registered, so every Client asking for it is told it is offline while
the phone goes on claiming to listen. Nothing noticed this, and the only
cure was toggling the terminal off and on by hand.

`SignalClient` now reports the socket ending, and the session registers
again with exponential backoff up to 30s, clearing `listeningAs` in between
so the UI stops claiming to be online while it is not.

## Sharing (§5.9)

`GrantStore` holds the folders the user picked with
`ACTION_OPEN_DOCUMENT_TREE`, each with a persisted read permission so a grant
survives a reboot. `AndroidDepotSource` turns those into the listings a Client
browses, via `DocumentsContract` rather than the `documentfile` library — the
framework APIs do the job with no extra dependency.

When a grant changes or a file is offered, every connected Client is told its
listing is stale (`SHARED_CHANGED`, §5.9) and re-lists. Without that a browser
shows what was true at the moment it connected, and a newly shared file only
appears if someone reloads the page.

Handles are random, minted per listening session, and resolved only through an
in-memory table. That is the whole of the access control, and deliberately
*not* a path check: a Client never names a location, it can only echo back
something the Depot already chose to tell it about, so there is no traversal
to get wrong. The rule to preserve is that nothing outside a grant is ever
given a handle.

Files are streamed, not buffered. `DepotSource.open` returns a `ServableFile`
that can open its own `InputStream`, and §5.7 pulls the bytes through twice:
once for `buildManifestStreaming`, which chunks and hashes as it goes and folds
the whole-file hash in incrementally, and once for `NEED`, which walks forward
through the requested offsets. Neither pass holds more than one chunk, so the
size of a file no longer has anything to do with the size of the heap.

That only works because the streaming chunker cuts in exactly the same places
as the buffered one — its sliding window is twice `maxSize`, so every boundary
decision sees the same lookahead the whole-array version would have.
`ChunkStreamTest` pins that down on the JVM, and `TransportTest` checks the two
manifests come out identical.

Space Grotesk and IBM Plex Mono are bundled in `app/src/main/res/font` rather
than fetched, so the type is right on a device with no network and no Play
Services — the same reason QR scanning uses bundled ML Kit. See
[FONTS.md](FONTS.md).

## Build

Requires the Android SDK with a platform matching `compileSdk` in
`app/build.gradle.kts`. Open in Android Studio, or:

```bash
./gradlew assembleDebug
```

## Cross-implementation test vectors

`app/src/androidTest/.../crypto/VectorsTest.kt` asserts this implementation
against [`../docs/vectors/test-vectors.json`](../docs/vectors/test-vectors.json)
— the same file `web/src/crypto/vectors.test.ts` checks itself against. The
build points `androidTest` assets at that directory rather than copying it, so
there is one source of truth and the two implementations cannot drift apart
unnoticed.

This matters because the failure mode it prevents is miserable to debug: if
Android and web derive even one differing byte in a transcript, pairing fails in
the field as an unexplained SAS mismatch with nothing in either log to explain
it.

These are instrumented tests — lazysodium loads a native library, so they need a
device or emulator:

```bash
./gradlew connectedDebugAndroidTest
```

The formatting the interface spec calls for ("41.2 GB", "612 MB", "6h 12m",
"0:09") is pure JVM logic and is checked without a device:

```bash
./gradlew testDebugUnitTest
```

If they fail, fix the implementation. Only regenerate the vectors when the wire
format is deliberately changing, and then update both sides together:

```bash
cd ../web && REGEN_VECTORS=1 npx vitest run src/crypto/vectors.test.ts
```
