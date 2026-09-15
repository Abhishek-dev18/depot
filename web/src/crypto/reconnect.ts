import { sodium } from './sodium'
import { fromBase64, toBase64 } from './codec'
import { buildTranscript } from './transcript'

/**
 * protocol.md §4 leaves the exact "fresh transcript" the RESPONSE signs
 * unspecified beyond "a nonce the Depot chose in this session" — this
 * implementation binds it to the Depot's fresh challenge nonce and both
 * sides' fresh ephemeral keys, so a captured signature cannot be replayed
 * against a different reconnection attempt or reflected back at whichever
 * side produced it.
 */
export function reconnectTranscript(clientEk: Uint8Array, depotEk: Uint8Array, challengeNonce: Uint8Array): Uint8Array {
  return buildTranscript([clientEk, depotEk, challengeNonce])
}

/** Client side: prove possession of ClientIdentity's private key. */
export async function signReconnectResponse(
  clientIdentityPrivate: Uint8Array,
  transcript: Uint8Array,
): Promise<string> {
  const s = await sodium()
  return toBase64(s.crypto_sign_detached(transcript, clientIdentityPrivate))
}

/** Depot side: step 4 of §4 — verify against the stored clientIdentityPub. */
export async function verifyReconnectResponse(
  signatureB64: string,
  transcript: Uint8Array,
  clientIdentityPublic: Uint8Array,
): Promise<boolean> {
  const s = await sodium()
  try {
    return s.crypto_sign_verify_detached(fromBase64(signatureB64), transcript, clientIdentityPublic)
  } catch {
    return false
  }
}
