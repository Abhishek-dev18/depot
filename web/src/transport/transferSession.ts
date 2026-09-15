import { AdaptiveChunkSize, cdcParamsForAvg, sampleNetwork } from './chunkSize'
import { compress, decompress, shouldCompress } from './compression'
import { Direction, decodeChunkFrame, encodeChunkFrame } from './frame'
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

function sendCtl(channels: DataChannels, msg: CtlMessage): void {
  channels.ctl.send(JSON.stringify(msg))
}

function parseCtl(data: unknown): CtlMessage | undefined {
  if (typeof data !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(data)
    if (parsed && typeof parsed === 'object' && 'type' in parsed) return parsed as CtlMessage
  } catch {
    // ignore malformed control messages
  }
  return undefined
}

function onCtlMessage(channels: DataChannels, handler: (msg: CtlMessage) => void): () => void {
  const listener = (ev: MessageEvent) => {
    const msg = parseCtl(ev.data)
    if (msg) handler(msg)
  }
  channels.ctl.addEventListener('message', listener)
  return () => channels.ctl.removeEventListener('message', listener)
}

function waitForCtl<T extends CtlMessage>(
  channels: DataChannels,
  predicate: (msg: CtlMessage) => msg is T,
  timeoutMs = 20_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('timed out waiting for a control message'))
    }, timeoutMs)
    const unsubscribe = onCtlMessage(channels, (msg) => {
      if (predicate(msg)) {
        clearTimeout(timer)
        unsubscribe()
        resolve(msg)
      }
    })
  })
}

async function exchangeCaps(channels: DataChannels): Promise<CapsMessage> {
  sendCtl(channels, OUR_CAPS)
  return waitForCtl(channels, (m): m is CapsMessage => m.type === 'CAPS', 10_000)
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
  const peerCaps = await exchangeCaps(channels)
  const maxChunkSize = Math.min(OUR_CAPS.maxChunkSize, peerCaps.maxChunkSize)
  const chunkSizer = new AdaptiveChunkSize()

  const transfers = new Map<number, { manifest: Manifest; bytes: Uint8Array }>()
  let nextTransferId = 1

  const statsTimer = setInterval(() => {
    void sampleNetwork(channels.pc).then((sample) => {
      if (sample) chunkSizer.update(sample)
    })
  }, 2000)

  const unsubscribe = onCtlMessage(channels, (msg) => {
    void handleCtl(msg)
  })

  async function handleCtl(msg: CtlMessage): Promise<void> {
    if (msg.type === 'REQUEST_FILE') {
      const file = getFile()
      if (!file) {
        sendCtl(channels, { type: 'ERROR', message: 'no file offered' })
        return
      }
      const transferId = nextTransferId++
      const avg = Math.min(chunkSizer.current(), maxChunkSize)
      const manifest = await buildManifest(transferId, file.name, file.bytes, cdcParamsForAvg(avg))
      transfers.set(transferId, { manifest, bytes: file.bytes })
      sendCtl(channels, { type: 'MANIFEST', manifest })
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
  await exchangeCaps(channels)

  sendCtl(channels, { type: 'REQUEST_FILE' })
  const reply = await waitForCtl(
    channels,
    (m): m is ManifestMessage | ErrorMessage => m.type === 'MANIFEST' || m.type === 'ERROR',
    20_000,
  )
  if (reply.type === 'ERROR') throw new Error(reply.message)
  const manifest = reply.manifest
  onEvent({ type: 'manifest', total: manifest.chunkCount })

  const needed = manifest.chunks.map((c) => c.index)
  sendCtl(channels, { type: 'NEED', transferId: manifest.transferId, indices: needed })

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
