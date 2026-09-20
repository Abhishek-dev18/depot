import { toBase64 } from '../crypto/codec'
import { sodium } from '../crypto/sodium'
import { cachedChunks, dropChunks, getChunk, putChunks } from '../storage/chunkCache'
import { AdaptiveChunkSize, cdcParamsForAvg, sampleNetwork } from './chunkSize'
import { compress, decompress, shouldCompress } from './compression'
import { Direction, decodeChunkFrame, decodeCtlFrame, encodeChunkFrame, encodeCtlFrame } from './frame'
import { buildManifest, hashBytes, type ChunkInfo, type Manifest } from './manifest'
import { validateManifest, validateUploadName } from './validate'
import type { DataChannels } from './webrtc'

export interface SessionKeys {
  kC2D: Uint8Array
  kD2C: Uint8Array
}

/** protocol.md §5.4 CAPS — the intersection governs the session. */
interface CapsMessage {
  type: 'CAPS'
  protocolVersion: number
  compression: string[]
  maxChunkSize: number
  features: string[]
}

interface RequestFileMessage {
  type: 'REQUEST_FILE'
  /** §5.9 — omitted means "whatever you are currently offering". */
  handle?: string
}

/** protocol.md §5.9 — one row of a directory listing. */
export interface DirEntry {
  handle: string
  name: string
  kind: 'file' | 'dir'
  size?: number
  modifiedAt?: number
  /** Children, where the Depot can count them cheaply. Directories only. */
  count?: number
  /**
   * What the Depot's storage layer calls this file, where it knows.
   *
   * Advisory, and never trusted beyond choosing a renderer — see
   * preview.ts. It exists because a display name is not always enough:
   * Android content providers hand back names with no extension, and a
   * Client reading only extensions calls those files unpreviewable.
   */
  mime?: string
  /**
   * §5.10 — directories only, and absent means no. It tells a Client
   * where an upload will be accepted so it can offer that and nothing
   * else. Not an authorisation: the Depot checks the grant again when
   * the PUT arrives.
   */
  writable?: boolean
}

interface ListMessage {
  type: 'LIST'
  handle: string
}

interface ListOkMessage {
  type: 'LIST_OK'
  handle: string
  entries: DirEntry[]
}

/** protocol.md §5.9 — "what you were told is out of date; ask again". */
interface SharedChangedMessage {
  type: 'SHARED_CHANGED'
}

/** protocol.md §5.10 — the Client offers a file for a writable directory. */
interface PutMessage {
  type: 'PUT'
  /** A directory handle the Depot minted. The Client still names no location. */
  handle: string
  name: string
  size: number
  chunkCount: number
  chunks: ChunkInfo[]
  fileHash: string
  mime?: string
}

/** The Depot accepts, and says which chunks it still wants. */
interface PutOkMessage {
  type: 'PUT_OK'
  uploadId: number
  need: number[]
}

/** Written and verified. `name` is what it ended up called. */
interface PutDoneMessage {
  type: 'PUT_DONE'
  uploadId: number
  name: string
}

interface ManifestMessage {
  type: 'MANIFEST'
  manifest: Manifest
}

interface NeedMessage {
  type: 'NEED'
  transferId: number
  indices: number[]
}

interface ErrorMessage {
  type: 'ERROR'
  message: string
}

type CtlMessage =
  | CapsMessage
  | RequestFileMessage
  | ListMessage
  | ListOkMessage
  | SharedChangedMessage
  | ManifestMessage
  | NeedMessage
  | PutMessage
  | PutOkMessage
  | PutDoneMessage
  | ErrorMessage

const OUR_CAPS: CapsMessage = {
  type: 'CAPS',
  protocolVersion: 1,
  compression: ['deflate', 'none'],
  maxChunkSize: 1024 * 1024,
  features: ['cdc', 'browse', 'upload'],
}

// The ASCII-only utf8() in crypto/transcript.ts cannot carry a file name.
// Copying into a fresh Uint8Array keeps libsodium's strict same-realm type
// check happy under jsdom, which is why that encoder avoids TextEncoder.
function encodeUtf8(s: string): Uint8Array {
  return new Uint8Array(new TextEncoder().encode(s))
}

/**
 * The encrypted `ctl` channel (protocol.md §5.3). Each side encrypts with
 * its own directional key under a monotonically increasing counter, and
 * rejects any counter it has already accepted, so the relay can neither
 * read control messages nor replay them.
 */
interface CtlCodec {
  send: (msg: CtlMessage) => Promise<void>
  onMessage: (handler: (msg: CtlMessage) => void) => () => void
  waitFor: <T extends CtlMessage>(predicate: (msg: CtlMessage) => msg is T, timeoutMs?: number) => Promise<T>
  close: () => void
}

function createCtlCodec(channels: DataChannels, keys: SessionKeys, role: 'client' | 'depot'): CtlCodec {
  const sendKey = role === 'client' ? keys.kC2D : keys.kD2C
  const sendDirection = role === 'client' ? Direction.ClientToDepot : Direction.DepotToClient
  const recvKey = role === 'client' ? keys.kD2C : keys.kC2D
  const recvDirection = role === 'client' ? Direction.DepotToClient : Direction.ClientToDepot

  let sendCounter = 0

  /*
   * Replay tracking, as a sliding window rather than a growing set.
   *
   * Remembering every counter ever accepted is correct and unbounded: a
   * session that browses a large tree sends a ctl message per directory,
   * and nothing ever falls out. Counters only increase at the sender, so
   * anything far enough below the highest one seen cannot be a legitimate
   * reordering — it is either a replay or a frame so late it is useless.
   * Rejecting those outright bounds the memory without weakening
   * anything: a relay replaying a recent frame still fails, and one
   * replaying an old frame fails harder.
   */
  const REPLAY_WINDOW = 1024
  let highestSeen = -1
  const recent = new Set<number>()

  function acceptCounter(counter: number): boolean {
    if (counter <= highestSeen - REPLAY_WINDOW) return false // too old to be real
    if (recent.has(counter)) return false // already accepted
    recent.add(counter)
    if (counter > highestSeen) {
      highestSeen = counter
      // Everything that just fell out of the window is refused by the
      // first test from now on, so it need not be remembered.
      for (const old of recent) {
        if (old <= highestSeen - REPLAY_WINDOW) recent.delete(old)
      }
    }
    return true
  }

  async function send(msg: CtlMessage): Promise<void> {
    const frame = await encodeCtlFrame(sendKey, sendDirection, sendCounter++, encodeUtf8(JSON.stringify(msg)))
    channels.ctl.send(new Uint8Array(frame))
  }

  // One channel listener, fanning out to every handler.
  //
  // Registering a listener per handler looks equivalent and is not: they
  // share the replay window, so whichever listener decoded a frame first would mark
  // its counter as accepted and every other handler would then drop the
  // same frame as a replay. With one waiter at a time that never showed;
  // browsing runs a standing handler alongside waitFor, which would have.
  const handlers = new Set<(msg: CtlMessage) => void>()

  const listener = (ev: MessageEvent) => {
    void (async () => {
      try {
        const raw = new Uint8Array(ev.data as ArrayBuffer)
        const { counter, plaintext } = await decodeCtlFrame(recvKey, recvDirection, raw)
        if (!acceptCounter(counter)) return // replayed, or too old to matter
        const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext))
        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return
        // Copied first: a handler may unsubscribe itself while we iterate.
        for (const handler of [...handlers]) handler(parsed as CtlMessage)
      } catch {
        // Undecryptable, malformed or forged — there is no legitimate
        // sender for such a frame, so drop it.
      }
    })()
  }
  channels.ctl.addEventListener('message', listener)

  function onMessage(handler: (msg: CtlMessage) => void): () => void {
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  }

  function close(): void {
    handlers.clear()
    channels.ctl.removeEventListener('message', listener)
  }

  function waitFor<T extends CtlMessage>(
    predicate: (msg: CtlMessage) => msg is T,
    timeoutMs = 20_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error('timed out waiting for a control message'))
      }, timeoutMs)
      const unsubscribe = onMessage((msg) => {
        if (predicate(msg)) {
          clearTimeout(timer)
          unsubscribe()
          resolve(msg)
        }
      })
    })
  }

  return { send, onMessage, waitFor, close }
}

/**
 * Everywhere below, the wait is armed before the request goes out.
 *
 * Sending first and subscribing afterwards reads as equivalent and is
 * not. `await send()` hands control back to the event loop, and an
 * answer that arrives before the next line runs has nothing listening
 * for it — the codec drops it, and the caller waits out its full timeout
 * for a reply that already came and went. It is rare on a slow link and
 * ordinary on a fast one, which is the worst way for a bug to behave.
 */
/**
 * Waiting for the channel to drink what it has been given.
 *
 * SCTP will buffer without complaint until the browser gives up and
 * closes the connection, which is what sending a large file as fast as
 * the loop can encrypt it produces. The `bufferedamountlow` event is the
 * cheap way to wait; the timeout behind it is there because a channel
 * that dies mid-send never fires it.
 */
const BUFFER_HIGH_WATER = 4 * 1024 * 1024
const BUFFER_LOW_WATER = 1 * 1024 * 1024

async function waitForDrain(data: RTCDataChannel): Promise<void> {
  // A channel that does not report buffering is not buffering. Reading
  // `undefined < high` as "keep waiting" makes every send wait out the
  // timeout below, which turns a transfer into a stall — and the fake
  // channel the tests run on is exactly such a channel.
  const buffered = typeof data.bufferedAmount === 'number' ? data.bufferedAmount : 0
  if (buffered < BUFFER_HIGH_WATER) return
  data.bufferedAmountLowThreshold = BUFFER_LOW_WATER
  await new Promise<void>((resolve) => {
    const done = () => {
      data.removeEventListener('bufferedamountlow', done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 5_000)
    data.addEventListener('bufferedamountlow', done)
    // It may already have drained between the check and the listener.
    if ((data.bufferedAmount ?? 0) <= BUFFER_LOW_WATER) done()
  })
}

async function exchangeCaps(ctl: CtlCodec): Promise<CapsMessage> {
  const reply = ctl.waitFor((m): m is CapsMessage => m.type === 'CAPS', 10_000)
  await ctl.send(OUR_CAPS)
  return reply
}

export interface SenderEvent {
  type:
    | 'manifest-sent'
    | 'chunk-sent'
    | 'error'
    // §5.10, the direction that writes.
    | 'upload-started'
    | 'upload-chunk'
    | 'upload-stored'
  transferId?: number
  uploadId?: number
  index?: number
  total?: number
  bytesSent?: number
  bytesTotal?: number
  bytesReceived?: number
  message?: string
  /** On 'upload-stored': what it was actually called. */
  name?: string
}

export interface OfferedFile {
  name: string
  bytes: Uint8Array
  /** What the browser's File said it was, passed on as §5.9's advisory mime. */
  mime?: string
}

/**
 * What a Depot exposes to a Client (protocol.md §5.9).
 *
 * `list` is given a handle the Depot itself minted, or the empty string
 * for the grants at the top. `open` is given a handle, or undefined for
 * the pre-§5.9 meaning of REQUEST_FILE. Both return null / throw for
 * anything they did not mint, which is the whole of the access control:
 * the Client never names a location, so there is no path to traverse.
 */
/** Where an upload is allowed to land (protocol.md §5.10). */
export interface WritableTarget {
  /** A name that is free, which is how "never overwrite" is enforced. */
  reserve: (name: string) => Promise<string> | string
  /** Called once the whole file has been verified, never before. */
  store: (name: string, bytes: Uint8Array, mime?: string) => Promise<void> | void
}

export interface DepotSource {
  list: (handle: string) => Promise<DirEntry[]> | DirEntry[]
  open: (handle: string | undefined) => Promise<OfferedFile | null> | OfferedFile | null
  /**
   * §5.10 — null means this handle is not a directory the user marked
   * writable, which is the default and the answer for every Depot that
   * does not accept uploads at all.
   */
  writable?: (handle: string) => Promise<WritableTarget | null> | WritableTarget | null
}

/**
 * Adapts a single offered file to a DepotSource, which is what the web
 * simulator has: one root listing with one row in it. The real Depot is
 * the Android app, and it lists granted folders.
 */
/**
 * An in-memory folder the simulator will accept uploads into.
 *
 * The real Depot writes through SAF into a folder the user granted and
 * marked writable; this is the same shape with a Map behind it, so §5.10
 * is exercisable in two browser tabs rather than only on a handset.
 */
export function memoryInbox(
  /** Handed the contents, so a caller need not reach back for them. */
  onChange: (files: Map<string, { bytes: Uint8Array; at: number }>) => void = () => {},
) {
  const files = new Map<string, { bytes: Uint8Array; at: number }>()
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
      files.set(name, { bytes, at: Date.now() })
      onChange(files)
    },
  }
  return { files, target }
}

const INBOX_HANDLE = 'inbox'

export function singleFileSource(
  getFile: () => OfferedFile | null,
  /**
   * Absent means this Depot accepts nothing, which is the default the
   * protocol asks for: granting a folder to read from is not consent to
   * have things put in it.
   */
  inbox: ReturnType<typeof memoryInbox> | null = null,
): DepotSource {
  /*
   * The handle names the file, not the slot it sits in.
   *
   * One constant handle for "whatever is offered right now" would let a
   * second, different file inherit the first one's identity — and a
   * Client that keeps what it received recognises files by handle, so it
   * would go on showing the old bytes under the new name.
   *
   * Name and length are what is available without reading the file, so
   * two different files with the same name and the same size still
   * collide. Nothing on the wire can distinguish those without hashing
   * the contents on every listing, which is why the Client's preview
   * carries an explicit "fetch again".
   */
  const handleFor = (file: OfferedFile) => `offered:${file.bytes.length}:${file.name}`
  return {
    list: (handle) => {
      if (handle === INBOX_HANDLE && inbox) {
        return [...inbox.files.entries()].map(([name, entry]) => ({
          handle: `inbox:${entry.bytes.length}:${name}`,
          name,
          kind: 'file' as const,
          size: entry.bytes.length,
          modifiedAt: entry.at,
        }))
      }
      if (handle !== '') return []
      const rows: DirEntry[] = []
      if (inbox) {
        rows.push({
          handle: INBOX_HANDLE,
          name: 'Inbox',
          kind: 'dir',
          count: inbox.files.size,
          writable: true,
        })
      }
      const file = getFile()
      if (file) {
        rows.push({
          handle: handleFor(file),
          name: file.name,
          kind: 'file',
          size: file.bytes.length,
          mime: file.mime,
        })
      }
      return rows
    },
    writable: (handle) => (handle === INBOX_HANDLE ? (inbox?.target ?? null) : null),
    open: (handle) => {
      // Anything that landed in the inbox can be fetched back out of it,
      // which is what makes the round trip checkable end to end.
      if (inbox && handle?.startsWith('inbox:')) {
        const name = handle.slice(handle.indexOf(':', 'inbox:'.length) + 1)
        const entry = inbox.files.get(name)
        return entry ? { name, bytes: entry.bytes } : null
      }
      const file = getFile()
      if (!file) return null
      // undefined is §5.9's "whatever you are currently offering".
      return handle === undefined || handle === handleFor(file) ? file : null
    },
  }
}

/**
 * Depot side of §5.7: answers REQUEST_FILE with a MANIFEST, then streams
 * whatever chunks NEED asks for. Runs until stop() is called, so it can
 * serve repeated NEED rounds (resumption after a dropped connection).
 */
/** What a running sender exposes to the listener that owns it. */
export interface RunningSender {
  /** §5.9 — tell this Client its listing is stale. */
  notifyChanged: () => void
  stop: () => void
}

/** How many manifests a sender keeps answerable at once. */
const MAX_LIVE_TRANSFERS = 8

export async function runFileSender(
  channels: DataChannels,
  keys: SessionKeys,
  source: DepotSource,
  onEvent: (e: SenderEvent) => void,
): Promise<RunningSender> {
  const ctl = createCtlCodec(channels, keys, 'depot')
  const chunkSizer = new AdaptiveChunkSize()

  const transfers = new Map<number, { manifest: Manifest; bytes: Uint8Array }>()
  let nextTransferId = 1
  let maxChunkSize = OUR_CAPS.maxChunkSize

  const statsTimer = setInterval(() => {
    void sampleNetwork(channels.pc).then((sample) => {
      if (sample) chunkSizer.update(sample)
    })
  }, 2000)

  // Subscribed before CAPS is exchanged, not after: a Client that sends
  // LIST the moment its own CAPS lands would otherwise be talking to a
  // Depot that has not started listening yet, and the message would be
  // dropped with nothing to retry it.
  const unsubscribe = ctl.onMessage((msg) => {
    void handleCtl(msg)
  })

  const peerCaps = await exchangeCaps(ctl)
  maxChunkSize = Math.min(OUR_CAPS.maxChunkSize, peerCaps.maxChunkSize)

  /** In-flight uploads, by the id this Depot issued. */
  const uploads = new Map<
    number,
    {
      manifest: Manifest
      target: WritableTarget
      reserved: string
      have: Map<number, Uint8Array>
      outstanding: Set<number>
      /** Reset by each chunk that lands; firing abandons the upload. */
      stall: ReturnType<typeof setTimeout>
    }
  >()
  let nextUploadId = 1

  /**
   * How long an upload may go without progress before it is abandoned.
   *
   * A chunk that fails its hash is dropped, which is right — but if
   * every chunk fails, dropping them silently leaves the Client holding
   * a progress bar until its own timeout, with nothing said. That is the
   * same silence this protocol has been bitten by before, so the Depot
   * says what happened instead of waiting to be asked.
   */
  const UPLOAD_STALL_MS = Number(
    // Overridable so the test for it does not wait half a minute.
    (globalThis as { DEPOT_UPLOAD_STALL_MS?: number }).DEPOT_UPLOAD_STALL_MS ?? 30_000,
  )

  function abandonUpload(uploadId: number, why: string): void {
    const entry = uploads.get(uploadId)
    if (!entry) return
    clearTimeout(entry.stall)
    uploads.delete(uploadId)
    void ctl.send({ type: 'ERROR', message: why }).catch(() => {})
    onEvent({ type: 'error', uploadId, message: why })
  }

  function touchUpload(uploadId: number): void {
    const entry = uploads.get(uploadId)
    if (!entry) return
    clearTimeout(entry.stall)
    entry.stall = setTimeout(() => {
      const still = uploads.get(uploadId)
      const missing = still ? still.outstanding.size : 0
      abandonUpload(
        uploadId,
        `the upload stopped making progress with ${missing} chunk(s) still missing — ` +
          'chunks that fail their hash are dropped, so this usually means the file changed while it was being sent',
      )
    }, UPLOAD_STALL_MS)
  }

  /**
   * protocol.md §5.10. Every refusal here is one of the numbered rules,
   * and the order matters: consent is checked before anything is read
   * from the message, so a Client cannot learn whether a name is taken
   * in a directory it was never allowed to write to.
   */
  async function handlePut(msg: PutMessage): Promise<void> {
    const target = (await source.writable?.(msg.handle)) ?? null
    if (!target) {
      // Rules 1 and 2 give the same answer deliberately: "not a handle"
      // and "not writable" must not be distinguishable.
      await ctl.send({ type: 'ERROR', message: 'that is not somewhere this Depot accepts files' })
      return
    }

    let manifest: Manifest
    let name: string
    try {
      name = validateUploadName(msg.name)
      manifest = validateManifest(
        {
          transferId: 0,
          name,
          size: msg.size,
          chunkCount: msg.chunkCount,
          chunks: msg.chunks,
          fileHash: msg.fileHash,
        },
        maxChunkSize,
      )
    } catch (err) {
      await ctl.send({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) })
      return
    }

    // Reserved before a byte arrives, so two uploads racing for one name
    // cannot both believe they have it.
    const reserved = await target.reserve(name)
    const uploadId = nextUploadId++
    const outstanding = new Set(manifest.chunks.map((c) => c.index))

    uploads.set(uploadId, {
      manifest,
      target,
      reserved,
      have: new Map<number, Uint8Array>(),
      outstanding,
      stall: setTimeout(() => {}, 0),
    })
    touchUpload(uploadId)

    await ctl.send({ type: 'PUT_OK', uploadId, need: [...outstanding] })
    onEvent({ type: 'upload-started', uploadId, total: manifest.chunkCount })

    if (outstanding.size === 0) await finishUpload(uploadId)
  }

  /** Verified whole before it is published — never a plausible partial. */
  async function finishUpload(uploadId: number): Promise<void> {
    const entry = uploads.get(uploadId)
    if (!entry) return
    clearTimeout(entry.stall)
    uploads.delete(uploadId)

    const parts: Uint8Array[] = []
    let total = 0
    for (const info of entry.manifest.chunks) {
      const chunk = entry.have.get(info.index)
      if (!chunk) {
        await ctl.send({ type: 'ERROR', message: `chunk ${info.index} never arrived` })
        return
      }
      parts.push(chunk)
      total += chunk.length
    }

    const joined = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
      joined.set(part, at)
      at += part.length
    }

    if ((await hashBytes(joined)) !== entry.manifest.fileHash) {
      await ctl.send({ type: 'ERROR', message: 'the whole-file hash did not match; nothing was written' })
      return
    }

    await entry.target.store(entry.reserved, joined)
    await ctl.send({ type: 'PUT_DONE', uploadId, name: entry.reserved })
    onEvent({ type: 'upload-stored', uploadId, name: entry.reserved })
  }

  /**
   * Uploaded chunks, on the same channel served ones go out on.
   *
   * One standing listener rather than one per upload: the channel is the
   * session's, and a listener installed per transfer is how the receive
   * path once lost chunks that arrived before it was ready.
   */
  const onUploadChunk = (ev: MessageEvent) => {
    void (async () => {
      try {
        const raw = new Uint8Array(ev.data as ArrayBuffer)
        const decoded = await decodeChunkFrame(keys.kC2D, Direction.ClientToDepot, raw)
        const entry = uploads.get(decoded.transferId)
        if (!entry || !entry.outstanding.has(decoded.chunkIndex)) return

        const info = entry.manifest.chunks[decoded.chunkIndex]
        if (!info) return
        const plaintext = decoded.compressed ? await decompress(decoded.plaintext) : decoded.plaintext
        // Checked as it arrives, so a corrupt chunk is dropped rather
        // than written and discovered at the end.
        if ((await hashBytes(plaintext)) !== info.hash) return

        entry.outstanding.delete(decoded.chunkIndex)
        entry.have.set(decoded.chunkIndex, plaintext)
        touchUpload(decoded.transferId)
        onEvent({
          type: 'upload-chunk',
          uploadId: decoded.transferId,
          index: decoded.chunkIndex,
          total: entry.manifest.chunkCount,
          bytesReceived: [...entry.have.values()].reduce((n, c) => n + c.length, 0),
          bytesTotal: entry.manifest.size,
        })
        if (entry.outstanding.size === 0) await finishUpload(decoded.transferId)
      } catch {
        // Undecryptable or malformed: there is no legitimate sender for
        // such a frame, and the upload simply does not complete.
      }
    })()
  }
  channels.data.addEventListener('message', onUploadChunk)

  async function handleCtl(msg: CtlMessage): Promise<void> {
    if (msg.type === 'LIST') {
      try {
        const entries = await source.list(msg.handle)
        await ctl.send({ type: 'LIST_OK', handle: msg.handle, entries })
      } catch (err) {
        await ctl.send({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (msg.type === 'REQUEST_FILE') {
      const file = await source.open(msg.handle)
      if (!file) {
        // Deliberately the same answer for "nothing is offered" and "that
        // is not a handle I issued": a Client should not be able to probe
        // which handles exist.
        await ctl.send({ type: 'ERROR', message: 'no such file' })
        return
      }
      // Bounded for the same reason as the Android sender: an entry
      // holds the file's bytes, so keeping every transfer of a session
      // keeps every file it ever served. A Client returning to a dropped
      // one gets "no such file" and re-requests, which §5.7 handles.
      while (transfers.size >= MAX_LIVE_TRANSFERS) {
        const oldest = Math.min(...transfers.keys())
        transfers.delete(oldest)
      }
      const transferId = nextTransferId++
      const avg = Math.min(chunkSizer.current(), maxChunkSize)
      const manifest = await buildManifest(transferId, file.name, file.bytes, cdcParamsForAvg(avg))
      transfers.set(transferId, { manifest, bytes: file.bytes })
      await ctl.send({ type: 'MANIFEST', manifest })
      onEvent({ type: 'manifest-sent', transferId, total: manifest.chunkCount })
      return
    }

    if (msg.type === 'PUT') {
      await handlePut(msg)
      return
    }

    if (msg.type === 'NEED') {
      const entry = transfers.get(msg.transferId)
      if (!entry) return
      let bytesSent = 0
      for (const index of msg.indices) {
        const info = entry.manifest.chunks[index]
        if (!info) continue
        const plaintext = entry.bytes.subarray(info.offset, info.offset + info.length)

        let payload = plaintext
        let compressed = false
        if (shouldCompress(plaintext)) {
          const packed = await compress(plaintext)
          if (packed.length < plaintext.length) {
            payload = packed
            compressed = true
          }
        }

        const frame = await encodeChunkFrame(keys.kD2C, Direction.DepotToClient, {
          transferId: msg.transferId,
          chunkIndex: index,
          plaintext: payload,
          compressed,
        })
        await waitForDrain(channels.data)
        channels.data.send(new Uint8Array(frame)) // fresh ArrayBuffer-backed copy — RTCDataChannel.send()'s stricter typed-array generic wants it
        bytesSent += info.length
        onEvent({
          type: 'chunk-sent',
          transferId: msg.transferId,
          index,
          total: entry.manifest.chunkCount,
          bytesSent,
          bytesTotal: entry.manifest.size,
        })
      }
    }
  }

  return {
    notifyChanged: () => {
      // Best effort: a Client that misses this is stale, not broken, and
      // §5.9 says re-listing at any point puts it right.
      void ctl.send({ type: 'SHARED_CHANGED' }).catch(() => {})
    },
    stop: () => {
      clearInterval(statsTimer)
      unsubscribe()
      channels.data.removeEventListener('message', onUploadChunk)
      // Half-received uploads are dropped rather than written: §5.10
      // publishes nothing that has not been verified whole.
      for (const entry of uploads.values()) clearTimeout(entry.stall)
      uploads.clear()
      ctl.close()
    },
  }
}

export interface ReceiverEvent {
  type: 'manifest' | 'resumed' | 'chunk-received' | 'chunk-invalid'
  index?: number
  total?: number
  bytesReceived?: number
  bytesTotal?: number
}

/**
 * A file that arrived. A Blob rather than a Uint8Array: the bytes may
 * never have been contiguous in memory, and the only thing a browser does
 * with them is save or display them, both of which take a Blob.
 */
export interface ReceivedFile {
  name: string
  size: number
  blob: Blob
}

/**
 * Client side of §5.7 and §5.9, held open for the life of the connection.
 *
 * The earlier shape built a fresh ctl codec per file, which quietly
 * limited a session to one transfer: a new codec restarts its send counter
 * at zero, and the Depot's codec — which does persist — rejects a repeated
 * counter as a replay. Browsing means many requests over one connection,
 * so the codec, and the CAPS exchange that configures it, now belong to
 * the session rather than to a single fetch.
 */
/** What a Client learns while pushing a file up (§5.10). */
export interface SendEvent {
  type: 'manifest-built' | 'accepted' | 'chunk-sent' | 'stored'
  index?: number
  total?: number
  bytesSent?: number
  bytesTotal?: number
  /** On 'stored': what the Depot actually called it. */
  name?: string
}

export interface ClientSession {
  list: (handle: string) => Promise<DirEntry[]>
  fetch: (handle: string | undefined, onEvent?: (e: ReceiverEvent) => void) => Promise<ReceivedFile>

  /**
   * protocol.md §5.10 — offer a file to a directory the Depot said is
   * writable. Resolves with the name it was stored under, which is not
   * always the name asked for: a Depot never overwrites.
   */
  send: (
    handle: string,
    file: { name: string; bytes: Uint8Array; mime?: string },
    onEvent?: (e: SendEvent) => void,
  ) => Promise<string>

  /** The Depot says its shared set changed (§5.9). Returns an unsubscribe. */
  onChanged: (handler: () => void) => () => void

  /**
   * The transport is gone — the Depot stopped, the network dropped, the
   * phone went to sleep. Returns an unsubscribe.
   *
   * Without this a Client shows a working file browser attached to a dead
   * connection, and the first thing anyone learns about it is a click that
   * does nothing.
   */
  onClosed: (handler: () => void) => () => void
  close: () => void
}

export async function openClientSession(
  channels: DataChannels,
  keys: SessionKeys,
): Promise<ClientSession> {
  const ctl = createCtlCodec(channels, keys, 'client')
  const peerCaps = await exchangeCaps(ctl)
  // §5.4: the smaller of the two, and the figure a manifest is checked
  // against. A Depot is free to send smaller chunks; one larger than
  // this is a disagreement about a number both sides just settled.
  const negotiatedChunkSize = Math.min(OUR_CAPS.maxChunkSize, peerCaps.maxChunkSize || OUR_CAPS.maxChunkSize)

  async function list(handle: string): Promise<DirEntry[]> {
    const pending = ctl.waitFor(
      // Matched on the echoed handle, so a listing cannot be mistaken for
      // the answer to a different one.
      (m): m is ListOkMessage | ErrorMessage =>
        (m.type === 'LIST_OK' && m.handle === handle) || m.type === 'ERROR',
      20_000,
    )
    await ctl.send({ type: 'LIST', handle })
    const reply = await pending
    if (reply.type === 'ERROR') throw new Error(reply.message)
    return reply.entries
  }

  async function fetch(
    handle: string | undefined,
    onEvent: (e: ReceiverEvent) => void = () => {},
  ): Promise<ReceivedFile> {
    return receiveFile(channels, keys, ctl, handle, onEvent, negotiatedChunkSize)
  }

  function onChanged(handler: () => void): () => void {
    return ctl.onMessage((m) => {
      if (m.type === 'SHARED_CHANGED') handler()
    })
  }

  /**
   * `failed` and `closed` are final. `disconnected` is not — ICE can
   * recover from a brief network change — so it is given a few seconds
   * before the session is called gone, which stops a moment of bad Wi-Fi
   * from throwing the user back to the waiting screen.
   */
  function onClosed(handler: () => void): () => void {
    let fired = false
    let grace: ReturnType<typeof setTimeout> | undefined

    const fire = () => {
      if (fired) return
      fired = true
      clearTimeout(grace)
      handler()
    }

    const onState = () => {
      const state = channels.pc.connectionState
      if (state === 'failed' || state === 'closed') fire()
      else if (state === 'disconnected') {
        clearTimeout(grace)
        grace = setTimeout(() => {
          if (channels.pc.connectionState !== 'connected') fire()
        }, 6000)
      } else if (state === 'connected') {
        clearTimeout(grace)
      }
    }

    channels.pc.addEventListener('connectionstatechange', onState)
    channels.ctl.addEventListener('close', fire)
    channels.data.addEventListener('close', fire)
    onState()

    return () => {
      clearTimeout(grace)
      channels.pc.removeEventListener('connectionstatechange', onState)
      channels.ctl.removeEventListener('close', fire)
      channels.data.removeEventListener('close', fire)
    }
  }

  /**
   * §5.10, and deliberately the mirror of receiveFile: the Client builds
   * the manifest, the Depot says which chunks it wants, and only chunks
   * it asked for are sent. A Depot that already holds some of them — a
   * retried upload — asks for fewer, and the transfer resumes.
   */
  async function send(
    handle: string,
    file: { name: string; bytes: Uint8Array; mime?: string },
    onEvent: (e: SendEvent) => void = () => {},
  ): Promise<string> {
    const name = validateUploadName(file.name)
    const manifest = await buildManifest(0, name, file.bytes, cdcParamsForAvg(negotiatedChunkSize))
    onEvent({ type: 'manifest-built', total: manifest.chunkCount })

    const accepted = ctl.waitFor(
      (m): m is PutOkMessage | ErrorMessage => m.type === 'PUT_OK' || m.type === 'ERROR',
      30_000,
    )
    await ctl.send({
      type: 'PUT',
      handle,
      name,
      size: file.bytes.length,
      chunkCount: manifest.chunkCount,
      chunks: manifest.chunks,
      fileHash: manifest.fileHash,
      mime: file.mime,
    })
    const reply = await accepted
    if (reply.type === 'ERROR') throw new Error(reply.message)
    onEvent({ type: 'accepted', total: reply.need.length })

    // Armed before the last chunk goes out, for the reason the receive
    // path documents: an answer that beats the subscribe is lost.
    const stored = ctl.waitFor(
      (m): m is PutDoneMessage | ErrorMessage =>
        (m.type === 'PUT_DONE' && m.uploadId === reply.uploadId) || m.type === 'ERROR',
      120_000,
    )

    let bytesSent = 0
    for (const index of reply.need) {
      const info = manifest.chunks[index]
      if (!info) continue
      const plaintext = file.bytes.subarray(info.offset, info.offset + info.length)

      let payload = plaintext
      let compressed = false
      if (shouldCompress(plaintext)) {
        const packed = await compress(plaintext)
        if (packed.length < plaintext.length) {
          payload = packed
          compressed = true
        }
      }

      const frame = await encodeChunkFrame(keys.kC2D, Direction.ClientToDepot, {
        transferId: reply.uploadId,
        chunkIndex: index,
        plaintext: payload,
        compressed,
      })
      await waitForDrain(channels.data)
      channels.data.send(new Uint8Array(frame))

      bytesSent += info.length
      onEvent({
        type: 'chunk-sent',
        index,
        total: manifest.chunkCount,
        bytesSent,
        bytesTotal: manifest.size,
      })
    }

    const done = await stored.catch(() => {
      // Naming the step: a Depot that dropped every chunk without saying
      // so leaves exactly this wait hanging, and "timed out waiting for a
      // control message" tells nobody anything.
      throw new Error('the Depot never confirmed it had stored the file')
    })
    if (done.type === 'ERROR') throw new Error(done.message)
    onEvent({ type: 'stored', name: done.name })
    return done.name
  }

  return {
    list,
    fetch,
    send,
    onChanged,
    onClosed,
    close: () => {
      ctl.close()
    },
  }
}

/** One transfer: REQUEST_FILE, MANIFEST, NEED, then verify and reassemble. */
async function receiveFile(
  channels: DataChannels,
  keys: SessionKeys,
  ctl: CtlCodec,
  handle: string | undefined,
  onEvent: (e: ReceiverEvent) => void,
  maxChunkSize: number,
): Promise<ReceivedFile> {
  const pending = ctl.waitFor(
    (m): m is ManifestMessage | ErrorMessage => m.type === 'MANIFEST' || m.type === 'ERROR',
    20_000,
  )
  await ctl.send({ type: 'REQUEST_FILE', handle })
  const reply = await pending.catch(() => {
    // Naming the step matters here: "timed out waiting for a control
    // message" tells the user nothing, and this is the wait that a Depot
    // which died mid-request leaves hanging.
    throw new Error('the Depot did not answer the request for this file')
  })
  if (reply.type === 'ERROR') throw new Error(reply.message)
  // Checked before anything acts on it — see validate.ts for why a bad
  // manifest would otherwise surface as a hang rather than an error.
  const manifest = validateManifest(reply.manifest, maxChunkSize)
  onEvent({ type: 'manifest', total: manifest.chunkCount })

  // §5.7 step 3, and the whole of resumption: ask only for what is
  // missing. Chunks are cached by their own hash, so anything a previous
  // attempt verified is already good and never crosses the wire again.
  const allHashes = manifest.chunks.map((c) => c.hash)
  const held = await cachedChunks(allHashes)
  const needed = manifest.chunks.filter((c) => !held.has(c.hash)).map((c) => c.index)

  let bytesReceived = manifest.chunks
    .filter((c) => held.has(c.hash))
    .reduce((sum, c) => sum + c.length, 0)

  if (held.size > 0) {
    onEvent({
      type: 'resumed',
      index: held.size,
      total: manifest.chunkCount,
      bytesReceived,
      bytesTotal: manifest.size,
    })
  }

  if (needed.length > 0) {
    const outstanding = new Set(needed)
    // Written in batches rather than one transaction per chunk: a
    // 600 MB file is thousands of chunks, and a transaction each would
    // cost more than the transfer.
    let pending: Array<[string, Uint8Array]> = []

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        channels.data.removeEventListener('message', onMessage)
        // Whatever arrived is already cached, so the next attempt starts
        // from here rather than from nothing.
        void putChunks(pending).finally(() => reject(new Error('timed out receiving all chunks')))
      }, 120_000)

      function finish() {
        clearTimeout(timer)
        channels.data.removeEventListener('message', onMessage)
        void putChunks(pending).then(resolve, reject)
      }

      function onMessage(ev: MessageEvent) {
        void (async () => {
          try {
            const raw = new Uint8Array(ev.data as ArrayBuffer)
            const decoded = await decodeChunkFrame(keys.kD2C, Direction.DepotToClient, raw)
            if (decoded.transferId !== manifest.transferId) return
            const info = manifest.chunks[decoded.chunkIndex]
            if (!info || !outstanding.has(decoded.chunkIndex)) return

            const plaintext = decoded.compressed ? await decompress(decoded.plaintext) : decoded.plaintext
            const hash = await hashBytes(plaintext)
            if (hash !== info.hash) {
              onEvent({ type: 'chunk-invalid', index: decoded.chunkIndex })
              return
            }

            outstanding.delete(decoded.chunkIndex)
            pending.push([info.hash, plaintext])
            bytesReceived += info.length
            onEvent({
              type: 'chunk-received',
              index: decoded.chunkIndex,
              total: manifest.chunkCount,
              bytesReceived,
              bytesTotal: manifest.size,
            })

            if (pending.length >= 64) {
              const batch = pending
              pending = []
              await putChunks(batch)
            }
            if (outstanding.size === 0) finish()
          } catch (err) {
            clearTimeout(timer)
            channels.data.removeEventListener('message', onMessage)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })()
      }

      channels.data.addEventListener('message', onMessage)

      // Asked for only once something is listening for the answer.
      void ctl
        .send({ type: 'NEED', transferId: manifest.transferId, indices: needed })
        .catch((err: unknown) => {
          clearTimeout(timer)
          channels.data.removeEventListener('message', onMessage)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
    })
  }

  // Assembled as Blob parts and hashed incrementally, so a large file is
  // never held in one contiguous buffer. A 600 MB video would otherwise
  // need that buffer plus the Blob's own copy.
  const s = await sodium()
  const hashState = s.crypto_generichash_init(null, 32)
  const parts: BlobPart[] = []
  for (const info of manifest.chunks) {
    const chunk = await getChunk(info.hash)
    if (!chunk) throw new Error(`missing chunk ${info.index} after all chunks reported received`)
    s.crypto_generichash_update(hashState, chunk)
    parts.push(chunk.slice())
  }
  const fileHash = toBase64(s.crypto_generichash_final(hashState, 32))
  if (fileHash !== manifest.fileHash) throw new Error('whole-file hash mismatch after reassembly')

  // Delivered, so the cache has done its job. Holding on to the contents
  // of a file that has already been handed over would make this browser a
  // copy of the Depot, which is exactly what the product does not do.
  await dropChunks(allHashes)

  return { name: manifest.name, size: manifest.size, blob: new Blob(parts) }
}
