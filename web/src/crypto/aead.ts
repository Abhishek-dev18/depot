import { sodium } from './sodium'

/**
 * XChaCha20-Poly1305 (protocol.md §2), used here only to demonstrate that
 * the session keys derived in §4 reconnection are correct and usable on
 * both sides — a random nonce, not the derived-nonce chunk framing of
 * §5.3, which belongs to the (not yet implemented) file-transfer channel.
 */
export async function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }> {
  const s = await sodium()
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, null, null, nonce, key)
  return { nonce, ciphertext }
}

export async function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const s = await sodium()
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, null, nonce, key)
}
