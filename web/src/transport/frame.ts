import { sodium } from '../crypto/sodium'

/** protocol.md §5.3 binary frame: type(1B) transferId(4B) chunkIdx(4B) flags(1B) ciphertext. */

/** Frame type byte. Only CHUNK exists today; the byte leaves room to add frame kinds later without breaking the format. */
export const FrameType = {
  Chunk: 1,
} as const

export const FLAG_COMPRESSED = 0b1

/** protocol.md §3.3 direction byte — which derived key a frame is encrypted with. */
export const Direction = {
  ClientToDepot: 0,
  DepotToClient: 1,
} as const
export type DirectionByte = (typeof Direction)[keyof typeof Direction]

const HEADER_LEN = 1 + 4 + 4 + 1

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
}

/** No nonce is transmitted — both sides derive it (protocol.md §5.3). */
export async function deriveChunkNonce(direction: DirectionByte, transferId: number, chunkIndex: number): Promise<Uint8Array> {
  const s = await sodium()
  const nonce = new Uint8Array(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES) // 24 bytes
  nonce[0] = direction
  nonce.set(u32be(transferId), 1)
  nonce.set(u32be(chunkIndex), 5)
  // remaining 15 bytes stay zero
  return nonce
}

export interface EncodedChunk {
  transferId: number
  chunkIndex: number
  plaintext: Uint8Array
  compressed: boolean
}

/** Encrypts one chunk and packs it into the §5.3 wire frame. */
export async function encodeChunkFrame(key: Uint8Array, direction: DirectionByte, chunk: EncodedChunk): Promise<Uint8Array> {
  const s = await sodium()
  const nonce = await deriveChunkNonce(direction, chunk.transferId, chunk.chunkIndex)
  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(chunk.plaintext, null, null, nonce, key)

  const frame = new Uint8Array(HEADER_LEN + ciphertext.length)
  frame[0] = FrameType.Chunk
  frame.set(u32be(chunk.transferId), 1)
  frame.set(u32be(chunk.chunkIndex), 5)
  frame[9] = chunk.compressed ? FLAG_COMPRESSED : 0
  frame.set(ciphertext, HEADER_LEN)
  return frame
}

export interface DecodedChunk {
  transferId: number
  chunkIndex: number
  compressed: boolean
  plaintext: Uint8Array
}

export async function decodeChunkFrame(key: Uint8Array, direction: DirectionByte, frame: Uint8Array): Promise<DecodedChunk> {
  if (frame.length < HEADER_LEN) throw new Error('frame shorter than header')
  const type = frame[0]
  if (type !== FrameType.Chunk) throw new Error(`unknown frame type ${type}`)
  const transferId = readU32be(frame, 1)
  const chunkIndex = readU32be(frame, 5)
  const compressed = (frame[9] & FLAG_COMPRESSED) !== 0
  const ciphertext = frame.subarray(HEADER_LEN)

  const s = await sodium()
  const nonce = await deriveChunkNonce(direction, transferId, chunkIndex)
  const plaintext = s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, null, nonce, key)

  return { transferId, chunkIndex, compressed, plaintext }
}
