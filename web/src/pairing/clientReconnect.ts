import { aeadDecrypt, aeadEncrypt } from '../crypto/aead'
import { fromBase64, toBase64 } from '../crypto/codec'
import { deriveKeys, ecdh } from '../crypto/derive'
import { generateEphemeralKeyPair } from '../crypto/keys'
import { reconnectTranscript, signReconnectResponse } from '../crypto/reconnect'
import { loadOrCreateIdentity } from '../storage/identityStore'
import { getPairing } from '../storage/pairings'
import { SignalClient } from '../signal/client'
import { TypeError as SignalError } from '../signal/envelope'

export interface ClientReconnectCallbacks {
  onStatus: (status: string) => void
  onConnected: (info: { depotId: string; pingRoundtripOk: boolean }) => void
  onError: (message: string) => void
}

interface ChallengePayload {
  depotEk: string
  challengeNonce: string
}

/** Client side of protocol.md §4. Proves possession of ClientIdentity's private key without repeating §3's QR flow. */
export async function runClientReconnect(signalUrl: string, depotId: string, cb: ClientReconnectCallbacks): Promise<void> {
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

    // Not a security check — SESSION_OK already means the Depot verified the
    // signature. This only proves both sides derived the same session keys.
    const shared = await ecdh(ephemeral.privateKey, depotEkBytes)
    const keys = await deriveKeys(shared, transcript)
    let pingRoundtripOk = false
    try {
      const ping = await client.waitFor((e) => e.type === 'PING' || e.type === SignalError, 10_000)
      if (ping.type === 'PING') {
        const { nonce, ciphertext } = ping.payload as { nonce: string; ciphertext: string }
        const opened = await aeadDecrypt(keys.kD2C, fromBase64(nonce), fromBase64(ciphertext))
        const { nonce: pongNonce, ciphertext: pongCiphertext } = await aeadEncrypt(keys.kC2D, opened)
        client.relay('PONG', { nonce: toBase64(pongNonce), ciphertext: toBase64(pongCiphertext) })
        pingRoundtripOk = true
      }
    } catch {
      // Ping/pong is a demo confirmation only; its absence doesn't fail reconnection.
    }

    cb.onStatus('connected')
    cb.onConnected({ depotId, pingRoundtripOk })
  } catch (err) {
    cb.onError(err instanceof Error ? err.message : String(err))
  } finally {
    client?.close()
  }
}
