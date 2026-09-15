/**
 * Content-defined chunking (FastCDC-style, normalized level 1), per
 * protocol.md §5.7: chunk boundaries depend on local content, not fixed
 * offsets, so inserting bytes anywhere in a file only perturbs chunk
 * boundaries near the insertion — everything after re-syncs.
 *
 * A gear-hash table drives a rolling hash over the byte stream; a boundary
 * is declared where the hash satisfies a mask. Two masks are used —
 * stricter before the average size, looser after — to concentrate the
 * chunk-size distribution around avgSize instead of drifting toward
 * minSize or maxSize (this is what "normalized" means here).
 */

export interface CdcParams {
  minSize: number
  avgSize: number
  maxSize: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }
}

// Fixed seed: the table only needs to be well-distributed and identical
// across every run of this module, not secret or unpredictable.
const GEAR_SEED = 0x9e3779b9
const GEAR: Uint32Array = (() => {
  const rand = mulberry32(GEAR_SEED)
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) table[i] = rand()
  return table
})()

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function maskWithBits(bits: number): number {
  const n = clamp(Math.round(bits), 1, 30)
  return (1 << n) - 1
}

/** Finds the length of the next chunk at the start of `buffer` (which may extend beyond it). */
function findCutLength(buffer: Uint8Array, params: CdcParams): number {
  const { minSize, avgSize, maxSize } = params
  const n = buffer.length
  if (n <= minSize) return n
  const end = Math.min(n, maxSize)

  const avgBits = Math.log2(avgSize)
  const maskS = maskWithBits(avgBits + 2) // stricter: fewer boundaries before avgSize
  const maskL = maskWithBits(avgBits - 2) // looser: more boundaries after avgSize

  let hash = 0
  // Warm up over the mandatory minimum run so its bytes influence the hash too.
  for (let j = 0; j < minSize; j++) hash = ((hash << 1) + GEAR[buffer[j]]) >>> 0

  for (let i = minSize; i < end; i++) {
    hash = ((hash << 1) + GEAR[buffer[i]]) >>> 0
    const mask = i < avgSize ? maskS : maskL
    if ((hash & mask) === 0) return i + 1
  }
  return end
}

/** Splits bytes into content-defined chunks, returning each chunk's length in order. */
export function chunkLengths(bytes: Uint8Array, params: CdcParams): number[] {
  const lengths: number[] = []
  let offset = 0
  while (offset < bytes.length) {
    const remaining = bytes.subarray(offset)
    const length = findCutLength(remaining, params)
    lengths.push(length)
    offset += length
  }
  return lengths
}

export const DEFAULT_CDC_PARAMS: CdcParams = {
  minSize: 16 * 1024,
  avgSize: 64 * 1024,
  maxSize: 256 * 1024,
}
