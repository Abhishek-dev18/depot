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

/**
 * Above this, compressing costs more time than it saves.
 *
 * Compression is not free and it is not overlapped with sending: the
 * sender packs a chunk, then puts it on the wire, so whatever the codec
 * takes is added to the transfer rather than hidden behind it. Measured
 * on `deflate-raw` over 64 KB chunks of ordinary text, this
 * implementation compresses at about 22 MB/s and decompresses at about
 * 75 MB/s, for roughly a ninth of the original size.
 *
 * Put those in order — pack, send, unpack — and compressing wins only
 * while
 *
 *     1/compress + ratio/link + 1/decompress  <  1/link
 *
 * which rearranges to a link speed of about 120 Mbps. Below it the
 * saving is dramatic: on an 8 Mbps mobile link the same megabyte takes
 * 160 ms compressed against 1000 ms raw. Above it the codec becomes the
 * bottleneck instead of the network — on a fast LAN, compressing more
 * than doubles the time.
 *
 * Set well under the measured figure because the number that matters is
 * the *peer's* decompression speed, which cannot be known from here: a
 * slower phone moves the real break-even down, and guessing low only
 * ever costs a little bandwidth on a link that has it to spare.
 */
const COMPRESS_BELOW_BYTES_PER_SECOND = 8 * 1024 * 1024

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

/**
 * Whether packing this chunk is worth the time it takes.
 *
 * Two questions, cheapest first. Will it get smaller — §5.6's entropy
 * gate, which is what keeps photographs and video from being fed
 * pointlessly through a codec. And then: is the link slow enough for the
 * saving to be worth the delay, given [observedBytesPerSecond] if the
 * session has measured one yet.
 *
 * An unmeasured link compresses. Most links are far below the
 * threshold, and the first chunks of a transfer are precisely when there
 * is nothing to measure from.
 */
export function shouldCompress(
  bytes: Uint8Array,
  observedBytesPerSecond?: number,
  /**
   * Whether the peer pays for the bytes it receives (§5.4).
   *
   * It changes the question rather than the answer. The speed test above
   * asks which is cheaper, processor time or wire time; on a connection
   * billed by the byte that is the wrong comparison, because the wire
   * costs money as well as time and the processor does not. So a metered
   * peer compresses whatever the link measures.
   */
  peerIsMetered = false,
): boolean {
  if (
    !peerIsMetered &&
    observedBytesPerSecond !== undefined &&
    observedBytesPerSecond > COMPRESS_BELOW_BYTES_PER_SECOND
  ) {
    return false
  }
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

/**
 * Inflates one chunk, refusing to produce more than `maxBytes`.
 *
 * The limit is the chunk's length from the manifest, which is all a
 * genuine chunk can inflate to. Without it the hash check comes too late:
 * deflate reaches about 1000:1, so one 64 KB frame can demand 64 MB before
 * anything looks at it, and a few dozen in flight take a tab or a phone
 * down. Reading stops the moment the output passes the limit.
 */
export async function decompress(bytes: Uint8Array, maxBytes: number = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
  const stream = new DecompressionStream(COMPRESSION_FORMAT)
  const writer = stream.writable.getWriter()
  void writer.write(toArrayBufferView(bytes)).catch(() => {})
  void writer.close().catch(() => {})

  const reader = stream.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      void reader.cancel().catch(() => {})
      throw new Error(`chunk inflates past the ${maxBytes} bytes its manifest allows`)
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
