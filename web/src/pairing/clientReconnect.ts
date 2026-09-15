import { fromBase64, toBase64 } from '../crypto/codec'
import { deriveKeys, ecdh } from '../crypto/derive'
import { generateEphemeralKeyPair } from '../crypto/keys'
import { reconnectTranscript, signReconnectResponse } from '../crypto/reconnect'
import { loadOrCreateIdentity } from '../storage/identityStore'
import { getPairing } from '../storage/pairings'
import { SignalClient } from '../signal/client'
import { TypeError as SignalError } from '../signal/envelope'
import { negotiateAsOfferer, type TurnConfig } from '../transport/webrtc'
import { requestFile, type ReceiverEvent } from '../transport/transferSession'

export interface ClientReconnectCallbacks {
  onStatus: (status: string) => void
  onConnected: (info: { depotId: string }) => void
  onProgress: (info: { index: number; total: number }) => void
  onFileReceived: (file: { name: string; bytes: Uint8Array }) => void
  onError: (message: string) => void
}

interface ChallengePayload {
  depotEk: string
  challengeNonce: string
}

/**
 * Client side of protocol.md §4 and §5. Proves possession of
 * ClientIdentity's private key (§4), then negotiates a WebRTC data channel
 * over the same signal relay and requests whatever file the Depot is
 * offering (§5.7) — the transfer succeeding end to end is the proof that
 * everything from key derivation through frame decryption actually works.
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
    const challenge = await client.waitFor((e) => e.type === 'CHALLENGE' || e.type === SignalError, 15_000)
    if (challenge.type === SignalError) throw new Error(`reconnection rejected: ${challenge.reason}`)

    const { depotEk, challengeNonce } = challenge.payload as ChallengePayload
    const depotEkBytes = fromBase64(depotEk)
    const challengeNonceBytes = fromBase64(challengeNonce)

    const transcript = reconnectTranscript(ephemeral.publicKey, depotEkBytes, challengeNonceBytes)
    const sig = await signReconnectResponse(identity.privateKey, transcript)

    cb.onStatus('sending signed response')
    client.relay('RESPONSE', { sig })

    const ok = await client.waitFor((e) => e.type === 'SESSION_OK' || e.type === SignalError, 15_000)
    if (ok.type === SignalError) throw new Error(`reconnection rejected: ${ok.reason}`)

    const shared = await ecdh(ephemeral.privateKey, depotEkBytes)
    const keys = await deriveKeys(shared, transcript)

    cb.onStatus('negotiating data channel')
    const channels = await negotiateAsOfferer(client, turn)

    cb.onStatus('connected')
    cb.onConnected({ depotId })

    cb.onStatus('requesting file')
    const onReceiverEvent = (e: ReceiverEvent) => {
      if (e.type === 'manifest') cb.onStatus(`receiving ${e.total} chunk(s)`)
      if (e.type === 'chunk-received' && e.index !== undefined && e.total !== undefined) {
        cb.onProgress({ index: e.index, total: e.total })
      }
      if (e.type === 'chunk-invalid') cb.onStatus(`chunk ${e.index} failed verification, dropped`)
    }
    const file = await requestFile(channels, { kC2D: keys.kC2D, kD2C: keys.kD2C }, onReceiverEvent)

    cb.onStatus('file verified')
    cb.onFileReceived(file)
    channels.close()
  } catch (err) {
    cb.onError(err instanceof Error ? err.message : String(err))
  } finally {
    client?.close()
  }
}
