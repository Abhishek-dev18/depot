import { beforeEach, describe, expect, it } from 'vitest'
import { putChunks, resetChunkCacheForTests } from '../storage/chunkCache'
import { buildManifest } from './manifest'
import { cdcParamsForAvg } from './chunkSize'
import {
  openClientSession,
  runFileSender,
  singleFileSource,
  type DepotSource,
  type OfferedFile,
  type SessionKeys,
} from './transferSession'
import type { DataChannels } from './webrtc'

/**
 * A DataChannel pair that just hands bytes to its twin.
 *
 * Enough to exercise everything above the wire — the ctl codec, CAPS,
 * §5.9 listing, MANIFEST/NEED, chunk decryption and verification — without
 * a browser, a peer connection or a signal server. What it deliberately
 * does not model is loss or reordering; those belong to SCTP, not to us.
 */
class FakeChannel extends EventTarget {
  peer: FakeChannel | null = null

  send(data: Uint8Array): void {
    // Copied because the caller reuses its buffers, and delivered in a
    // microtask because a real channel never calls back synchronously.
    const payload = data.slice().buffer
    queueMicrotask(() => {
      this.peer?.dispatchEvent(new MessageEvent('message', { data: payload }))
    })
  }
}

function linkedChannels(): { client: DataChannels; depot: DataChannels } {
  const make = () => {
    const a = new FakeChannel()
    const b = new FakeChannel()
    a.peer = b
    b.peer = a
    return [a, b] as const
  }
  const [clientCtl, depotCtl] = make()
  const [clientData, depotData] = make()

  // sampleNetwork() only iterates the report, so an empty one is a valid
  // "nothing to learn yet" and leaves the chunk sizer at its default.
  const pc = { getStats: () => Promise.resolve(new Map()) } as unknown as RTCPeerConnection

  const wrap = (ctl: FakeChannel, data: FakeChannel): DataChannels => ({
    pc,
    ctl: ctl as unknown as RTCDataChannel,
    data: data as unknown as RTCDataChannel,
    connectionType: 'direct',
    close: () => {},
  })

  return { client: wrap(clientCtl, clientData), depot: wrap(depotCtl, depotData) }
}

function keys(): SessionKeys {
  return {
    kC2D: new Uint8Array(32).fill(7),
    kD2C: new Uint8Array(32).fill(9),
  }
}

function fileOf(name: string, size: number, seed = 1): OfferedFile {
  let a = seed >>> 0
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    bytes[i] = (t ^ (t >>> 14)) & 0xff
  }
  return { name, bytes }
}

async function bytesOf(file: { blob: Blob }): Promise<number[]> {
  return Array.from(new Uint8Array(await file.blob.arrayBuffer()))
}

async function connect(source: DepotSource) {
  const { client, depot } = linkedChannels()
  const k = keys()
  const sent: number[] = []
  const [sender, session] = await Promise.all([
    runFileSender(depot, k, source, (e) => {
      if (e.type === 'chunk-sent' && e.index !== undefined) sent.push(e.index)
    }),
    openClientSession(client, k),
  ])
  return { session, sender, stop: () => sender.stop(), sent }
}

describe('transfer session over ctl (protocol.md §5.7, §5.9)', () => {
  beforeEach(() => {
    // jsdom has no IndexedDB, so the cache falls back to memory — which
    // is shared between tests and has to be cleared between them.
    resetChunkCacheForTests()
  })

  it('lists what the Depot is offering', async () => {
    const file = fileOf('IMG_0001.jpg', 40_000)
    const { session, stop } = await connect(singleFileSource(() => file))

    const entries = await session.list('')
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('IMG_0001.jpg')
    expect(entries[0].kind).toBe('file')
    expect(entries[0].size).toBe(40_000)

    session.close()
    stop()
  })

  it('fetches a listed file and verifies it byte for byte', async () => {
    const file = fileOf('report.bin', 90_000, 3)
    const { session, stop } = await connect(singleFileSource(() => file))

    const [entry] = await session.list('')
    const received = await session.fetch(entry.handle)

    expect(received.name).toBe('report.bin')
    expect(received.size).toBe(file.bytes.length)
    expect(await bytesOf(received)).toEqual(Array.from(file.bytes))

    session.close()
    stop()
  }, 20_000)

  it('serves many requests over one session', async () => {
    // The regression this pins down: the ctl codec used to be built per
    // fetch, so a second request restarted its send counter at zero and
    // the Depot — whose codec does persist — rejected it as a replay.
    // Browsing is nothing but repeated requests, so one-shot was fatal.
    const file = fileOf('a.bin', 20_000, 5)
    const { session, stop } = await connect(singleFileSource(() => file))

    const first = await session.list('')
    const second = await session.list('')
    expect(second).toEqual(first)

    const a = await session.fetch(first[0].handle)
    const b = await session.fetch(first[0].handle)
    expect(await bytesOf(a)).toEqual(Array.from(file.bytes))
    expect(await bytesOf(b)).toEqual(Array.from(file.bytes))

    session.close()
    stop()
  }, 20_000)

  it('refuses a handle it never issued', async () => {
    const { session, stop } = await connect(singleFileSource(() => fileOf('a.bin', 1_000)))

    // §5.9: handles are minted by the Depot, so one the Client made up
    // resolves to nothing. No path is ever parsed, so there is no
    // traversal to get wrong.
    await expect(session.fetch('../../etc/passwd')).rejects.toThrow(/no such file/i)

    session.close()
    stop()
  })

  it('walks into a directory and back out', async () => {
    const inner = fileOf('VID_0002.mp4', 30_000, 11)
    const source: DepotSource = {
      list: (handle) =>
        handle === ''
          ? [{ handle: 'camera', name: 'Camera', kind: 'dir', count: 1 }]
          : handle === 'camera'
            ? [{ handle: 'vid', name: inner.name, kind: 'file', size: inner.bytes.length, modifiedAt: 1_757_808_000_000 }]
            : [],
      open: (handle) => (handle === 'vid' ? inner : null),
    }
    const { session, stop } = await connect(source)

    const roots = await session.list('')
    expect(roots).toEqual([{ handle: 'camera', name: 'Camera', kind: 'dir', count: 1 }])

    const children = await session.list('camera')
    expect(children[0].name).toBe('VID_0002.mp4')

    const received = await session.fetch(children[0].handle)
    expect(await bytesOf(received)).toEqual(Array.from(inner.bytes))

    session.close()
    stop()
  }, 20_000)

  it('asks for nothing it already holds', async () => {
    // §5.7 step 3 is the whole of resumption: NEED carries only the
    // indices the Client is missing. Seeding the cache with every chunk
    // stands in for an attempt that got all the way through and then lost
    // the connection before assembling.
    const file = fileOf('resumable.bin', 400_000, 13)
    const manifest = await buildManifest(1, file.name, file.bytes, cdcParamsForAvg(64 * 1024))
    expect(manifest.chunkCount).toBeGreaterThan(1)
    await putChunks(
      manifest.chunks.map((c) => [c.hash, file.bytes.slice(c.offset, c.offset + c.length)] as [string, Uint8Array]),
    )

    const { session, stop, sent } = await connect(singleFileSource(() => file))
    const [entry] = await session.list('')
    const received = await session.fetch(entry.handle)

    expect(await bytesOf(received)).toEqual(Array.from(file.bytes))
    expect(sent).toEqual([]) // not one chunk crossed the wire

    session.close()
    stop()
  }, 20_000)

  it('asks only for the chunks it is missing', async () => {
    const file = fileOf('partial.bin', 400_000, 17)
    const manifest = await buildManifest(1, file.name, file.bytes, cdcParamsForAvg(64 * 1024))
    expect(manifest.chunkCount).toBeGreaterThan(1)
    const held = manifest.chunks.slice(0, 1)
    await putChunks(
      held.map((c) => [c.hash, file.bytes.slice(c.offset, c.offset + c.length)] as [string, Uint8Array]),
    )

    const { session, stop, sent } = await connect(singleFileSource(() => file))
    const [entry] = await session.list('')
    const received = await session.fetch(entry.handle)

    expect(await bytesOf(received)).toEqual(Array.from(file.bytes))
    expect(sent.length).toBe(manifest.chunkCount - held.length)
    expect(sent).not.toContain(held[0].index)

    session.close()
    stop()
  }, 20_000)

  it('tells a connected Client when the shared set changes', async () => {
    // The reported symptom: share a file on the phone while a browser is
    // already connected, and the browser showed nothing until reloaded.
    let offered: OfferedFile | null = null
    const { session, sender, stop } = await connect(singleFileSource(() => offered))

    expect(await session.list('')).toEqual([])

    const announced = new Promise<void>((resolve) => {
      session.onChanged(resolve)
    })
    offered = fileOf('late.bin', 2_000, 31)
    sender.notifyChanged()
    await announced

    const entries = await session.list('')
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('late.bin')

    session.close()
    stop()
  })

  it('reports an empty Depot rather than failing', async () => {
    const { session, stop } = await connect(singleFileSource(() => null))
    expect(await session.list('')).toEqual([])
    await expect(session.fetch(undefined)).rejects.toThrow(/no such file/i)
    session.close()
    stop()
  })
})
