import { sodium } from './sodium'

export interface KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

/** Ed25519 identity keypair — long-term, per protocol.md §2.1. */
export async function generateIdentityKeyPair(): Promise<KeyPair> {
  const s = await sodium()
  const kp = s.crypto_sign_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

/** X25519 ephemeral keypair — one pairing or one session, per protocol.md §2.1. */
export async function generateEphemeralKeyPair(): Promise<KeyPair> {
  const s = await sodium()
  const kp = s.crypto_box_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

export async function randomBytes(length: number): Promise<Uint8Array> {
  const s = await sodium()
  return s.randombytes_buf(length)
}
