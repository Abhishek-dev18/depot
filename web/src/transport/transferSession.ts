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

type CtlMessage = CapsMessage | RequestFileMessage | ManifestMessage | NeedMessage | ErrorMessage

const OUR_CAPS: CapsMessage = {
  type: 'CAPS',
  protocolVersion: 1,
  compression: ['deflate', 'none'],
  maxChunkSize: 1024 * 1024,
  features: ['cdc'],
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

  function onMessage(handler: (msg: CtlMessage) => void): () => void {
    const listener = (ev: MessageEvent) => {
      void (async () => {
        try {
          const raw = new Uint8Array(ev.data as ArrayBuffer)
          const { counter, plaintext } = await decodeCtlFrame(recvKey, recvDirection, raw)
          if (seen.has(counter)) return // replayed by the relay
          seen.add(counter)
          const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext))
          if (parsed && typeof parsed === 'object' && 'type' in parsed) handler(parsed as CtlMessage)
        } catch {
          // Undecryptable, malformed or forged — there is no legitimate
          // sender for such a frame, so drop it.
        }
      })()
    }
    channels.ctl.addEventListener('message', listener)
    return () => channels.ctl.removeEventListener('message', listener)
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

  return { send, onMessage, waitFor }
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
 * Depot side of §5.7: answers REQUEST_FILE with a MANIFEST, then streams
 * whatever chunks NEED asks for. Runs until stop() is called, so it can
 * serve repeated NEED rounds (resumption after a dropped connection).
 */
export async function runFileSender(
  channels: DataChannels,
  keys: SessionKeys,
  getFile: () => OfferedFile | null,
  onEvent: (e: SenderEvent) => void,
): Promise<() => void> {
  const ctl = createCtlCodec(channels, keys, 'depot')
  const peerCaps = await exchangeCaps(ctl)
  const maxChunkSize = Math.min(OUR_CAPS.maxChunkSize, peerCaps.maxChunkSize)
  const chunkSizer = new AdaptiveChunkSize()

  const transfers = new Map<number, { manifest: Manifest; bytes: Uint8Array }>()
  let nextTransferId = 1

  const statsTimer = setInterval(() => {
    void sampleNetwork(channels.pc).then((sample) => {
      if (sample) chunkSizer.update(sample)
    })
  }, 2000)

  const unsubscribe = ctl.onMessage((msg) => {
    void handleCtl(msg)
  })

  async function handleCtl(msg: CtlMessage): Promise<void> {
    if (msg.type === 'REQUEST_FILE') {
      const file = getFile()
      if (!file) {
        await ctl.send({ type: 'ERROR', message: 'no file offered' })
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
  }
}

export interface ReceiverEvent {
  type: 'manifest' | 'chunk-received' | 'chunk-invalid'
  index?: number
  total?: number
  bytesReceived?: number
  bytesTotal?: number
}

/** Client side of §5.7: requests the offered file and reassembles it, verifying every chunk and the whole file. */
export async function requestFile(
  channels: DataChannels,
  keys: SessionKeys,
  onEvent: (e: ReceiverEvent) => void,
): Promise<OfferedFile> {
  const ctl = createCtlCodec(channels, keys, 'client')
  await exchangeCaps(ctl)

  await ctl.send({ type: 'REQUEST_FILE' })
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
