import type { KeyPair } from '../crypto/keys'
import { generateIdentityKeyPair } from '../crypto/keys'
import { idbGet, idbSet } from './idb'

/**
 * ClientIdentity (protocol.md §2.1): generated on first visit, stored in
 * IndexedDB. Clearing browser storage destroys it and forces re-pairing —
 * intended behaviour, not a bug.
 *
 * The Depot simulator reuses the same shape for its own long-term identity,
 * under a different key, so the two roles can run in separate tabs of the
 * same origin without colliding.
 */
export async function loadOrCreateIdentity(storageKey: 'identity:client' | 'identity:depot'): Promise<KeyPair> {
  const existing = await idbGet<KeyPair>(storageKey)
  if (existing) return existing
  const created = await generateIdentityKeyPair()
  await idbSet(storageKey, created)
  return created
}
