import { sodium } from './sodium'
import { fromBase64, toBase64 } from './codec'
import { buildTranscript } from './transcript'

/**
 * protocol.md §3.2's PAIR_RESPONSE carries a `sig` whose exact coverage the
 * spec leaves unstated. This implementation binds it to depotEk, sessionId
 * and nonce: it lets the Client automatically reject a Depot whose
 * DepotIdentity doesn't actually endorse the ephemeral key it just
 * presented — a defense-in-depth check independent of, and before, the
 * human SAS comparison that carries the real authentication weight against
 * a Signal-in-the-middle (§3.4).
 */
function pairResponseSigningBytes(depotEk: Uint8Array, sessionId: Uint8Array, nonce: Uint8Array): Uint8Array {
  return buildTranscript([depotEk, sessionId, nonce])
}

export async function signPairResponse(
  depotIdentityPrivate: Uint8Array,
  depotEk: Uint8Array,
  sessionId: Uint8Array,
  nonce: Uint8Array,
): Promise<string> {
  const s = await sodium()
  const bytes = pairResponseSigningBytes(depotEk, sessionId, nonce)
  return toBase64(s.crypto_sign_detached(bytes, depotIdentityPrivate))
}

export async function verifyPairResponse(
  sigB64: string,
  depotIk: Uint8Array,
  depotEk: Uint8Array,
  sessionId: Uint8Array,
  nonce: Uint8Array,
): Promise<boolean> {
  const s = await sodium()
  const bytes = pairResponseSigningBytes(depotEk, sessionId, nonce)
  try {
    return s.crypto_sign_verify_detached(fromBase64(sigB64), bytes, depotIk)
  } catch {
    return false
  }
}
