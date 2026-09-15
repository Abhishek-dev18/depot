import QRCode from 'qrcode'
import { fromBase64, toBase64 } from '../crypto/codec'
import { verifyCredential } from '../crypto/credential'
import { computeSAS, deriveKeys, ecdh, pairingTranscript } from '../crypto/derive'
import { generateEphemeralKeyPair, randomBytes } from '../crypto/keys'
import { verifyPairResponse } from '../crypto/pairResponse'
import { savePairing, type Pairing } from '../storage/pairings'
import { loadOrCreateIdentity } from '../storage/identityStore'
import { SignalClient } from '../signal/client'
import { TypeError as SignalError, TypePeerJoined, TypePeerLeft, TypeSessionCreated } from '../signal/envelope'
import { PAIRING_QR_TTL_MS, PROTOCOL_VERSION, type PairConfirmPayload, type PairResponsePayload, type QRPayload } from './types'

export interface ClientPairingCallbacks {
  onStatus: (status: string) => void
  onQrReady: (payload: QRPayload, dataUrl: string) => void
  onSas: (sas: string) => void
  onPaired: (pairing: Pairing) => void
  onError: (message: string) => void
}

/** Client side of protocol.md §3.2. Runs until paired, errored, or the QR expires. */
export async function runClientPairing(signalUrl: string, cb: ClientPairingCallbacks): Promise<void> {
  let client: SignalClient | undefined
  try {
    cb.onStatus('generating keys')
    const identity = await loadOrCreateIdentity('identity:client')
    const ephemeral = await generateEphemeralKeyPair()
    const sessionId = await randomBytes(16)
    const nonce = await randomBytes(16)

    cb.onStatus('connecting to signal')
    client = new SignalClient(signalUrl)
    await client.ready()

    const sessionIdB64 = toBase64(sessionId)
    client.hello(sessionIdB64)
    const helloAck = await client.waitFor((e) => e.type === TypeSessionCreated || e.type === SignalError, 10_000)
    if (helloAck.type === SignalError) throw new Error(`signal rejected hello: ${helloAck.reason}`)

    const qr: QRPayload = {
      v: PROTOCOL_VERSION,
      s: signalUrl,
      id: sessionIdB64,
      ek: toBase64(ephemeral.publicKey),
      ik: toBase64(identity.publicKey),
      n: toBase64(nonce),
    }
    const dataUrl = await QRCode.toDataURL(JSON.stringify(qr), { margin: 1, width: 280 })
    cb.onQrReady(qr, dataUrl)
    cb.onStatus('waiting for Depot to scan')

    const expiry = setTimeout(() => {
      client?.close()
    }, PAIRING_QR_TTL_MS)

    const joined = await client.waitFor(
      (e) => e.type === TypePeerJoined || e.type === SignalError,
      PAIRING_QR_TTL_MS + 5_000,
    )
    clearTimeout(expiry)
    if (joined.type === SignalError) throw new Error(`pairing session ended: ${joined.reason}`)

    cb.onStatus('Depot joined, awaiting its response')
    const response = await client.waitFor(
      (e) => e.type === 'PAIR_RESPONSE' || e.type === SignalError || e.type === TypePeerLeft,
      15_000,
    )
    if (response.type !== 'PAIR_RESPONSE') throw new Error('Depot disconnected before responding')

    const { depotEk, depotIk, sig } = response.payload as PairResponsePayload
    const depotEkBytes = fromBase64(depotEk)
    const depotIkBytes = fromBase64(depotIk)

    const sigOk = await verifyPairResponse(sig, depotIkBytes, depotEkBytes, sessionId, nonce)
    if (!sigOk) throw new Error('Depot response signature invalid — refusing to proceed')

    const shared = await ecdh(ephemeral.privateKey, depotEkBytes)
    const transcript = pairingTranscript({
      version: PROTOCOL_VERSION,
      sessionId,
      clientEk: ephemeral.publicKey,
      clientIk: identity.publicKey,
      depotEk: depotEkBytes,
      depotIk: depotIkBytes,
      nonce,
    })
    const keys = await deriveKeys(shared, transcript)
    const sas = computeSAS(keys.sasSeed)
    cb.onSas(sas)
    cb.onStatus('compare this code with the Depot, then approve there')

    const confirm = await client.waitFor(
      (e) => e.type === 'PAIR_CONFIRM' || e.type === SignalError || e.type === TypePeerLeft,
      5 * 60_000,
    )
    if (confirm.type !== 'PAIR_CONFIRM') throw new Error('pairing was not approved on the Depot')

    const { credential } = confirm.payload as PairConfirmPayload
    const credOk = await verifyCredential(credential, depotIkBytes)
    if (!credOk) throw new Error('credential signature invalid — refusing to store it')

    const pairing: Pairing = {
      depotId: depotIk,
      depotLabel: 'Depot',
      credential,
      pairedAt: Date.now(),
    }
    await savePairing(pairing)
    cb.onStatus('paired')
    cb.onPaired(pairing)
  } catch (err) {
    cb.onError(err instanceof Error ? err.message : String(err))
  } finally {
    client?.close()
  }
}
