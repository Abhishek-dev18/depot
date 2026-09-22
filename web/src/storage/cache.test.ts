import { beforeEach, describe, expect, it } from 'vitest'
import { cachedChunks, putChunks, resetChunkCacheForTests } from './chunkCache'
import {
  CACHE_CLEARED_EVENT,
  cacheUsage,
  clearAllCached,
  deleteCachedFile,
  listCachedFiles,
  putCachedFile,
  resetFileCacheForTests,
} from './fileCache'

// No IndexedDB under jsdom, so both caches run on their in-memory
// fallback — the same code paths above the storage call.
describe('clearing what this browser holds', () => {
  beforeEach(() => {
    resetFileCacheForTests()
    resetChunkCacheForTests()
  })

  const file = (name: string) => ({
    key: `3:?:${name}`,
    name,
    size: 3,
    mime: 'text/plain',
    blob: new Blob(['abc']),
    receivedAt: Date.now(),
  })

  it('forgets one file and keeps the rest', async () => {
    await putCachedFile(file('a.txt'))
    await putCachedFile(file('b.txt'))
    await deleteCachedFile('3:?:a.txt')
    expect((await listCachedFiles()).map((f) => f.name)).toEqual(['b.txt'])
  })

  it('clears whole files and the chunks kept to resume, and says so', async () => {
    await putCachedFile(file('a.txt'))
    await putChunks([['h1', new Uint8Array([1])]])
    let announced = false
    const onCleared = () => {
      announced = true
    }
    window.addEventListener(CACHE_CLEARED_EVENT, onCleared)

    await clearAllCached()
    window.removeEventListener(CACHE_CLEARED_EVENT, onCleared)

    expect(await cacheUsage()).toEqual({ count: 0, bytes: 0 })
    expect(await cachedChunks(['h1'])).toEqual(new Set())
    expect(announced).toBe(true)
  })
})
