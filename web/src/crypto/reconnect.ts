import { sodium } from './sodium'
import { fromBase64, toBase64 } from './codec'
import { buildTranscript, utf8 } from './transcript'

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

/**
 * What the Depot signs in CHALLENGE, so the Client knows it is talking to
 * the Depot it paired with and not to whoever registered its id at Signal
 * (§4 step 2). Without it the Depot is never authenticated on reconnect:
 * the session keys come from two ephemeral keys and nothing else, so an
 * impostor could complete the handshake and collect what the user sends.
 *
 * The label keeps these bytes from ever being mistaken for the other
 * things DepotIdentity signs — a credential starts with a 43-byte depotId,
 * a PAIR_RESPONSE with a 32-byte key — and from the Client's own RESPONSE.
 */
const DEPOT_CHALLENGE_LABEL = 'depot-reconnect-challenge/v1'

export function depotChallengeBytes(clientEk: Uint8Array, depotEk: Uint8Array, challengeNonce: Uint8Array): Uint8Array {
  return buildTranscript([utf8(DEPOT_CHALLENGE_LABEL), clientEk, depotEk, challengeNonce])
}

/** Depot side: prove possession of DepotIdentity's private key. */
export async function signDepotChallenge(
  depotIdentityPrivate: Uint8Array,
  clientEk: Uint8Array,
  depotEk: Uint8Array,
  challengeNonce: Uint8Array,
): Promise<string> {
  const s = await sodium()
  const bytes = depotChallengeBytes(clientEk, depotEk, challengeNonce)
  return toBase64(s.crypto_sign_detached(bytes, depotIdentityPrivate))
}

/** Client side: check CHALLENGE against the depotId it paired with. */
export async function verifyDepotChallenge(
  signatureB64: string,
  depotIdentityPublic: Uint8Array,
  clientEk: Uint8Array,
  depotEk: Uint8Array,
  challengeNonce: Uint8Array,
): Promise<boolean> {
  const s = await sodium()
  try {
    const bytes = depotChallengeBytes(clientEk, depotEk, challengeNonce)
    return s.crypto_sign_verify_detached(fromBase64(signatureB64), bytes, depotIdentityPublic)
  } catch {
    return false
  }
}
