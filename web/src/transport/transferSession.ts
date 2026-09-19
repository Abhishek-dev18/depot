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

async function exchangeCaps(ctl: CtlCodec): Promise<CapsMessage> {
  await ctl.send(OUR_CAPS)
  return ctl.waitFor((m): m is CapsMessage => m.type === 'CAPS', 10_000)
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
  const HANDLE = 'offered'
  return {
    list: (handle) => {
      if (handle !== '') return []
      const file = getFile()
      if (!file) return []
      return [{ handle: HANDLE, name: file.name, kind: 'file', size: file.bytes.length }]
    },
    open: (handle) => (handle === undefined || handle === HANDLE ? getFile() : null),
  }
}

/**
 * Depot side of §5.7: answers REQUEST_FILE with a MANIFEST, then streams
 * whatever chunks NEED asks for. Runs until stop() is called, so it can
 * serve repeated NEED rounds (resumption after a dropped connection).
 */
export async function runFileSender(
  channels: DataChannels,
  keys: SessionKeys,
  source: DepotSource,
  onEvent: (e: SenderEvent) => void,
): Promise<() => void> {
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

  return () => {
    clearInterval(statsTimer)
    unsubscribe()
    ctl.close()
  }
}

export interface ReceiverEvent {
  type: 'manifest' | 'chunk-received' | 'chunk-invalid'
  index?: number
  total?: number
  bytesReceived?: number
  bytesTotal?: number
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
  fetch: (handle: string | undefined, onEvent?: (e: ReceiverEvent) => void) => Promise<OfferedFile>
  close: () => void
}

export async function openClientSession(
  channels: DataChannels,
  keys: SessionKeys,
): Promise<ClientSession> {
  const ctl = createCtlCodec(channels, keys, 'client')
  await exchangeCaps(ctl)

  async function list(handle: string): Promise<DirEntry[]> {
    await ctl.send({ type: 'LIST', handle })
    const reply = await ctl.waitFor(
      // Matched on the echoed handle, so a listing cannot be mistaken for
      // the answer to a different one.
      (m): m is ListOkMessage | ErrorMessage =>
        (m.type === 'LIST_OK' && m.handle === handle) || m.type === 'ERROR',
      20_000,
    )
    if (reply.type === 'ERROR') throw new Error(reply.message)
    return reply.entries
  }

  async function fetch(
    handle: string | undefined,
    onEvent: (e: ReceiverEvent) => void = () => {},
  ): Promise<OfferedFile> {
    return receiveFile(channels, keys, ctl, handle, onEvent)
  }

  return {
    list,
    fetch,
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
): Promise<OfferedFile> {
  await ctl.send({ type: 'REQUEST_FILE', handle })
  const reply = await ctl.waitFor(
    (m): m is ManifestMessage | ErrorMessage => m.type === 'MANIFEST' || m.type === 'ERROR',
    20_000,
  )
  if (reply.type === 'ERROR') throw new Error(reply.message)
  const manifest = reply.manifest
  onEvent({ type: 'manifest', total: manifest.chunkCount })

  const needed = manifest.chunks.map((c) => c.index)
  await ctl.send({ type: 'NEED', transferId: manifest.transferId, indices: needed })

  const received = new Map<number, Uint8Array>()
  let bytesReceived = 0

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      channels.data.removeEventListener('message', onMessage)
      reject(new Error('timed out receiving all chunks'))
    }, 120_000)

    function finish() {
      clearTimeout(timer)
      channels.data.removeEventListener('message', onMessage)
      resolve()
    }

    function onMessage(ev: MessageEvent) {
      void (async () => {
        try {
          const raw = new Uint8Array(ev.data as ArrayBuffer)
          const decoded = await decodeChunkFrame(keys.kD2C, Direction.DepotToClient, raw)
          if (decoded.transferId !== manifest.transferId) return
          const info = manifest.chunks[decoded.chunkIndex]
          if (!info) return

          const plaintext = decoded.compressed ? await decompress(decoded.plaintext) : decoded.plaintext
          const hash = await hashBytes(plaintext)
          if (hash !== info.hash) {
            onEvent({ type: 'chunk-invalid', index: decoded.chunkIndex })
            return
          }

          received.set(decoded.chunkIndex, plaintext)
          bytesReceived += info.length
          onEvent({
            type: 'chunk-received',
            index: decoded.chunkIndex,
            total: manifest.chunkCount,
            bytesReceived,
            bytesTotal: manifest.size,
          })
          if (received.size === manifest.chunkCount) finish()
        } catch (err) {
          clearTimeout(timer)
          channels.data.removeEventListener('message', onMessage)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })()
    }

    channels.data.addEventListener('message', onMessage)
  })

  const bytes = new Uint8Array(manifest.size)
  for (const info of manifest.chunks) {
    const chunk = received.get(info.index)
    if (!chunk) throw new Error(`missing chunk ${info.index} after all chunks reported received`)
    bytes.set(chunk, info.offset)
  }

  const fileHash = await hashBytes(bytes)
  if (fileHash !== manifest.fileHash) throw new Error('whole-file hash mismatch after reassembly')

  return { name: manifest.name, bytes }
}
