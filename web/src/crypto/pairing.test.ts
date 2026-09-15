import { describe, expect, it } from 'vitest'
import { aeadDecrypt, aeadEncrypt } from './aead'
import { toBase64 } from './codec'
import { issueCredential, verifyCredential } from './credential'
import { computeSAS, deriveKeys, ecdh, pairingTranscript } from './derive'
import { generateEphemeralKeyPair, generateIdentityKeyPair, randomBytes } from './keys'
import { reconnectTranscript, signReconnectResponse, verifyReconnectResponse } from './reconnect'
import { buildTranscript, utf8 } from './transcript'

async function runPairing() {
  const clientEphemeral = await generateEphemeralKeyPair()
  const clientIdentity = await generateIdentityKeyPair()
  const depotEphemeral = await generateEphemeralKeyPair()
  const depotIdentity = await generateIdentityKeyPair()
  const sessionId = await randomBytes(16)
  const nonce = await randomBytes(16)

  const transcriptInput = {
    version: 1,
    sessionId,
    clientEk: clientEphemeral.publicKey,
    clientIk: clientIdentity.publicKey,
    depotEk: depotEphemeral.publicKey,
    depotIk: depotIdentity.publicKey,
    nonce,
  }
  const transcript = pairingTranscript(transcriptInput)

  const clientShared = await ecdh(clientEphemeral.privateKey, depotEphemeral.publicKey)
  const depotShared = await ecdh(depotEphemeral.privateKey, clientEphemeral.publicKey)

  const clientKeys = await deriveKeys(clientShared, transcript)
  const depotKeys = await deriveKeys(depotShared, transcript)

  return { clientEphemeral, clientIdentity, depotEphemeral, depotIdentity, transcriptInput, clientKeys, depotKeys }
}

describe('X25519 key agreement (protocol.md §3.3)', () => {
  it('both sides derive the identical shared secret and SAS', async () => {
    const { clientKeys, depotKeys } = await runPairing()

    expect(toBase64(clientKeys.master)).toBe(toBase64(depotKeys.master))
    expect(toBase64(clientKeys.kC2D)).toBe(toBase64(depotKeys.kC2D))
    expect(toBase64(clientKeys.kD2C)).toBe(toBase64(depotKeys.kD2C))
    expect(computeSAS(clientKeys.sasSeed)).toBe(computeSAS(depotKeys.sasSeed))
  })

  it('directional keys differ from each other', async () => {
    const { clientKeys } = await runPairing()
    expect(toBase64(clientKeys.kC2D)).not.toBe(toBase64(clientKeys.kD2C))
  })

  it('SAS is a 4-digit decimal string', async () => {
    const { clientKeys } = await runPairing()
    const sas = computeSAS(clientKeys.sasSeed)
    expect(sas).toMatch(/^\d{4}$/)
  })
})

describe('MITM detection via SAS mismatch (protocol.md §3.4)', () => {
  it('a Signal-substituted depotEk produces a different SAS on each side', async () => {
    // Client computes its shared secret against the real Depot's ephemeral
    // key, as it believes it received directly. An attacking Signal server
    // instead gave the Depot a *different* ephemeral key of its own, so the
    // Depot's shared secret (and therefore its transcript and SAS) is
    // computed against a key the Client never saw.
    const clientEphemeral = await generateEphemeralKeyPair()
    const clientIdentity = await generateIdentityKeyPair()
    const realDepotEphemeral = await generateEphemeralKeyPair()
    const attackerEphemeral = await generateEphemeralKeyPair()
    const depotIdentity = await generateIdentityKeyPair()
    const sessionId = await randomBytes(16)
    const nonce = await randomBytes(16)

    const clientTranscript = pairingTranscript({
      version: 1,
      sessionId,
      clientEk: clientEphemeral.publicKey,
      clientIk: clientIdentity.publicKey,
      depotEk: realDepotEphemeral.publicKey,
      depotIk: depotIdentity.publicKey,
      nonce,
    })
    const clientShared = await ecdh(clientEphemeral.privateKey, attackerEphemeral.publicKey)
    const clientKeys = await deriveKeys(clientShared, clientTranscript)

    const depotTranscript = pairingTranscript({
      version: 1,
      sessionId,
      clientEk: clientEphemeral.publicKey,
      clientIk: clientIdentity.publicKey,
      depotEk: attackerEphemeral.publicKey,
      depotIk: depotIdentity.publicKey,
      nonce,
    })
    const depotShared = await ecdh(realDepotEphemeral.privateKey, clientEphemeral.publicKey)
    const depotKeys = await deriveKeys(depotShared, depotTranscript)

    expect(computeSAS(clientKeys.sasSeed)).not.toBe(computeSAS(depotKeys.sasSeed))
  })
})

describe('length-prefixed transcript (protocol.md §3.3)', () => {
  it('prevents field-boundary collisions that naive concatenation allows', () => {
    // Naive concatenation: ("ab","c") and ("a","bc") collide to the same bytes.
    const naiveA = new Uint8Array([...utf8('ab'), ...utf8('c')])
    const naiveB = new Uint8Array([...utf8('a'), ...utf8('bc')])
    expect(toBase64(naiveA)).toBe(toBase64(naiveB))

    // Length-prefixed: the same two splits no longer collide.
    const prefixedA = buildTranscript([utf8('ab'), utf8('c')])
    const prefixedB = buildTranscript([utf8('a'), utf8('bc')])
    expect(toBase64(prefixedA)).not.toBe(toBase64(prefixedB))
  })
})

describe('credential (protocol.md §3.6)', () => {
  it('verifies a genuine credential and rejects a tampered one', async () => {
    const depotIdentity = await generateIdentityKeyPair()
    const clientIdentity = await generateIdentityKeyPair()
    const depotId = toBase64(depotIdentity.publicKey)
    const clientId = toBase64(clientIdentity.publicKey)

    const cred = await issueCredential(depotIdentity.privateKey, depotId, clientId)
    expect(await verifyCredential(cred, depotIdentity.publicKey)).toBe(true)

    const tampered = { ...cred, clientId: toBase64((await generateIdentityKeyPair()).publicKey) }
    expect(await verifyCredential(tampered, depotIdentity.publicKey)).toBe(false)
  })

  it('rejects an expired credential even with a valid signature', async () => {
    const depotIdentity = await generateIdentityKeyPair()
    const clientIdentity = await generateIdentityKeyPair()
    const depotId = toBase64(depotIdentity.publicKey)
    const clientId = toBase64(clientIdentity.publicKey)

    const issuedInThePast = Date.now() - 200 * 24 * 60 * 60 * 1000
    const cred = await issueCredential(depotIdentity.privateKey, depotId, clientId, issuedInThePast)

    expect(await verifyCredential(cred, depotIdentity.publicKey)).toBe(false)
  })

  it('does not verify against the wrong Depot identity', async () => {
    const depotIdentity = await generateIdentityKeyPair()
    const impostorIdentity = await generateIdentityKeyPair()
    const clientIdentity = await generateIdentityKeyPair()
    const depotId = toBase64(depotIdentity.publicKey)
    const clientId = toBase64(clientIdentity.publicKey)

    const cred = await issueCredential(depotIdentity.privateKey, depotId, clientId)
    expect(await verifyCredential(cred, impostorIdentity.publicKey)).toBe(false)
  })
})

describe('session key AEAD (protocol.md §2)', () => {
  it('K_c2d derived on the client decrypts on the depot side, and a flipped bit is rejected', async () => {
    const { clientKeys, depotKeys } = await runPairing()
    const message = utf8('hello from the client')

    const { nonce, ciphertext } = await aeadEncrypt(clientKeys.kC2D, message)
    const opened = await aeadDecrypt(depotKeys.kC2D, nonce, ciphertext)
    expect(new TextDecoder().decode(opened)).toBe('hello from the client')

    const flipped = new Uint8Array(ciphertext)
    flipped[0] ^= 0xff
    await expect(aeadDecrypt(depotKeys.kC2D, nonce, flipped)).rejects.toBeTruthy()
  })
})

describe('reconnection challenge-response (protocol.md §4)', () => {
  it('a fresh signature verifies, and a stolen credential alone cannot forge one', async () => {
    const clientIdentity = await generateIdentityKeyPair()
    const attackerIdentity = await generateIdentityKeyPair()
    const clientEk = (await generateEphemeralKeyPair()).publicKey
    const depotEk = (await generateEphemeralKeyPair()).publicKey
    const challengeNonce = await randomBytes(16)

    const transcript = reconnectTranscript(clientEk, depotEk, challengeNonce)
    const sig = await signReconnectResponse(clientIdentity.privateKey, transcript)
    expect(await verifyReconnectResponse(sig, transcript, clientIdentity.publicKey)).toBe(true)

    // Possessing the credential (a public claim) is not possessing the
    // private key: an attacker with only the credential cannot produce a
    // signature that verifies against the real clientIdentityPub.
    const forged = await signReconnectResponse(attackerIdentity.privateKey, transcript)
    expect(await verifyReconnectResponse(forged, transcript, clientIdentity.publicKey)).toBe(false)
  })

  it('a signature from one reconnection does not verify against a different challenge', async () => {
    const clientIdentity = await generateIdentityKeyPair()
    const clientEk = (await generateEphemeralKeyPair()).publicKey
    const depotEk = (await generateEphemeralKeyPair()).publicKey

    const transcript1 = reconnectTranscript(clientEk, depotEk, await randomBytes(16))
    const transcript2 = reconnectTranscript(clientEk, depotEk, await randomBytes(16))

    const sig = await signReconnectResponse(clientIdentity.privateKey, transcript1)
    expect(await verifyReconnectResponse(sig, transcript2, clientIdentity.publicKey)).toBe(false)
  })
})
