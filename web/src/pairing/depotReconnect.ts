import { fromBase64, toBase64 } from '../crypto/codec'
import type { Credential } from '../crypto/credential'
import { issueCredential, verifyCredential } from '../crypto/credential'
import { deriveKeys, ecdh } from '../crypto/derive'
import { generateEphemeralKeyPair, randomBytes } from '../crypto/keys'
import type { KeyPair } from '../crypto/keys'
import { reconnectTranscript, verifyReconnectResponse } from '../crypto/reconnect'
import { getDevice, touchDevice } from '../storage/devices'
import { loadOrCreateIdentity } from '../storage/identityStore'
import { SignalClient } from '../signal/client'
import { TypePeerLeft } from '../signal/envelope'
import { negotiateAsAnswerer, type ConnectionType, type TurnConfig } from '../transport/webrtc'
import { runFileSender, type OfferedFile, type SenderEvent } from '../transport/transferSession'

export interface DepotReconnectCallbacks {
  onStatus: (status: string) => void
  onRegistered: (depotId: string) => void
  onClientConnected: (info: { clientId: string; connectionType: ConnectionType }) => void
  onClientProgress: (info: {
    clientId: string
    index: number
    total: number
    bytesSent?: number
    bytesTotal?: number
  }) => void
  onClientRejected: (info: { clientId: string; reason: string }) => void
  onError: (message: string) => void
}

interface IncomingPayload {
  credential: Credential
  clientEk: string
}

// protocol.md §4.1 / §8.2: silent renewal, not forced re-approval — a
// device that keeps reconnecting never has to redo the §3 QR+SAS flow, one
// that stops reconnecting simply has its credential expire on schedule.
const RENEW_WITHIN_MS = 30 * 24 * 60 * 60 * 1000

export interface DepotReconnectListener {
  depotId: string
  stop: () => void
  /** Sends REVOKE on the same registered connection (Go hub requires this — see hub.go handleRevoke). */
  revoke: (clientId: string) => void
}

/**
 * Depot side of protocol.md §4, run as a background listener: registers
 * presence once, then handles as many concurrent reconnecting clients as
 * arrive, each independently, offering whatever file getFile() returns at
 * the moment a client requests one (§5.7).
 */
export async function runDepotReconnectListener(
  signalUrl: string,
  getFile: () => OfferedFile | null,
  turn: TurnConfig | undefined,
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

  // protocol.md §6 step 3 — "Any live DataChannel to that Client is closed
  // immediately" is the step that actually matters; signal-level REVOKE is
  // only the routing optimisation. Track live connections so revoke() can do it.
  const activeConnections = new Map<string, () => void>()

  const unsubscribe = client.onMessage((e) => {
    if (e.type === 'incoming' && e.clientId) {
      void handleIncoming(client, depotIdentity, e.clientId, e.payload, getFile, turn, activeConnections, cb)
    }
  })

  return {
    depotId,
    stop: () => {
      unsubscribe()
      client.close()
      for (const close of activeConnections.values()) close()
      activeConnections.clear()
    },
    revoke: (clientId: string) => {
      client.revoke(clientId)
      activeConnections.get(clientId)?.()
      activeConnections.delete(clientId)
    },
  }
}

async function handleIncoming(
  client: SignalClient,
  depotIdentity: KeyPair,
  clientId: string,
  payload: unknown,
  getFile: () => OfferedFile | null,
  turn: TurnConfig | undefined,
  activeConnections: Map<string, () => void>,
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
    let renewedCredential: Credential | undefined
    if (credential.expiresAt - Date.now() < RENEW_WITHIN_MS) {
      renewedCredential = await issueCredential(depotIdentity.privateKey, depotId, clientId)
    }
    client.relay('SESSION_OK', renewedCredential ? { credential: renewedCredential } : {}, clientId)

    const shared = await ecdh(depotEphemeral.privateKey, clientEkBytes)
    const keys = await deriveKeys(shared, transcript)

    const channels = await negotiateAsAnswerer(client, clientId, turn)
    activeConnections.set(clientId, channels.close)
    cb.onClientConnected({ clientId, connectionType: channels.connectionType })

    const onSenderEvent = (e: SenderEvent) => {
      if (e.type === 'chunk-sent' && e.index !== undefined && e.total !== undefined) {
        cb.onClientProgress({
          clientId,
          index: e.index,
          total: e.total,
          bytesSent: e.bytesSent,
          bytesTotal: e.bytesTotal,
        })
      }
    }
    const stopSending = await runFileSender(channels, { kC2D: keys.kC2D, kD2C: keys.kD2C }, getFile, onSenderEvent)
    activeConnections.set(clientId, () => {
      stopSending()
      channels.close()
    })
  } catch (err) {
    cb.onClientRejected({ clientId, reason: err instanceof Error ? err.message : String(err) })
  }
}
