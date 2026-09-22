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
import { TypeRejected, type RejectedPayload } from './rejection'
import { negotiateAsAnswerer, type ConnectionType, type TurnConfig } from '../transport/webrtc'
import { runFileSender, type DepotSource, type RunningSender, type SenderEvent } from '../transport/transferSession'

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

  /**
   * protocol.md §5.9 — tell every connected Client that what it was shown
   * is out of date. Called when a file is offered or a grant changes,
   * which is the difference between a browser that updates and one that
   * has to be reloaded by hand.
   */
  notifySharedChanged: () => void
  stop: () => void
  /** Sends REVOKE on the same registered connection (Go hub requires this — see hub.go handleRevoke). */
  revoke: (clientId: string) => void
}

/**
 * Depot side of protocol.md §4, run as a background listener: registers
 * presence once, then handles as many concurrent reconnecting clients as
 * arrive, each independently, serving whatever the DepotSource exposes at
 * the moment a client asks (§5.7, §5.9).
 */
export async function runDepotReconnectListener(
  signalUrl: string,
  source: DepotSource,
  turn: TurnConfig | undefined,
  cb: DepotReconnectCallbacks,
): Promise<DepotReconnectListener> {
  const depotIdentity = await loadOrCreateIdentity('identity:depot')
  const depotId = toBase64(depotIdentity.publicKey)

  cb.onStatus('connecting to signal')
  const client = new SignalClient(signalUrl)
  await client.ready()

  // protocol.md §6 step 3 — "Any live DataChannel to that Client is closed
  // immediately" is the step that actually matters; signal-level REVOKE is
  // only the routing optimisation. Track live connections so revoke() can do it.
  const activeConnections = new Map<string, () => void>()
  const senders = new Map<string, RunningSender>()

  // Listening before registering. JavaScript cannot deliver a message
  // between two synchronous calls, so the other order was safe here by
  // accident — and the Android Depot, where it was not, lost the first
  // request after every registration. Written the safe way so that
  // neither side depends on how its runtime schedules a socket.
  const unsubscribe = client.onMessage((e) => {
    if (e.type === 'incoming' && e.clientId) {
      void handleIncoming(
        client, depotIdentity, e.clientId, e.payload, source, turn, activeConnections, senders, cb,
      )
    }
  })

  client.register(depotId)
  cb.onStatus('registered, listening for reconnections')
  cb.onRegistered(depotId)

  return {
    depotId,
    notifySharedChanged: () => {
      for (const sender of senders.values()) sender.notifyChanged()
    },
    stop: () => {
      unsubscribe()
      client.close()
      for (const close of activeConnections.values()) close()
      activeConnections.clear()
      senders.clear()
    },
    revoke: (clientId: string) => {
      client.revoke(clientId)
      activeConnections.get(clientId)?.()
      activeConnections.delete(clientId)
      senders.delete(clientId)
    },
  }
}

async function handleIncoming(
  client: SignalClient,
  depotIdentity: KeyPair,
  clientId: string,
  payload: unknown,
  source: DepotSource,
  turn: TurnConfig | undefined,
  activeConnections: Map<string, () => void>,
  senders: Map<string, RunningSender>,
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
    // A Client that reloads its tab comes back as the same ClientId on a
    // second connection. Replacing the entry without closing the first
    // one left the dead session's sender in the map, so §5.9 notices
    // went to a channel nobody was listening on and the live tab only
    // learned of a new file when it was reloaded again.
    activeConnections.get(clientId)?.()
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
    const sender = await runFileSender(channels, { kC2D: keys.kC2D, kD2C: keys.kD2C }, source, onSenderEvent)
    senders.set(clientId, sender)
    const closeThis = () => {
      // Only if this connection is still the current one: a newer tab
      // may have taken the slot while this one was dying.
      if (senders.get(clientId) === sender) senders.delete(clientId)
      sender.stop()
      channels.close()
    }
    activeConnections.set(clientId, closeThis)
    // A Client that closes its laptop lid never says goodbye. Without
    // this the map keeps growing and every SHARED_CHANGED is also sent
    // to every session that has ever existed.
    channels.pc.addEventListener('connectionstatechange', () => {
      // 'disconnected' is deliberately not here: ICE reports it for a
      // blip that often recovers, and tearing the session down over one
      // is how a Client that was about to come back gets dropped.
      const state = channels.pc.connectionState
      if (state !== 'failed' && state !== 'closed') return
      if (activeConnections.get(clientId) === closeThis) activeConnections.delete(clientId)
      closeThis()
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // Tell the Client instead of letting it sit until its timeout. These
    // reasons only say whether a credential is still honoured, which the
    // outcome reveals anyway — a rejected peer learns nothing it could
    // not infer from never getting a challenge.
    client.relay(TypeRejected, { reason } satisfies RejectedPayload, clientId)
    cb.onClientRejected({ clientId, reason })
  }
}
