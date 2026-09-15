import { sodium } from './sodium'
import { fromBase64, toBase64 } from './codec'
import { buildTranscript, utf8 } from './transcript'

/** protocol.md §3.6. sig is base64 Ed25519 signature by DepotIdentity. */
export interface Credential {
  depotId: string
  clientId: string
  issuedAt: number
  expiresAt: number
  sig: string
}

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setBigUint64(0, BigInt(Math.trunc(n)))
  return out
}

/** Canonical bytes the signature covers — everything but sig itself. */
function signingBytes(depotId: string, clientId: string, issuedAt: number, expiresAt: number): Uint8Array {
  return buildTranscript([utf8(depotId), utf8(clientId), u64be(issuedAt), u64be(expiresAt)])
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

/** Depot side: issue a credential for a newly (or already) paired client. */
export async function issueCredential(
  depotIdentityPrivate: Uint8Array,
  depotId: string,
  clientId: string,
  now: number = Date.now(),
): Promise<Credential> {
  const s = await sodium()
  const issuedAt = now
  const expiresAt = now + NINETY_DAYS_MS
  const sig = s.crypto_sign_detached(signingBytes(depotId, clientId, issuedAt, expiresAt), depotIdentityPrivate)
  return { depotId, clientId, issuedAt, expiresAt, sig: toBase64(sig) }
}

/** Client side (and Depot re-verifying on reconnect): checks signature + expiry only. */
export async function verifyCredential(
  cred: Credential,
  depotIdentityPublic: Uint8Array,
  now: number = Date.now(),
): Promise<boolean> {
  if (now >= cred.expiresAt) return false
  const s = await sodium()
  const bytes = signingBytes(cred.depotId, cred.clientId, cred.issuedAt, cred.expiresAt)
  try {
    return s.crypto_sign_verify_detached(fromBase64(cred.sig), bytes, depotIdentityPublic)
  } catch {
    return false
  }
}
