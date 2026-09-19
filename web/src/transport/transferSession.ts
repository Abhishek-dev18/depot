import { toBase64 } from '../crypto/codec'
import { sodium } from '../crypto/sodium'
import { cachedChunks, dropChunks, getChunk, putChunks } from '../storage/chunkCache'
import { AdaptiveChunkSize, cdcParamsForAvg, sampleNetwork } from './chunkSize'
import { compress, decompress, shouldCompress } from './compression'
import { Direction, decodeChunkFrame, decodeCtlFrame, encodeChunkFrame, encodeCtlFrame } from './frame'
import { buildManifest, hashBytes, type Manifest } from './manifest'
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
  | ErrorMessage

const OUR_CAPS: CapsMessage = {
  type: 'CAPS',
  protocolVersion: 1,
  compression: ['deflate', 'none'],
  maxChunkSize: 1024 * 1024,
  features: ['cdc', 'browse'],
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
  const seen = new Set<number>()

  async function send(msg: CtlMessage): Promise<void> {
    const frame = await encodeCtlFrame(sendKey, sendDirection, sendCounter++, encodeUtf8(JSON.stringify(msg)))
    channels.ctl.send(new Uint8Array(frame))
  }

  // One channel listener, fanning out to every handler.
  //
  // Registering a listener per handler looks equivalent and is not: they
  // share `seen`, so whichever listener decoded a frame first would mark
  // its counter as accepted and every other handler would then drop the
  // same frame as a replay. With one waiter at a time that never showed;
  // browsing runs a standing handler alongside waitFor, which would have.
  const handlers = new Set<(msg: CtlMessage) => void>()

  const listener = (ev: MessageEvent) => {
    void (async () => {
      try {
        const raw = new Uint8Array(ev.data as ArrayBuffer)
        const { counter, plaintext } = await decodeCtlFrame(recvKey, recvDirection, raw)
        if (seen.has(counter)) return // replayed by the relay
        seen.add(counter)
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
async function exchangeCaps(ctl: CtlCodec): Promise<CapsMessage> {
  const reply = ctl.waitFor((m): m is CapsMessage => m.type === 'CAPS', 10_000)
  await ctl.send(OUR_CAPS)
  return reply
}

export interface SenderEvent {
  type: 'manifest-sent' | 'chunk-sent' | 'error'
  transferId?: number
  index?: number
  total?: number
  bytesSent?: number
  bytesTotal?: number
  message?: string
}

export interface OfferedFile {
  name: string
  bytes: Uint8Array
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
export interface DepotSource {
  list: (handle: string) => Promise<DirEntry[]> | DirEntry[]
  open: (handle: string | undefined) => Promise<OfferedFile | null> | OfferedFile | null
}

/**
 * Adapts a single offered file to a DepotSource, which is what the web
 * simulator has: one root listing with one row in it. The real Depot is
 * the Android app, and it lists granted folders.
 */
export function singleFileSource(getFile: () => OfferedFile | null): DepotSource {
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
      if (handle !== '') return []
      const file = getFile()
      if (!file) return []
      return [{ handle: handleFor(file), name: file.name, kind: 'file', size: file.bytes.length }]
    },
    open: (handle) => {
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
      const transferId = nextTransferId++
      const avg = Math.min(chunkSizer.current(), maxChunkSize)
      const manifest = await buildManifest(transferId, file.name, file.bytes, cdcParamsForAvg(avg))
      transfers.set(transferId, { manifest, bytes: file.bytes })
      await ctl.send({ type: 'MANIFEST', manifest })
      onEvent({ type: 'manifest-sent', transferId, total: manifest.chunkCount })
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
export interface ClientSession {
  list: (handle: string) => Promise<DirEntry[]>
  fetch: (handle: string | undefined, onEvent?: (e: ReceiverEvent) => void) => Promise<ReceivedFile>

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
  await exchangeCaps(ctl)

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
    return receiveFile(channels, keys, ctl, handle, onEvent)
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

  return {
    list,
    fetch,
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
  const manifest = reply.manifest
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
