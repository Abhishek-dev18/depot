import type { Credential } from '../crypto/credential'

/** protocol.md §3.1 — QR payload, all key material base64. */
export interface QRPayload {
  v: number
  s: string // signal server URL
  id: string // sessionId
  ek: string // clientEphemeralPublicKey
  ik: string // clientIdentityPublicKey
  n: string // nonce
}

export interface PairResponsePayload {
  depotEk: string
  depotIk: string
  sig: string
}

export interface PairConfirmPayload {
  credential: Credential
}

export const PROTOCOL_VERSION = 1
export const PAIRING_QR_TTL_MS = 120_000 // protocol.md §3.1
