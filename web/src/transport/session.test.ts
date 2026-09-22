import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { putChunks, resetChunkCacheForTests } from '../storage/chunkCache'
import { Direction, encodeChunkFrame, encodeCtlFrame } from './frame'
import { buildManifest } from './manifest'
import { cdcParamsForAvg } from './chunkSize'
import {
  openClientSession,
  runFileSender,
  offeredFilesSource,
  singleFileSource,
  type DepotSource,
  type OfferedFile,
  type SessionKeys,
  type WritableTarget,
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

/**
 * A channel that swallows the first thing written to it.
 *
 * Used to lose exactly one message — the Client's CAPS, which is the
 * first thing it says — without touching anything else about the link.
 */
class LosesItsFirstMessage extends FakeChannel {
  private swallowed = false

  override send(data: Uint8Array): void {
    if (!this.swallowed) {
      this.swallowed = true
      return
    }
    super.send(data)
  }
}

/** A link that takes its time, without ever going quiet for long. */
class Dawdles extends FakeChannel {
  delayMs = 0
  /** Each message lands a gap after the one before it, not all at once. */
  private queued = 0

  override send(data: Uint8Array): void {
    const payload = data.slice().buffer
    this.queued += 1
    setTimeout(() => {
      this.queued -= 1
      this.peer?.dispatchEvent(new MessageEvent('message', { data: payload }))
    }, this.delayMs * this.queued)
  }
}

/** A link that swallows everything written to it. */
class SaysNothing extends FakeChannel {
  override send(): void {}
}

/**
 * A channel that enforces a maximum message size, as a real one does.
 *
 * The plain FakeChannel has no limit at all, which is why every test in
 * this file passed while both directions were building frames the wire
 * would refuse. The message is the one Chrome produces.
 */
class RefusesOversized extends FakeChannel {
  limit = Number.POSITIVE_INFINITY

  override send(data: Uint8Array): void {
    if (data.length > this.limit) {
      throw new Error(
        "Failed to execute 'send' on 'RTCDataChannel': " +
          'Trying to send message larger than max-message-size',
      )
    }
    super.send(data)
  }
}

function linkedChannels(
  options: {
    clientCtl?: () => FakeChannel
    depotData?: () => FakeChannel
    /** What SCTP negotiated, enforced on both ends as a real link does. */
    maxMessageSize?: number
  } = {},
): { client: DataChannels; depot: DataChannels } {
  const limited = () => {
    const c = new RefusesOversized()
    if (options.maxMessageSize !== undefined) c.limit = options.maxMessageSize
    return c
  }
  /**
   * Both ends of a pair, because a limit only one end enforces proves
   * only half of anything — and got this wrong once already: with the
   * Depot's data channel unlimited, serving oversized frames sailed
   * through a test written to catch exactly that.
   */
  const makePair = (a?: FakeChannel, b?: FakeChannel) => {
    a ??= limited()
    b ??= limited()
    a.peer = b
    b.peer = a
    return [a, b] as const
  }
  const [clientCtl, depotCtl] = makePair(options.clientCtl?.())
  const [depotData, clientData] = makePair(options.depotData?.())

  // sampleNetwork() only iterates the report, so an empty one is a valid
  // "nothing to learn yet" and leaves the chunk sizer at its default.
  const pc = {
    getStats: () => Promise.resolve(new Map()),
    sctp: options.maxMessageSize === undefined ? null : { maxMessageSize: options.maxMessageSize },
  } as unknown as RTCPeerConnection

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

async function connect(
  source: DepotSource,
  options: Parameters<typeof linkedChannels>[0] = {},
) {
  const { client, depot } = linkedChannels(options)
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

    // A link generous enough to leave the chunking alone: this test
    // seeds the cache from explicit parameters, so the sender has to
    // arrive at the same boundaries for the seeding to mean anything.
    const { session, stop, sent } = await connect(singleFileSource(() => file), {
      maxMessageSize: 1024 * 1024,
    })
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

    // A link generous enough to leave the chunking alone: this test
    // seeds the cache from explicit parameters, so the sender has to
    // arrive at the same boundaries for the seeding to mean anything.
    const { session, stop, sent } = await connect(singleFileSource(() => file), {
      maxMessageSize: 1024 * 1024,
    })
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

/**
 * A Depot whose answers are already on the wire.
 *
 * The fake channel above delivers in a microtask and runs a real Depot,
 * so every reply takes several turns to come back — which is the timing
 * that hides this. Here each reply is encrypted up front and dispatched
 * in the same turn as the request that triggers it, which is what a fast
 * link does in practice.
 *
 * It matters most for chunks. The ctl codec decodes asynchronously, so a
 * ctl reply still finds its subscriber by the time it is parsed; the
 * chunk listener is attached straight to the data channel, so anything
 * that arrives before that line runs is simply gone, `outstanding` never
 * empties, and the transfer sits there until its two-minute timeout.
 */
describe('a reply that arrives in the same turn as the request', () => {
  it('does not lose chunks written the instant NEED goes out', async () => {
    const k = keys()
    const file = fileOf('a.bin', 6000, 5)
    const manifest = await buildManifest(1, file.name, file.bytes, cdcParamsForAvg(1024))

    const ctl = new FakeChannel()
    const data = new FakeChannel()
    const channels: DataChannels = {
      pc: { getStats: () => Promise.resolve(new Map()) } as unknown as RTCPeerConnection,
      ctl: ctl as unknown as RTCDataChannel,
      data: data as unknown as RTCDataChannel,
      connectionType: 'direct',
      close: () => {},
    }

    const ctlFrame = async (counter: number, msg: unknown) =>
      encodeCtlFrame(
        k.kD2C,
        Direction.DepotToClient,
        counter,
        // Re-wrapped: libsodium rejects the view TextEncoder returns.
        new Uint8Array(new TextEncoder().encode(JSON.stringify(msg))),
      )

    const caps = await ctlFrame(0, {
      type: 'CAPS',
      version: 1,
      maxChunkSize: 1 << 20,
      compression: ['deflate-raw'],
    })
    const manifestFrame = await ctlFrame(1, { type: 'MANIFEST', manifest })

    const chunkFrames: Uint8Array[] = []
    for (const info of manifest.chunks) {
      chunkFrames.push(
        await encodeChunkFrame(k.kD2C, Direction.DepotToClient, {
          transferId: manifest.transferId,
          chunkIndex: info.index,
          plaintext: file.bytes.subarray(info.offset, info.offset + info.length),
          compressed: false,
        }),
      )
    }

    const deliver = (channel: FakeChannel, frame: Uint8Array) =>
      channel.dispatchEvent(new MessageEvent('message', { data: frame.slice().buffer }))

    let writes = 0
    ctl.send = () => {
      writes++
      if (writes === 1) deliver(ctl, caps) // answering our CAPS
      else if (writes === 2) deliver(ctl, manifestFrame) // answering REQUEST_FILE
      else if (writes === 3) for (const frame of chunkFrames) deliver(data, frame) // answering NEED
    }

    const session = await openClientSession(channels, k)
    const received = await session.fetch('h1')
    expect(received.name).toBe('a.bin')
    expect(await bytesOf(received)).toEqual(Array.from(file.bytes))
  }, 8000)
})

/**
 * A folder the user marked writable, in memory.
 *
 * reserve() mirrors what SAF does on the phone: it never hands back a
 * name that is taken, so "never overwrite" is a property of the
 * destination rather than a check the protocol has to remember.
 */
function writableFolder() {
  const files = new Map<string, Uint8Array>()
  const target: WritableTarget = {
    reserve(name) {
      if (!files.has(name)) return name
      const dot = name.lastIndexOf('.')
      const stem = dot <= 0 ? name : name.slice(0, dot)
      const ext = dot <= 0 ? '' : name.slice(dot)
      for (let n = 1; ; n++) {
        const candidate = `${stem} (${n})${ext}`
        if (!files.has(candidate)) return candidate
      }
    },
    store(name, bytes) {
      files.set(name, bytes)
    },
  }
  return { files, target }
}

describe('upload (protocol.md §5.10)', () => {
  beforeEach(() => {
    resetChunkCacheForTests()
    // The real figure is 30s; waiting it out would make this suite the
    // slowest thing in the repository.
    ;(globalThis as { DEPOT_UPLOAD_STALL_MS?: number }).DEPOT_UPLOAD_STALL_MS = 1_500
  })

  function sourceWith(folder: ReturnType<typeof writableFolder> | null): DepotSource {
    return {
      list: (handle) =>
        handle === '' ? [{ handle: 'inbox', name: 'Inbox', kind: 'dir' as const }] : [],
      open: () => null,
      writable: (handle) => (handle === 'inbox' ? (folder?.target ?? null) : null),
    }
  }

  it('carries a file up and stores it byte for byte', async () => {
    const folder = writableFolder()
    const { session, stop } = await connect(sourceWith(folder))
    const file = fileOf('scan.pdf', 40_000, 3)

    const stored = await session.send('inbox', { name: file.name, bytes: file.bytes })

    expect(stored).toBe('scan.pdf')
    expect(Array.from(folder.files.get('scan.pdf')!)).toEqual(Array.from(file.bytes))
    stop()
  }, 20_000)

  it('never overwrites, and says what it called it instead', async () => {
    // The rule that stops an upload feature from being a way to destroy
    // things. There is no version history here to recover from.
    const folder = writableFolder()
    folder.files.set('scan.pdf', new Uint8Array([1, 2, 3]))

    const { session, stop } = await connect(sourceWith(folder))
    const file = fileOf('scan.pdf', 5_000, 9)
    const stored = await session.send('inbox', { name: file.name, bytes: file.bytes })

    expect(stored).toBe('scan (1).pdf')
    expect(Array.from(folder.files.get('scan.pdf')!)).toEqual([1, 2, 3])
    expect(folder.files.get('scan (1).pdf')!.length).toBe(5_000)
    stop()
  }, 20_000)

  it('refuses a directory the user did not mark writable', async () => {
    // Granting a folder to read from is not consent to have things put
    // in it, which is why writable() answers null by default.
    const { session, stop } = await connect(sourceWith(null))
    await expect(
      session.send('inbox', { name: 'x.bin', bytes: new Uint8Array(10) }),
    ).rejects.toThrow(/not somewhere this Depot accepts files/)
    stop()
  }, 20_000)

  it('gives the same answer for "not writable" and "no such handle"', async () => {
    // Distinguishable answers would let a Client map which handles exist
    // by trying to write to them.
    const folder = writableFolder()
    const { session, stop } = await connect(sourceWith(folder))

    const refusals = await Promise.all(
      ['not-a-handle', '../../etc'].map((h) =>
        session.send(h, { name: 'x.bin', bytes: new Uint8Array(10) }).catch((e: Error) => e.message),
      ),
    )
    expect(new Set(refusals).size).toBe(1)
    stop()
  }, 20_000)

  it('refuses a name shaped like a path before anything is reserved', async () => {
    const folder = writableFolder()
    const { session, stop } = await connect(sourceWith(folder))
    await expect(
      session.send('inbox', { name: '../escape.txt', bytes: new Uint8Array(10) }),
    ).rejects.toThrow(/looks like a path/)
    expect(folder.files.size).toBe(0)
    stop()
  }, 20_000)

  it('serves and accepts over one session', async () => {
    // The two directions share a data channel and a codec; running both
    // is what proves the upload listener does not eat served chunks.
    const folder = writableFolder()
    const offered = fileOf('down.bin', 20_000, 4)
    const source: DepotSource = {
      list: (handle) =>
        handle === ''
          ? [
              { handle: 'inbox', name: 'Inbox', kind: 'dir' as const },
              { handle: 'f', name: offered.name, kind: 'file' as const, size: offered.bytes.length },
            ]
          : [],
      open: (handle) => (handle === 'f' ? offered : null),
      writable: (handle) => (handle === 'inbox' ? folder.target : null),
    }

    const { session, stop } = await connect(source)
    const up = fileOf('up.bin', 18_000, 5)

    const got = await session.fetch('f')
    expect(await bytesOf(got)).toEqual(Array.from(offered.bytes))

    await session.send('inbox', { name: up.name, bytes: up.bytes })
    expect(Array.from(folder.files.get('up.bin')!)).toEqual(Array.from(up.bytes))

    // And down again afterwards, so it is not one-then-broken.
    const again = await session.fetch('f')
    expect(await bytesOf(again)).toEqual(Array.from(offered.bytes))
    stop()
  }, 30_000)

  it('writes nothing, and says so, when the chunks never verify', async () => {
    // Every chunk corrupted in flight. The Depot drops each one, which
    // is right — but dropping them silently would leave the Client
    // watching a progress bar that never moves, so it gives up out loud.
    const folder = writableFolder()
    const { client, depot } = linkedChannels()
    const k = keys()

    // Flip a bit in every frame the Client puts on the wire, after the
    // AEAD has been applied, which is what a corrupted link looks like.
    const wire = client.data as unknown as { send: (data: Uint8Array) => void }
    const realSend = wire.send.bind(client.data)
    wire.send = (data: Uint8Array) => {
      const copy = data.slice()
      copy[copy.length - 1] ^= 0xff
      realSend(copy)
    }

    const [sender, session] = await Promise.all([
      runFileSender(depot, k, {
        list: () => [],
        open: () => null,
        writable: (h) => (h === 'inbox' ? folder.target : null),
      }, () => {}),
      openClientSession(client, k),
    ])

    const file = fileOf('corrupt.bin', 9_000, 11)
    await expect(session.send('inbox', { name: file.name, bytes: file.bytes })).rejects.toThrow(
      /stopped making progress/,
    )
    expect(folder.files.size).toBe(0)
    sender.stop()
  }, 60_000)
})

describe('several files on offer at once (§5.9)', () => {
  beforeEach(() => {
    resetChunkCacheForTests()
  })

  it('lists every file, and adding one leaves the others alone', async () => {
    // The bug this replaces: picking a second file un-shared the first,
    // so sending two meant sending one and then losing it.
    const files = [fileOf('one.bin', 4_000, 1), fileOf('two.bin', 5_000, 2)]
    const { session, stop } = await connect(offeredFilesSource(() => files))

    expect((await session.list('')).map((e) => e.name)).toEqual(['one.bin', 'two.bin'])

    files.push(fileOf('three.bin', 6_000, 3))
    expect((await session.list('')).map((e) => e.name)).toEqual(['one.bin', 'two.bin', 'three.bin'])
    stop()
  }, 20_000)

  it('keeps each file its own handle, so a third does not disturb the first', async () => {
    // A Client recognises what it holds by handle. If adding a file
    // renumbered the others, everything already fetched would look like
    // something else and be fetched again.
    const files = [fileOf('one.bin', 4_000, 1)]
    const source = offeredFilesSource(() => files)
    const { session, stop } = await connect(source)

    const before = (await session.list(''))[0].handle
    files.push(fileOf('two.bin', 5_000, 2))
    const after = (await session.list('')).find((e) => e.name === 'one.bin')!.handle
    expect(after).toBe(before)
    stop()
  }, 20_000)

  it('serves each of them by its own handle', async () => {
    const files = [fileOf('one.bin', 4_000, 1), fileOf('two.bin', 5_000, 2)]
    const { session, stop } = await connect(offeredFilesSource(() => files))

    const listed = await session.list('')
    for (const [i, entry] of listed.entries()) {
      const got = await session.fetch(entry.handle)
      expect(await bytesOf(got)).toEqual(Array.from(files[i].bytes))
    }
    stop()
  }, 30_000)

  it('still answers a Client that names no handle at all', async () => {
    // §5.9's "whatever you are offering", from a Client that predates
    // browsing. With several, the first is the only sensible answer.
    const files = [fileOf('one.bin', 2_000, 7), fileOf('two.bin', 2_000, 8)]
    const { session, stop } = await connect(offeredFilesSource(() => files))
    const got = await session.fetch(undefined)
    expect(await bytesOf(got)).toEqual(Array.from(files[0].bytes))
    stop()
  }, 20_000)

  it('stops serving one that has been removed', async () => {
    const files = [fileOf('one.bin', 3_000, 4), fileOf('two.bin', 3_000, 5)]
    const { session, stop } = await connect(offeredFilesSource(() => files))
    const listed = await session.list('')
    const goneHandle = listed[1].handle

    files.splice(1, 1)
    await expect(session.fetch(goneHandle)).rejects.toThrow(/no such file/)
    expect((await session.list('')).map((e) => e.name)).toEqual(['one.bin'])
    stop()
  }, 20_000)
})

/**
 * protocol.md §5.4 — CAPS is a negotiation, not a gate.
 *
 * The Depot used to hand its caller a session only once the Client's
 * CAPS had come back, and to reject the Client when it had not. But the
 * ctl handler is already answering LIST by then, so a CAPS that went
 * missing produced a Depot that browsed perfectly and was, as far as the
 * listener was concerned, not connected to anyone: SHARED_CHANGED went
 * nowhere, and a file shared afterwards showed up only on a reload.
 */
describe('a Client whose CAPS never arrives', () => {
  it('is still a session, and still hears that the shared set changed', async () => {
    const k = keys()
    let offered: OfferedFile | null = null
    const { client, depot } = linkedChannels({ clientCtl: () => new LosesItsFirstMessage() })

    const [sender, session] = await Promise.all([
      runFileSender(depot, k, singleFileSource(() => offered), () => {}),
      openClientSession(client, k),
    ])

    expect(await session.list('')).toEqual([])

    const announced = new Promise<void>((resolve) => {
      session.onChanged(resolve)
    })
    offered = fileOf('arrived-late.bin', 3_000, 17)
    sender.notifyChanged()
    await announced

    expect((await session.list('')).map((e) => e.name)).toEqual(['arrived-late.bin'])
    session.close()
    sender.stop()
  })

  it('can still fetch, at the chunk size a silent peer is assumed to accept', async () => {
    const k = keys()
    const file = fileOf('quiet.bin', 200_000, 3)
    const { client, depot } = linkedChannels({ clientCtl: () => new LosesItsFirstMessage() })

    const [sender, session] = await Promise.all([
      runFileSender(depot, k, singleFileSource(() => file), () => {}),
      openClientSession(client, k),
    ])

    const entries = await session.list('')
    const got = await session.fetch(entries[0].handle)
    expect(await bytesOf(got)).toEqual(Array.from(file.bytes))
    session.close()
    sender.stop()
  })
})

/**
 * protocol.md §5.7 — giving up is about silence, not about size.
 *
 * The receive loop armed a single 120-second timeout when a transfer
 * started and never touched it again, which made it a cap on how long a
 * file is allowed to take. On a LAN nothing reaches it. Over mobile data
 * it is about 15 MB: a video arriving perfectly steadily was cut off
 * part-way and reported as a timeout. The upload direction already
 * measured the gap between chunks rather than the whole; this is the
 * same rule pointed the other way.
 */
describe('a download that is slow but never silent', () => {
  const stall = (ms: number | undefined) => {
    ;(globalThis as { DEPOT_DOWNLOAD_STALL_MS?: number }).DEPOT_DOWNLOAD_STALL_MS = ms
  }
  afterEach(() => stall(undefined))

  it('finishes, however much longer it takes than the window', async () => {
    // Every gap is comfortably inside the window; the transfer as a
    // whole is several times longer than it. Only a total deadline
    // fails this.
    stall(300)
    const slowLink = new Dawdles()
    slowLink.delayMs = 60

    const file = fileOf('holiday.mp4', 400_000, 12)
    const { client, depot } = linkedChannels({ depotData: () => slowLink })
    const k = keys()
    const [sender, session] = await Promise.all([
      runFileSender(depot, k, singleFileSource(() => file), () => {}),
      openClientSession(client, k),
    ])

    const entries = await session.list('')
    const started = Date.now()
    const got = await session.fetch(entries[0].handle)
    expect(await bytesOf(got)).toEqual(Array.from(file.bytes))
    expect(Date.now() - started, 'the point is that it took longer than one window').toBeGreaterThan(300)

    session.close()
    sender.stop()
  })

  it('still gives up on a Depot that has gone quiet, and says what was left', async () => {
    stall(200)
    const file = fileOf('stops.bin', 200_000, 13)
    const { client, depot } = linkedChannels({ depotData: () => new SaysNothing() })
    const k = keys()
    const [sender, session] = await Promise.all([
      runFileSender(depot, k, singleFileSource(() => file), () => {}),
      openClientSession(client, k),
    ])

    const entries = await session.list('')
    await expect(session.fetch(entries[0].handle)).rejects.toThrow(/nothing arrived for .*chunk/s)

    session.close()
    sender.stop()
  })
})

/**
 * protocol.md §5.4/§5.5 — the negotiated size is a ceiling, not a target.
 *
 * A chunker asked for an average of N produces chunks of up to 4N; that
 * spread is how content-defined chunking finds its boundaries. But both
 * sides reject a whole manifest containing a chunk above what CAPS
 * agreed, so building one from the average alone produced manifests the
 * peer was entitled to refuse — and did, in both directions:
 *
 *  - Serving: §5.5's tier starts at 64 KB, whose 256 KB maximum fits
 *    inside a 1 MB ceiling, so the first fetch of a session worked. Once
 *    the link measured well and the tier climbed to 1 MB, the maximum
 *    became 4 MB and every fetch after that was refused — until the page
 *    was reloaded and the tier reset to 64 KB.
 *  - Uploading: the negotiated size went in as the average, so every
 *    chunk was four times over from the first byte. Sending anything
 *    from the browser failed with "chunk 0 is larger than CAPS agreed".
 */
describe('chunk sizes against the ceiling CAPS agreed', () => {
  const CEILING = 1024 * 1024

  it('never proposes a chunk larger than the ceiling, at any tier', () => {
    for (const tier of [64 * 1024, 256 * 1024, 1024 * 1024]) {
      const params = cdcParamsForAvg(tier, CEILING)
      expect(params.maxSize, `tier ${tier} proposes ${params.maxSize}`).toBeLessThanOrEqual(CEILING)
      expect(params.minSize).toBeLessThanOrEqual(params.avgSize)
      expect(params.avgSize).toBeLessThanOrEqual(params.maxSize)
    }
  })

  it('leaves a tier that already fits exactly as it was', () => {
    // The common case must not be made worse by the cap.
    expect(cdcParamsForAvg(64 * 1024, CEILING)).toEqual(cdcParamsForAvg(64 * 1024))
  })

  it('serves a file once the link has measured well and the tier has climbed', async () => {
    // The tier climbing is the whole difference between the first fetch
    // of a session and the rest. At 1 MB the old parameters proposed
    // chunks of up to 4 MB, and the Client refused the manifest.
    const force = (n: number | undefined) => {
      ;(globalThis as { DEPOT_FORCE_CHUNK_TIER?: number }).DEPOT_FORCE_CHUNK_TIER = n
    }
    const file = fileOf('holiday.mp4', 3_000_000, 21)
    const { session, stop } = await connect(singleFileSource(() => file))
    const entries = await session.list('')

    force(1024 * 1024)
    try {
      const got = await session.fetch(entries[0].handle)
      expect(await bytesOf(got)).toEqual(Array.from(file.bytes))
    } finally {
      force(undefined)
    }

    session.close()
    stop()
  })

  it('sends a file up without proposing chunks the Depot must refuse', async () => {
    const folder = writableFolder()
    const { session, stop } = await connect({
      list: (handle) =>
        handle === '' ? [{ handle: 'inbox', name: 'Inbox', kind: 'dir' as const }] : [],
      open: () => null,
      writable: (handle) => (handle === 'inbox' ? folder.target : null),
    })
    const entries = await session.list('')
    const inbox = entries.find((e) => e.kind === 'dir')!

    // Comfortably over the ceiling, which is where this failed.
    const big = fileOf('scan.pdf', 3_000_000, 22)
    const stored = await session.send(inbox.handle, { name: big.name, bytes: big.bytes })
    expect(stored).toBe('scan.pdf')
    expect(Array.from(folder.files.get('scan.pdf')!)).toEqual(Array.from(big.bytes))

    session.close()
    stop()
  })
})

/**
 * The limit SCTP actually enforces, which nothing consulted.
 *
 * A data channel negotiates a maximum message size and holds to it: a
 * browser throws "Trying to send message larger than max-message-size",
 * and libwebrtc returns false from send() without a word. Chunk sizes
 * were chosen from §5.4's CAPS and §5.5's tiers alone, as though the
 * wire would carry whatever it was handed.
 *
 * It mostly did, by luck: §5.5 starts every session at 64 KB, whose
 * frames fit inside every implementation's limit. Once a link measured
 * well and the tier climbed, the frames outgrew the channel. A download
 * stopped at a few percent, because the Depot's sends were being dropped
 * silently; an upload failed outright with the browser's exception. On a
 * fake channel with no limit, neither can happen — which is why every
 * test here passed while both directions were broken on real hardware.
 */
describe('a channel that enforces its maximum message size', () => {
  // What a phone's libwebrtc guarantees, and what this now assumes when
  // a connection does not say: RFC 8831 §6.6.
  const PHONE_LIMIT = 64 * 1024

  const force = (n: number | undefined) => {
    ;(globalThis as { DEPOT_FORCE_CHUNK_TIER?: number }).DEPOT_FORCE_CHUNK_TIER = n
  }
  afterEach(() => force(undefined))

  it('serves a large file over it, at the tier that used to break', async () => {
    const file = fileOf('DSC_0409.JPG', 1_500_000, 31)
    const { session, stop } = await connect(singleFileSource(() => file), {
      maxMessageSize: PHONE_LIMIT,
    })
    const entries = await session.list('')

    force(1024 * 1024)
    const got = await session.fetch(entries[0].handle)
    expect(await bytesOf(got)).toEqual(Array.from(file.bytes))

    session.close()
    stop()
  }, 30_000)

  it('sends a photograph up over it', async () => {
    // The sizes from the report: the 150 KB file arrived and everything
    // over a megabyte failed.
    const folder = writableFolder()
    const { session, stop } = await connect(
      {
        list: (handle) =>
          handle === '' ? [{ handle: 'inbox', name: 'Inbox', kind: 'dir' as const }] : [],
        open: () => null,
        writable: (handle) => (handle === 'inbox' ? folder.target : null),
      },
      { maxMessageSize: PHONE_LIMIT },
    )
    const entries = await session.list('')
    const inbox = entries.find((e) => e.kind === 'dir')!

    const photo = fileOf('ChatGPT Image.png', 1_900_000, 32)
    const stored = await session.send(inbox.handle, { name: photo.name, bytes: photo.bytes })
    expect(stored).toBe(photo.name)
    expect(Array.from(folder.files.get(photo.name)!)).toEqual(Array.from(photo.bytes))

    session.close()
    stop()
  }, 30_000)
})
