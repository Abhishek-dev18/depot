/**
 * protocol.md §5.6: sample the first 64KB of a chunk, estimate entropy, and
 * skip compression for high-entropy (already-compressed/encrypted/random)
 * data.
 *
 * The spec names zstd level 3. This implementation uses the browser's
 * native CompressionStream('deflate-raw') instead, to avoid adding a wasm
 * zstd codec as a build dependency — same entropy-gated decision, same
 * wire flag (frame.ts FLAG_COMPRESSED). Swapping in real zstd later
 * touches only this file.
 */

const COMPRESSION_FORMAT: CompressionFormat = 'deflate-raw'
const ENTROPY_SAMPLE_SIZE = 64 * 1024
const ENTROPY_THRESHOLD_BITS_PER_BYTE = 7.5

export function estimateEntropy(sample: Uint8Array): number {
  if (sample.length === 0) return 0
  const counts = new Uint32Array(256)
  for (const b of sample) counts[b]++
  let entropy = 0
  for (const c of counts) {
    if (c === 0) continue
    const p = c / sample.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

export function shouldCompress(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(ENTROPY_SAMPLE_SIZE, bytes.length))
  return estimateEntropy(sample) < ENTROPY_THRESHOLD_BITS_PER_BYTE
}

// TS's DOM lib types stream writers as wanting an ArrayBuffer-backed view
// specifically (not the wider ArrayBufferLike a subarray()/slice() carries);
// copying guarantees that without weakening the exported Uint8Array type.
function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

export async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream(COMPRESSION_FORMAT)
  const writer = stream.writable.getWriter()
  void writer.write(toArrayBufferView(bytes))
  void writer.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

export async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream(COMPRESSION_FORMAT)
  const writer = stream.writable.getWriter()
  void writer.write(toArrayBufferView(bytes))
  void writer.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}
