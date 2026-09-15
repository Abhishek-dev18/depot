import { toBase64 } from '../crypto/codec'
import { sodium } from '../crypto/sodium'
import { chunkLengths, DEFAULT_CDC_PARAMS, type CdcParams } from './chunker'

export interface ChunkInfo {
  index: number
  offset: number
  length: number
  hash: string // base64 BLAKE2b-32
}

/** protocol.md §5.7 MANIFEST. */
export interface Manifest {
  transferId: number
  name: string
  size: number
  chunkCount: number
  chunks: ChunkInfo[]
  fileHash: string // base64 BLAKE2b-32 of the whole file
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const s = await sodium()
  return toBase64(s.crypto_generichash(32, bytes, null))
}

export async function buildManifest(
  transferId: number,
  name: string,
  bytes: Uint8Array,
  cdcParams: CdcParams = DEFAULT_CDC_PARAMS,
): Promise<Manifest> {
  const lengths = chunkLengths(bytes, cdcParams)
  const chunks: ChunkInfo[] = []
  let offset = 0
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index]
    const hash = await hashBytes(bytes.subarray(offset, offset + length))
    chunks.push({ index, offset, length, hash })
    offset += length
  }
  const fileHash = await hashBytes(bytes)
  return { transferId, name, size: bytes.length, chunkCount: chunks.length, chunks, fileHash }
}
