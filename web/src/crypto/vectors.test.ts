import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sodium } from './sodium'
import { toBase64, toHex } from './codec'
import { buildTranscript, u8, utf8 } from './transcript'
import { computeSAS, deriveKeys, ecdh, pairingTranscript } from './derive'
import { depotChallengeBytes, reconnectTranscript, signDepotChallenge, signReconnectResponse } from './reconnect'
import { Direction, deriveChunkNonce, deriveCtlNonce, encodeChunkFrame, encodeCtlFrame } from '../transport/frame'

/** Deterministic filler so vectors are reproducible without randomness. */
function seq(n: number, start: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (start + i * 7) & 0xff
  return out
}

const VECTORS_PATH = '../docs/vectors/test-vectors.json'

/**
 * docs/test-vectors.json is the contract between the web and Android
 * implementations: both assert against it, so a change to either one that
 * moves a derived key, a SAS or a frame byte fails here instead of at
 * integration time as an unexplained SAS mismatch.
 *
 * Regenerate deliberately, only when the wire format is meant to change:
 *   REGEN_VECTORS=1 npx vitest run src/crypto/vectors.test.ts
 */
describe('cross-implementation test vectors', () => {
  it('matches docs/test-vectors.json', async () => {
    const s = await sodium()

    // --- fixed key material -------------------------------------------
    const clientEkPriv = seq(32, 1)
    const depotEkPriv = seq(32, 100)
    const clientEkPub = s.crypto_scalarmult_base(clientEkPriv)
    const depotEkPub = s.crypto_scalarmult_base(depotEkPriv)

    const clientIkSeed = seq(32, 200)
    const depotIkSeed = seq(32, 50)
    const clientIk = s.crypto_sign_seed_keypair(clientIkSeed)
    const depotIk = s.crypto_sign_seed_keypair(depotIkSeed)

    const sessionId = seq(16, 9)
    const nonce = seq(16, 77)

    // --- pairing derivation (§3.3) ------------------------------------
    const transcript = pairingTranscript({
      version: 1,
      sessionId,
      clientEk: clientEkPub,
      clientIk: clientIk.publicKey,
      depotEk: depotEkPub,
      depotIk: depotIk.publicKey,
      nonce,
    })
    const shared = await ecdh(clientEkPriv, depotEkPub)
    const keys = await deriveKeys(shared, transcript)

    // --- credential signing bytes (§3.6) ------------------------------
    const depotId = toBase64(depotIk.publicKey)
    const clientId = toBase64(clientIk.publicKey)
    const issuedAt = 1700000000000
    const expiresAt = issuedAt + 90 * 24 * 60 * 60 * 1000
    function u64be(n: number): Uint8Array {
      const out = new Uint8Array(8)
      new DataView(out.buffer).setBigUint64(0, BigInt(n))
      return out
    }
    const credBytes = buildTranscript([utf8(depotId), utf8(clientId), u64be(issuedAt), u64be(expiresAt)])
    const credSig = s.crypto_sign_detached(credBytes, depotIk.privateKey)

    // --- reconnect (§4) -----------------------------------------------
    const challengeNonce = seq(16, 33)
    const rTranscript = reconnectTranscript(clientEkPub, depotEkPub, challengeNonce)
    const rSig = await signReconnectResponse(clientIk.privateKey, rTranscript)
    const dBytes = depotChallengeBytes(clientEkPub, depotEkPub, challengeNonce)
    const dSig = await signDepotChallenge(depotIk.privateKey, clientEkPub, depotEkPub, challengeNonce)

    // --- frames (§5.3) ------------------------------------------------
    const chunkPlain = seq(64, 5)
    const chunkFrame = await encodeChunkFrame(keys.kD2C, Direction.DepotToClient, {
      transferId: 7,
      chunkIndex: 3,
      plaintext: chunkPlain,
      compressed: false,
    })
    const ctlPlain = new Uint8Array(new TextEncoder().encode('{"type":"REQUEST_FILE"}'))
    const ctlFrame = await encodeCtlFrame(keys.kC2D, Direction.ClientToDepot, 2, ctlPlain)

    const vectors = {
      _comment:
        'Known-answer vectors shared by the web and Android implementations. ' +
        'Generated from web/src/crypto/genvectors.test.ts. If a value here changes, ' +
        'the wire format changed and BOTH implementations must be updated.',
      transcript: {
        _comment: 'protocol.md §3.3 length-prefixed concatenation',
        fields: ['00', 'aabb', '', 'ff00ff'],
        expected: toHex(buildTranscript([new Uint8Array([0]), new Uint8Array([0xaa, 0xbb]), new Uint8Array(0), new Uint8Array([0xff, 0x00, 0xff])])),
      },
      pairing: {
        _comment: 'protocol.md §3.3 key derivation and §3.4 SAS',
        clientEkPriv: toHex(clientEkPriv),
        clientEkPub: toHex(clientEkPub),
        depotEkPriv: toHex(depotEkPriv),
        depotEkPub: toHex(depotEkPub),
        clientIkSeed: toHex(clientIkSeed),
        clientIkPub: toHex(clientIk.publicKey),
        depotIkSeed: toHex(depotIkSeed),
        depotIkPub: toHex(depotIk.publicKey),
        version: 1,
        sessionId: toHex(sessionId),
        nonce: toHex(nonce),
        transcript: toHex(transcript),
        sharedSecret: toHex(shared),
        master: toHex(keys.master),
        kC2D: toHex(keys.kC2D),
        kD2C: toHex(keys.kD2C),
        sasSeed: toHex(keys.sasSeed),
        sas: computeSAS(keys.sasSeed),
      },
      credential: {
        _comment: 'protocol.md §3.6 — signing bytes are length-prefixed(depotId, clientId, u64be(issuedAt), u64be(expiresAt))',
        depotId,
        clientId,
        issuedAt,
        expiresAt,
        signingBytes: toHex(credBytes),
        sig: toBase64(credSig),
      },
      reconnect: {
        _comment: 'protocol.md §4 challenge-response',
        challengeNonce: toHex(challengeNonce),
        transcript: toHex(rTranscript),
        sig: rSig,
        depotChallengeBytes: toHex(dBytes),
        depotSig: dSig,
      },
      nonces: {
        _comment: 'protocol.md §5.3 derived nonces; the two spaces must stay disjoint',
        chunk_d2c_t7_i3: toHex(await deriveChunkNonce(Direction.DepotToClient, 7, 3)),
        chunk_c2d_t0_i0: toHex(await deriveChunkNonce(Direction.ClientToDepot, 0, 0)),
        ctl_c2d_counter2: toHex(await deriveCtlNonce(Direction.ClientToDepot, 2)),
        ctl_d2c_counter0: toHex(await deriveCtlNonce(Direction.DepotToClient, 0)),
      },
      frames: {
        _comment: 'Full encrypted frames — deterministic because nonces are derived, not random',
        chunk: {
          key: toHex(keys.kD2C),
          direction: 'DepotToClient',
          transferId: 7,
          chunkIndex: 3,
          compressed: false,
          plaintext: toHex(chunkPlain),
          frame: toHex(chunkFrame),
        },
        ctl: {
          key: toHex(keys.kC2D),
          direction: 'ClientToDepot',
          counter: 2,
          plaintext: toHex(ctlPlain),
          plaintextUtf8: '{"type":"REQUEST_FILE"}',
          frame: toHex(ctlFrame),
        },
      },
    }

    if (process.env.REGEN_VECTORS) {
      writeFileSync(VECTORS_PATH, JSON.stringify(vectors, null, 2) + '\n')
      return
    }

    const committed: unknown = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'))
    expect(vectors).toEqual(committed)
    void u8
  })
})
