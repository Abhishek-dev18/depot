import { sodium } from './sodium'
import { toBase64 } from './codec'
import { buildTranscript, utf8 } from './transcript'

/**
 * protocol.md §7.1: a Depot registers by signing a nonce Signal hands it,
 * with the DepotIdentity its depotId names. Knowing a depotId is not the
 * same as being that Depot — every Client ever paired with it knows it.
 *
 * The label keeps these bytes apart from everything else DepotIdentity
 * signs. signal/register.go builds the same bytes; TestRegisterSigningBytes
 * there pins them.
 */
const REGISTER_LABEL = 'depot-signal-register/v1'

export function registerSigningBytes(depotId: string, nonce: Uint8Array): Uint8Array {
  return buildTranscript([utf8(REGISTER_LABEL), utf8(depotId), nonce])
}

export async function signRegistration(
  depotIdentityPrivate: Uint8Array,
  depotId: string,
  nonce: Uint8Array,
): Promise<string> {
  const s = await sodium()
  return toBase64(s.crypto_sign_detached(registerSigningBytes(depotId, nonce), depotIdentityPrivate))
}
