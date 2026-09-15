import { aeadDecrypt, aeadEncrypt } from '../crypto/aead'
import { fromBase64, toBase64 } from '../crypto/codec'
import type { Credential } from '../crypto/credential'
import { verifyCredential } from '../crypto/credential'
import { deriveKeys, ecdh } from '../crypto/derive'
import { generateEphemeralKeyPair, randomBytes } from '../crypto/keys'
import type { KeyPair } from '../crypto/keys'
import { reconnectTranscript, verifyReconnectResponse } from '../crypto/reconnect'
import { utf8 } from '../crypto/transcript'
import { getDevice, touchDevice } from '../storage/devices'
import { loadOrCreateIdentity } from '../storage/identityStore'
import { SignalClient } from '../signal/client'
import { TypePeerLeft } from '../signal/envelope'

export interface DepotReconnectCallbacks {
  onStatus: (status: string) => void
  onRegistered: (depotId: string) => void
  onClientConnected: (info: { clientId: string; pingRoundtripOk: boolean }) => void
  onClientRejected: (info: { clientId: string; reason: string }) => void
  onError: (message: string) => void
}

interface IncomingPayload {
  credential: Credential
  clientEk: string
}

export interface DepotReconnectListener {
  depotId: string
  stop: () => void
  /** Sends REVOKE on the same registered connection (Go hub requires this — see hub.go handleRevoke). */
  revoke: (clientId: string) => void
}

/**
 * Depot side of protocol.md §4, run as a background listener: registers
 * presence once, then handles as many concurrent reconnecting clients as
 * arrive, each independently.
 */
export async function runDepotReconnectListener(
  signalUrl: string,
  cb: DepotReconnectCallbacks,
): Promise<DepotReconnectListener> {
  const depotIdentity = await loadOrCreateIdentity('identity:depot')
  const depotId = toBase64(depotIdentity.publicKey)

  cb.onStatus('connecting to signal')
  const client = new SignalClient(signalUrl)
  await client.ready()

  client.register(depotId)
  cb.onStatus('registered, listening for reconnections')
  cb.onRegistered(depotId)

  const unsubscribe = client.onMessage((e) => {
    if (e.type === 'incoming' && e.clientId) {
      void handleIncoming(client, depotIdentity, e.clientId, e.payload, cb)
    }
  })

  return {
    depotId,
    stop: () => {
      unsubscribe()
      client.close()
    },
    revoke: (clientId: string) => client.revoke(clientId),
  }
}

async function handleIncoming(
  client: SignalClient,
  depotIdentity: KeyPair,
  clientId: string,
  payload: unknown,
  cb: DepotReconnectCallbacks,
): Promise<void> {
  try {
    const { credential, clientEk } = payload as IncomingPayload
    const depotId = toBase64(depotIdentity.publicKey)

    if (credential.depotId !== depotId) throw new Error('credential is for a different Depot')
    if (credential.clientId !== clientId) throw new Error('credential clientId does not match sender')
    if (!(await verifyCredential(credential, depotIdentity.publicKey))) {
      throw new Error('invalid or expired credential')
    }

    const device = await getDevice(clientId)
    if (!device || device.revoked) throw new Error('not a known, un-revoked device — pair first')

    const depotEphemeral = await generateEphemeralKeyPair()
    const challengeNonce = await randomBytes(16)
    client.relay(
      'CHALLENGE',
      { depotEk: toBase64(depotEphemeral.publicKey), challengeNonce: toBase64(challengeNonce) },
      clientId,
    )

    const response = await client.waitFor(
      (e) => e.clientId === clientId && (e.type === 'RESPONSE' || e.type === TypePeerLeft),
      15_000,
    )
    if (response.type !== 'RESPONSE') throw new Error('client disconnected before responding')

    const { sig } = response.payload as { sig: string }
    const clientEkBytes = fromBase64(clientEk)
    const transcript = reconnectTranscript(clientEkBytes, depotEphemeral.publicKey, challengeNonce)
    const clientIdentityPub = fromBase64(clientId)
    if (!(await verifyReconnectResponse(sig, transcript, clientIdentityPub))) {
      throw new Error('signature does not match the stored ClientIdentity')
    }

    await touchDevice(clientId)
    client.relay('SESSION_OK', {}, clientId)

    // Demo-only: prove the freshly derived session keys actually agree.
    const shared = await ecdh(depotEphemeral.privateKey, clientEkBytes)
    const keys = await deriveKeys(shared, transcript)
    let pingRoundtripOk = false
    try {
      const { nonce, ciphertext } = await aeadEncrypt(keys.kD2C, utf8('ping'))
      client.relay('PING', { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) }, clientId)
      const pong = await client.waitFor((e) => e.clientId === clientId && e.type === 'PONG', 10_000)
      const { nonce: pongNonce, ciphertext: pongCiphertext } = pong.payload as { nonce: string; ciphertext: string }
      const opened = await aeadDecrypt(keys.kC2D, fromBase64(pongNonce), fromBase64(pongCiphertext))
      pingRoundtripOk = toBase64(opened) === toBase64(utf8('ping'))
    } catch {
      // Ping/pong is a demo confirmation only; its absence doesn't fail reconnection.
    }

    cb.onClientConnected({ clientId, pingRoundtripOk })
  } catch (err) {
    cb.onClientRejected({ clientId, reason: err instanceof Error ? err.message : String(err) })
  }
}
