import { fromBase64, toBase64 } from '../crypto/codec'
import type { Credential } from '../crypto/credential'
import { verifyCredential } from '../crypto/credential'
import { deriveKeys, ecdh } from '../crypto/derive'
import { generateEphemeralKeyPair } from '../crypto/keys'
import { reconnectTranscript, signReconnectResponse } from '../crypto/reconnect'
import { loadOrCreateIdentity } from '../storage/identityStore'
import { getPairing, savePairing } from '../storage/pairings'
import { SignalClient } from '../signal/client'
import { TypeError as SignalError } from '../signal/envelope'
import { TypeRejected, throwIfRejected } from './rejection'
import { negotiateAsOfferer, type ConnectionType, type TurnConfig } from '../transport/webrtc'
import { openClientSession, type ClientSession } from '../transport/transferSession'

export interface ClientReconnectCallbacks {
  onStatus: (status: string) => void
  onConnected: (info: { depotId: string; connectionType: ConnectionType }) => void
  /**
   * The session is open and can be browsed. Closing it tears down the
   * data channels and the signal connection with it.
   */
  onSession: (session: DepotConnection) => void
  onError: (message: string) => void
}

/** A live connection to a Depot: browse it, pull files from it, close it. */
export interface DepotConnection extends ClientSession {
  depotId: string
  connectionType: ConnectionType
}

interface ChallengePayload {
  depotEk: string
  challengeNonce: string
}

/**
 * Client side of protocol.md §4 and §5. Proves possession of
 * ClientIdentity's private key (§4), then negotiates a WebRTC data channel
 * over the same signal relay and hands back an open session the caller can
 * browse and pull files from (§5.7, §5.9).
 *
 * The signal connection is kept open for the life of that session rather
 * than closed on the way out: WebRTC renegotiation and any later ICE
 * candidates travel over it, and a Depot that revokes this Client mid-
 * session announces it there too.
 */
export async function runClientReconnect(
  signalUrl: string,
  depotId: string,
  turn: TurnConfig | undefined,
  cb: ClientReconnectCallbacks,
): Promise<void> {
  let client: SignalClient | undefined
  try {
    const pairing = await getPairing(depotId)
    if (!pairing) throw new Error('no stored pairing for this Depot — pair first')

    cb.onStatus('generating fresh ephemeral key')
    const identity = await loadOrCreateIdentity('identity:client')
    const ephemeral = await generateEphemeralKeyPair()
    const clientId = toBase64(identity.publicKey)

    cb.onStatus('connecting to signal')
    client = new SignalClient(signalUrl)
    await client.ready()

    client.connectTo(depotId, clientId, {
      credential: pairing.credential,
      clientEk: toBase64(ephemeral.publicKey),
    })

    cb.onStatus('awaiting challenge')
    const challenge = await client.waitFor(
      (e) => e.type === 'CHALLENGE' || e.type === TypeRejected || e.type === SignalError,
      15_000,
    )
    if (challenge.type === SignalError) throw new Error(`reconnection rejected: ${challenge.reason}`)
    throwIfRejected(challenge)

    const { depotEk, challengeNonce } = challenge.payload as ChallengePayload
    const depotEkBytes = fromBase64(depotEk)
    const challengeNonceBytes = fromBase64(challengeNonce)

    const transcript = reconnectTranscript(ephemeral.publicKey, depotEkBytes, challengeNonceBytes)
    const sig = await signReconnectResponse(identity.privateKey, transcript)

    cb.onStatus('sending signed response')
    client.relay('RESPONSE', { sig })

    const ok = await client.waitFor(
      (e) => e.type === 'SESSION_OK' || e.type === TypeRejected || e.type === SignalError,
      15_000,
    )
    if (ok.type === SignalError) throw new Error(`reconnection rejected: ${ok.reason}`)
    throwIfRejected(ok)

    // protocol.md §4.1: silent credential renewal — save it only if it
    // actually verifies against this Depot's identity, so a compromised
    // Signal can't slip in a forged "renewed" credential.
    const { credential: renewed } = (ok.payload ?? {}) as { credential?: Credential }
    if (renewed && (await verifyCredential(renewed, fromBase64(depotId)))) {
      await savePairing({ ...pairing, credential: renewed })
    }

    const shared = await ecdh(ephemeral.privateKey, depotEkBytes)
    const keys = await deriveKeys(shared, transcript)

    cb.onStatus('negotiating data channel')
    const channels = await negotiateAsOfferer(client, turn)

    cb.onStatus('connected')
    cb.onConnected({ depotId, connectionType: channels.connectionType })

    const session = await openClientSession(channels, { kC2D: keys.kC2D, kD2C: keys.kD2C })
    const signal = client
    let closed = false

    cb.onStatus('ready')
    cb.onSession({
      ...session,
      depotId,
      connectionType: channels.connectionType,
      close: () => {
        if (closed) return
        closed = true
        session.close()
        channels.close()
        signal.close()
      },
    })
  } catch (err) {
    cb.onError(err instanceof Error ? err.message : String(err))
    client?.close()
  }
}
