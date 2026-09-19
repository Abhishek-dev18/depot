import { idbDeleteMany, idbGet, idbKeysWithPrefix, idbSetMany } from './idb'

/**
 * Chunks held between connection attempts, so a dropped transfer resumes
 * instead of starting over (protocol.md §5.7 step 3).
 *
 * Keyed by the chunk's own BLAKE2b hash rather than by file and index.
 * That is what §5.7's content-defined chunking is for: a cached chunk is
 * valid for any manifest that names it, so inserting bytes into a file
 * only invalidates the chunks near the insertion.
 *
 * Nothing survives a completed transfer. Once a file has been reassembled
 * and handed over, its chunks are dropped — keeping delivered file
 * contents sitting in a browser database would be a privacy liability for
 * a tool whose whole claim is that files stay on the phone, and the point
 * here is resumption, not a cache.
 */
const PREFIX = 'chunk:'

const key = (hash: string) => `${PREFIX}${hash}`

/**
 * IndexedDB is not always there. A private window, blocked site data, or
 * a test environment can all leave it missing or throwing, and none of
 * those are a reason to fail a transfer — resumption is an optimisation,
 * not a requirement. When it is unavailable the cache lives in memory
 * instead, which still resumes within a page but not across a reload.
 */
let backend: 'idb' | 'memory' | null = null
const memory = new Map<string, Uint8Array>()

async function usingIdb(): Promise<boolean> {
  if (backend === null) {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB in this context')
      await idbKeysWithPrefix(PREFIX)
      backend = 'idb'
    } catch {
      backend = 'memory'
    }
  }
  return backend === 'idb'
}

/** Which of these chunks this browser already holds. */
export async function cachedChunks(hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set()
  const held = (await usingIdb())
    ? new Set((await idbKeysWithPrefix(PREFIX)).map((k) => k.slice(PREFIX.length)))
    : new Set(memory.keys())
  return new Set(hashes.filter((h) => held.has(h)))
}

export async function getChunk(hash: string): Promise<Uint8Array | undefined> {
  return (await usingIdb()) ? idbGet<Uint8Array>(key(hash)) : memory.get(hash)
}

export async function putChunks(entries: Array<[string, Uint8Array]>): Promise<void> {
  if (entries.length === 0) return
  if (await usingIdb()) {
    await idbSetMany(entries.map(([hash, bytes]) => [key(hash), bytes] as [string, unknown]))
    return
  }
  for (const [hash, bytes] of entries) memory.set(hash, bytes)
}

export async function dropChunks(hashes: string[]): Promise<void> {
  if (hashes.length === 0) return
  if (await usingIdb()) {
    await idbDeleteMany(hashes.map(key))
    return
  }
  for (const hash of hashes) memory.delete(hash)
}

/** Test seam: forget which backend was chosen and empty the in-memory one. */
export function resetChunkCacheForTests(): void {
  backend = null
  memory.clear()
}
