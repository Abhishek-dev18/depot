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
| Pairing flow + SAS screen (§3) | ✅ implemented (QR payload pasted) |
| QR camera scanning | ⬜ not started |
| WebRTC transport (§5) | ⬜ not started |

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

If they fail, fix the implementation. Only regenerate the vectors when the wire
format is deliberately changing, and then update both sides together:

```bash
cd ../web && REGEN_VECTORS=1 npx vitest run src/crypto/vectors.test.ts
```
