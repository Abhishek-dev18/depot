import { idbDelete, idbDeleteMany, idbGet, idbKeysWithPrefix, idbSetMany } from './idb'
import { clearChunkCache } from './chunkCache'

/**
 * Files that already came across, kept so a reload does not throw them
 * away.
 *
 * This is a deliberate reversal. chunkCache.ts drops a file's chunks the
 * moment it is assembled, on the grounds that keeping delivered contents
 * in a browser database is a liability for a tool whose whole claim is
 * that files stay on the phone. That argument still holds — what has
 * changed is the alternative: without this, closing a tab means fetching
 * the same photograph over the phone's data again, and the user paying
 * that repeatedly is a real cost against a hypothetical one.
 *
 * So the bargain is made explicit rather than assumed:
 *
 *  - only small files, since a cached video is a large amount of someone
 *    else's data sitting in a browser profile for no proportionate gain;
 *  - a bounded total, oldest evicted first;
 *  - and Settings shows what is held, with one button to drop it all.
 *
 * Anyone who wants the old behaviour clears it, or uses a private window.
 */

const PREFIX = 'file:'

/**
 * Above this, a file is delivered and forgotten. Photos fit; videos do
 * not, which is the intended line.
 *
 * Decimal, like every other figure the product shows (see format.ts), so
 * Settings reads "25.0 MB" rather than the 26.2 MB that a binary
 * megabyte turns into on the way to the screen.
 */
export const MAX_CACHED_FILE = 25_000_000

/** The whole cache. Past it, the least recently received are dropped. */
export const MAX_CACHE_TOTAL = 200_000_000

export interface CachedFile {
  /** Content identity from the listing — see keyFor. */
  key: string
  name: string
  size: number
  modifiedAt?: number
  mime?: string
  blob: Blob
  receivedAt: number
}

/**
 * What identifies a file across sessions.
 *
 * Not the §5.9 handle: those are minted per session and mean nothing
 * after a reload. Name, length and modification time are what a listing
 * carries, so they are what a Client can match against before it has
 * asked for anything. Where the Depot reports no size and no timestamp
 * there is nothing to tell two versions apart, which is why the preview
 * offers an explicit "fetch again".
 */
export function keyFor(file: { name: string; size?: number; modifiedAt?: number }): string {
  return `${file.size ?? '?'}:${file.modifiedAt ?? '?'}:${file.name}`
}

const storeKey = (key: string) => `${PREFIX}${key}`

/**
 * IndexedDB is not always there — a private window, blocked site data, a
 * test environment. None of those should break a transfer, so the cache
 * falls back to memory, which still saves a second fetch within a page
 * but not across a reload.
 */
let backend: 'idb' | 'memory' | null = null
const memory = new Map<string, CachedFile>()

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

export async function getCachedFile(key: string): Promise<CachedFile | undefined> {
  try {
    if (!(await usingIdb())) return memory.get(key)
    return await idbGet<CachedFile>(storeKey(key))
  } catch {
    return undefined
  }
}

/** Everything held, newest first. */
export async function listCachedFiles(): Promise<CachedFile[]> {
  try {
    if (!(await usingIdb())) {
      return [...memory.values()].sort((a, b) => b.receivedAt - a.receivedAt)
    }
    const keys = await idbKeysWithPrefix(PREFIX)
    const records = await Promise.all(keys.map((k) => idbGet<CachedFile>(k)))
    return records
      .filter((r): r is CachedFile => r !== undefined)
      .sort((a, b) => b.receivedAt - a.receivedAt)
  } catch {
    return []
  }
}

/**
 * Keeps a file if it is small enough, evicting older ones to make room.
 *
 * Returns whether it was kept, so the caller can say so rather than
 * implying a file will survive a reload when it will not.
 */
export async function putCachedFile(file: CachedFile): Promise<boolean> {
  if (file.size > MAX_CACHED_FILE) return false
  try {
    if (!(await usingIdb())) {
      memory.set(file.key, file)
      return true
    }
    await idbSetMany([[storeKey(file.key), file]])
    await evictDownTo(MAX_CACHE_TOTAL)
    // Eviction may have taken this one straight back out — it is the
    // newest, so only if it alone exceeds the budget.
    return (await getCachedFile(file.key)) !== undefined
  } catch {
    // A quota error is not a failed transfer. The file is in hand either
    // way; it just will not be there after a reload.
    return false
  }
}

async function evictDownTo(budget: number): Promise<void> {
  const held = await listCachedFiles()
  let total = held.reduce((sum, f) => sum + f.size, 0)
  if (total <= budget) return
  // Oldest first, which is the order to give them up in.
  const doomed: string[] = []
  for (const file of [...held].reverse()) {
    if (total <= budget) break
    doomed.push(storeKey(file.key))
    total -= file.size
  }
  await idbDeleteMany(doomed)
}

export async function cacheUsage(): Promise<{ count: number; bytes: number }> {
  const held = await listCachedFiles()
  return { count: held.length, bytes: held.reduce((sum, f) => sum + f.size, 0) }
}

export async function clearFileCache(): Promise<void> {
  memory.clear()
  try {
    if (!(await usingIdb())) return
    await idbDeleteMany(await idbKeysWithPrefix(PREFIX))
  } catch {
    // Nothing to do — a cache that cannot be read cannot be cleared
    // either, and it is bounded regardless.
  }
}

/** Forgets one file, so a reload does not bring it back. */
export async function deleteCachedFile(key: string): Promise<void> {
  memory.delete(key)
  try {
    if (await usingIdb()) await idbDelete(storeKey(key))
  } catch {
    // Unreadable storage holds nothing that could come back.
  }
}

/**
 * Everything this browser holds for Depot, not only the whole files: the
 * chunks an interrupted download left behind to resume from are file
 * contents too, and "clear the cache" that left them would be a promise
 * half kept.
 */
export async function clearAllCached(): Promise<void> {
  await clearFileCache()
  await clearChunkCache()
  // Whatever is showing these files is told, so it does not go on
  // listing copies a reload will not bring back.
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CACHE_CLEARED_EVENT))
}

export const CACHE_CLEARED_EVENT = 'depot:cache-cleared'

/** Tests share a module registry; this puts the backend choice back. */
export function resetFileCacheForTests(): void {
  backend = null
  memory.clear()
}
