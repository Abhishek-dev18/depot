import { fromBase64, toBase64 } from '../crypto/codec'
import { issueCredential } from '../crypto/credential'
import { computeSAS, deriveKeys, ecdh, pairingTranscript } from '../crypto/derive'
import { generateEphemeralKeyPair } from '../crypto/keys'
import { signPairResponse } from '../crypto/pairResponse'
import { saveDevice, type DeviceRecord } from '../storage/devices'
import { loadOrCreateIdentity } from '../storage/identityStore'
import { SignalClient } from '../signal/client'
import { TypeError as SignalError, TypePeerJoined, TypePeerLeft } from '../signal/envelope'
import type { PairConfirmPayload, QRPayload } from './types'

export interface DepotPairingCallbacks {
  onStatus: (status: string) => void
  /** Called once the SAS is computed. Call approve() once the human confirms it matches. */
  onSas: (sas: string, approve: () => void) => void
  onPaired: (device: DeviceRecord) => void
  onError: (message: string) => void
}

/** Depot side of protocol.md §3.2 — what the Android app will eventually do, run here in the browser for testing. */
export async function runDepotPairing(qrPayloadRaw: string, cb: DepotPairingCallbacks): Promise<void> {
  let client: SignalClient | undefined
  try {
    let qr: QRPayload
    try {
      qr = JSON.parse(qrPayloadRaw) as QRPayload
    } catch {
      throw new Error('that is not valid QR payload JSON')
    }
    if (!qr.s || !qr.id || !qr.ek || !qr.ik || !qr.n) {
      throw new Error('QR payload is missing required fields')
    }

    cb.onStatus('loading Depot identity')
    const depotIdentity = await loadOrCreateIdentity('identity:depot')
    const depotEphemeral = await generateEphemeralKeyPair()

    cb.onStatus('connecting to signal')
    client = new SignalClient(qr.s)
    await client.ready()

    client.join(qr.id)
    const joined = await client.waitFor((e) => e.type === TypePeerJoined || e.type === SignalError, 15_000)
    if (joined.type === SignalError) throw new Error(`could not join pairing session: ${joined.reason}`)

    const sessionId = fromBase64(qr.id)
    const nonce = fromBase64(qr.n)
    const clientEk = fromBase64(qr.ek)
    const clientIk = fromBase64(qr.ik)

    cb.onStatus('sending pairing response')
    const sig = await signPairResponse(depotIdentity.privateKey, depotEphemeral.publicKey, sessionId, nonce)
    client.relay('PAIR_RESPONSE', {
      depotEk: toBase64(depotEphemeral.publicKey),
      depotIk: toBase64(depotIdentity.publicKey),
      sig,
    })

    const shared = await ecdh(depotEphemeral.privateKey, clientEk)
    const transcript = pairingTranscript({
      version: qr.v,
      sessionId,
      clientEk,
      clientIk,
      depotEk: depotEphemeral.publicKey,
      depotIk: depotIdentity.publicKey,
      nonce,
    })
    const keys = await deriveKeys(shared, transcript)
    const sas = computeSAS(keys.sasSeed)

    cb.onStatus('compare this code with the Client, then approve')
    const disconnected = client
      .waitFor((e) => e.type === TypePeerLeft || e.type === SignalError, 5 * 60_000)
      .then(() => true)
      .catch(() => true)
    let approve: () => void = () => {}
    const approved = new Promise<boolean>((resolve) => {
      approve = () => resolve(false) // false = "not disconnected"
    })
    cb.onSas(sas, approve)

    const gaveUp = await Promise.race([approved, disconnected])
    if (gaveUp) throw new Error('Client disconnected before pairing was approved')

    const clientIdB64 = toBase64(clientIk)
    const depotIdB64 = toBase64(depotIdentity.publicKey)
    cb.onStatus('issuing credential')
    const credential = await issueCredential(depotIdentity.privateKey, depotIdB64, clientIdB64)

    const device: DeviceRecord = {
      clientIdentityPub: clientIdB64,
      label: 'Paired client',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false,
    }
    await saveDevice(device)

    const confirmPayload: PairConfirmPayload = { credential }
    client.relay('PAIR_CONFIRM', confirmPayload)

    cb.onStatus('paired')
    cb.onPaired(device)
  } catch (err) {
    cb.onError(err instanceof Error ? err.message : String(err))
  } finally {
    client?.close()
  }
}
