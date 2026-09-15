import type { Credential } from '../crypto/credential'
import { idbGet, idbSet } from './idb'

/** Client side: one entry per Depot this browser profile has paired with. */
export interface Pairing {
  depotId: string // base64 DepotIdentity public key
  depotLabel: string
  credential: Credential
  pairedAt: number
}

const KEY = 'client:pairings'

export async function listPairings(): Promise<Pairing[]> {
  return (await idbGet<Pairing[]>(KEY)) ?? []
}

export async function savePairing(pairing: Pairing): Promise<void> {
  const pairings = await listPairings()
  const next = pairings.filter((p) => p.depotId !== pairing.depotId)
  next.push(pairing)
  await idbSet(KEY, next)
}

export async function getPairing(depotId: string): Promise<Pairing | undefined> {
  return (await listPairings()).find((p) => p.depotId === depotId)
}
