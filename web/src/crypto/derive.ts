import { sodium } from './sodium'
import { buildTranscript, u8, utf8 } from './transcript'

export interface PairingTranscriptInput {
  version: number
  sessionId: Uint8Array
  clientEk: Uint8Array
  clientIk: Uint8Array
  depotEk: Uint8Array
  depotIk: Uint8Array
  nonce: Uint8Array
}

export interface DerivedKeys {
  master: Uint8Array
  kC2D: Uint8Array
  kD2C: Uint8Array
  sasSeed: Uint8Array
}

/** protocol.md §3.3 transcript, both sides must build the identical bytes. */
export function pairingTranscript(input: PairingTranscriptInput): Uint8Array {
  return buildTranscript([
    u8(input.version),
    input.sessionId,
    input.clientEk,
    input.clientIk,
    input.depotEk,
    input.depotIk,
    input.nonce,
  ])
}

/**
 * X25519(ownEphemeralPrivate, peerEphemeralPublic) — raw Diffie-Hellman.
 * libsodium's crypto_box keypair is X25519, so crypto_scalarmult on those
 * raw keys is exactly this operation.
 */
export async function ecdh(ownPrivate: Uint8Array, peerPublic: Uint8Array): Promise<Uint8Array> {
  const s = await sodium()
  return s.crypto_scalarmult(ownPrivate, peerPublic)
}

/** protocol.md §3.3: master + directional keys + SAS seed, all BLAKE2b. */
export async function deriveKeys(shared: Uint8Array, transcript: Uint8Array): Promise<DerivedKeys> {
  const s = await sodium()
  const master = s.crypto_generichash(32, transcript, shared)
  const kC2D = s.crypto_generichash(32, utf8('depot/v1/c2d'), master)
  const kD2C = s.crypto_generichash(32, utf8('depot/v1/d2c'), master)
  const sasSeed = s.crypto_generichash(8, utf8('depot/v1/sas'), master)
  return { master, kC2D, kD2C, sasSeed }
}

/** protocol.md §3.4: decimal(SAS_seed mod 10000), zero-padded to 4 digits. */
export function computeSAS(sasSeed: Uint8Array): string {
  let n = 0n
  for (const byte of sasSeed) n = (n << 8n) | BigInt(byte)
  const sas = n % 10000n
  return sas.toString().padStart(4, '0')
}
