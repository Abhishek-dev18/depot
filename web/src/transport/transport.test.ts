import { describe, expect, it } from 'vitest'
import { randomBytes } from '../crypto/keys'
import { chunkLengths, DEFAULT_CDC_PARAMS } from './chunker'
import { compress, decompress, estimateEntropy, shouldCompress } from './compression'
import { Direction, decodeChunkFrame, encodeChunkFrame } from './frame'
import { buildManifest, hashBytes } from './manifest'

function randomBytesSync(n: number, seed = 1): Uint8Array {
  // deterministic PRNG so tests are reproducible without touching libsodium
  let a = seed >>> 0
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    out[i] = (t ^ (t >>> 14)) & 0xff
  }
  return out
}

describe('content-defined chunking (protocol.md §5.7)', () => {
  it('splits a large buffer within the configured min/max bounds', () => {
    const bytes = randomBytesSync(2 * 1024 * 1024, 42)
    const lengths = chunkLengths(bytes, DEFAULT_CDC_PARAMS)
    const total = lengths.reduce((a, b) => a + b, 0)
    expect(total).toBe(bytes.length)
    for (const len of lengths.slice(0, -1)) {
      // every chunk but the last must respect min/max; the last may be shorter (end of stream)
      expect(len).toBeGreaterThanOrEqual(DEFAULT_CDC_PARAMS.minSize)
      expect(len).toBeLessThanOrEqual(DEFAULT_CDC_PARAMS.maxSize)
    }
  })

  it('is deterministic for the same bytes', () => {
    const bytes = randomBytesSync(512 * 1024, 7)
    const a = chunkLengths(bytes, DEFAULT_CDC_PARAMS)
    const b = chunkLengths(bytes, DEFAULT_CDC_PARAMS)
    expect(a).toEqual(b)
  })

  it('an insertion only perturbs chunks near it — most chunk boundaries elsewhere survive', () => {
    const original = randomBytesSync(1024 * 1024, 99)
    const insertPoint = 400_000
    const insertion = randomBytesSync(777, 123)
    const modified = new Uint8Array(original.length + insertion.length)
    modified.set(original.subarray(0, insertPoint), 0)
    modified.set(insertion, insertPoint)
    modified.set(original.subarray(insertPoint), insertPoint + insertion.length)

    const originalLengths = chunkLengths(original, DEFAULT_CDC_PARAMS)
    const modifiedLengths = chunkLengths(modified, DEFAULT_CDC_PARAMS)

    // Reconstruct each chunking's boundary offsets and hash each chunk's
    // content (not just its length) so we can compare chunk *sets*.
    const chunkHashes = (bytes: Uint8Array, lengths: number[]) => {
      const hashes: string[] = []
      let offset = 0
      for (const len of lengths) {
        hashes.push(Array.from(bytes.subarray(offset, offset + len)).join(','))
        offset += len
      }
      return hashes
    }
    const originalHashes = new Set(chunkHashes(original, originalLengths))
    const modifiedHashes = chunkHashes(modified, modifiedLengths)
    const survived = modifiedHashes.filter((h) => originalHashes.has(h)).length

    // With a fixed-offset scheme, an insertion shifts every subsequent
    // chunk and nothing after the insertion point would survive. CDC
    // re-syncs, so most chunks well past the insertion point should be
    // byte-identical to their originals.
    expect(survived).toBeGreaterThan(originalLengths.length * 0.5)
  })
})

describe('manifest (protocol.md §5.7)', () => {
  it('builds a manifest whose chunk hashes verify against the source bytes', async () => {
    const bytes = randomBytesSync(300_000, 5)
    const manifest = await buildManifest(1, 'test.bin', bytes)
    expect(manifest.size).toBe(bytes.length)

    for (const info of manifest.chunks) {
      const slice = bytes.subarray(info.offset, info.offset + info.length)
      expect(await hashBytes(slice)).toBe(info.hash)
    }
    expect(await hashBytes(bytes)).toBe(manifest.fileHash)
  })
})

describe('binary frame + derived nonce (protocol.md §5.3)', () => {
  it('round-trips through encode/decode with the matching direction and key', async () => {
    const key = await randomBytes(32) // stands in for a derived session key
    const plaintext = randomBytesSync(1024, 3)

    const frame = await encodeChunkFrame(key, Direction.DepotToClient, {
      transferId: 7,
      chunkIndex: 2,
      plaintext,
      compressed: false,
    })
    const decoded = await decodeChunkFrame(key, Direction.DepotToClient, frame)

    expect(decoded.transferId).toBe(7)
    expect(decoded.chunkIndex).toBe(2)
    expect(decoded.compressed).toBe(false)
    expect(Array.from(decoded.plaintext)).toEqual(Array.from(plaintext))
  })

  it('fails to decode with the wrong direction (wrong derived nonce)', async () => {
    const key = await randomBytes(32)
    const frame = await encodeChunkFrame(key, Direction.ClientToDepot, {
      transferId: 1,
      chunkIndex: 0,
      plaintext: randomBytesSync(64, 9),
      compressed: false,
    })
    await expect(decodeChunkFrame(key, Direction.DepotToClient, frame)).rejects.toBeTruthy()
  })

  it('fails to decode a corrupted ciphertext', async () => {
    const key = await randomBytes(32)
    const frame = await encodeChunkFrame(key, Direction.ClientToDepot, {
      transferId: 1,
      chunkIndex: 0,
      plaintext: randomBytesSync(64, 11),
      compressed: false,
    })
    const corrupted = new Uint8Array(frame)
    corrupted[corrupted.length - 1] ^= 0xff
    await expect(decodeChunkFrame(key, Direction.ClientToDepot, corrupted)).rejects.toBeTruthy()
  })
})

describe('compression (protocol.md §5.6)', () => {
  it('round-trips compressible data and shrinks it', async () => {
    const text = 'the quick brown fox jumps over the lazy dog. '.repeat(2000)
    const bytes = new TextEncoder().encode(text)
    expect(shouldCompress(bytes)).toBe(true)

    const packed = await compress(bytes)
    expect(packed.length).toBeLessThan(bytes.length)

    const restored = await decompress(packed)
    expect(new TextDecoder().decode(restored)).toBe(text)
  })

  it('flags high-entropy (random) data as not worth compressing', async () => {
    const random = await randomBytes(64 * 1024)
    expect(shouldCompress(random)).toBe(false)
    expect(estimateEntropy(random)).toBeGreaterThan(7.9)
  })
})
