import type { SignalClient } from '../signal/client'
import type { Envelope } from '../signal/envelope'

/**
 * protocol.md §5.1: the project operates no TURN server — public STUN only
 * by default. A user who self-hosts the docker-compose.yml TURN server (or
 * has any other TURN server) can point the Client at it; see TurnConfig.
 */
const STUN_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

export interface TurnConfig {
  url: string
  username: string
  credential: string
}

function iceServers(turn?: TurnConfig): RTCIceServer[] {
  if (!turn?.url) return STUN_SERVERS
  return [...STUN_SERVERS, { urls: turn.url, username: turn.username, credential: turn.credential }]
}

export type ConnectionType = 'direct' | 'relayed' | 'unknown'

export interface DataChannels {
  pc: RTCPeerConnection
  ctl: RTCDataChannel
  data: RTCDataChannel
  connectionType: ConnectionType
  close: () => void
}

/**
 * "Connection state is never hidden" (Depot — Interface Design artifact):
 * a user of a privacy tool deserves to know whether bytes are passing
 * through a third machine. Reads the selected ICE candidate pair's local
 * candidate type off getStats() — 'relay' means TURN, anything else
 * (host/srflx/prflx) is some flavor of direct peer-to-peer path.
 */
interface LocalCandidateStats {
  candidateType?: string
}

async function resolveConnectionType(pc: RTCPeerConnection): Promise<ConnectionType> {
  const report = await pc.getStats()
  for (const stat of report.values()) {
    const pair = stat as RTCIceCandidatePairStats
    if (pair.type === 'candidate-pair' && pair.state === 'succeeded' && (pair.nominated ?? true)) {
      const local = pair.localCandidateId ? (report.get(pair.localCandidateId) as LocalCandidateStats | undefined) : undefined
      if (local?.candidateType) return local.candidateType === 'relay' ? 'relayed' : 'direct'
    }
  }
  return 'unknown'
}

interface SdpPayload {
  sdp: string
  type: RTCSdpType
}

interface IcePayload {
  candidate: RTCIceCandidateInit
}

function matches(type: string, clientId?: string) {
  return (e: Envelope) => e.type === type && (clientId === undefined || e.clientId === clientId)
}

/** Buffers remote ICE candidates that arrive before setRemoteDescription resolves — a standard WebRTC race. */
function bufferedIceHandler(pc: RTCPeerConnection) {
  let remoteDescriptionSet = false
  const queue: RTCIceCandidateInit[] = []

  return {
    onIceFromPeer: (candidate: RTCIceCandidateInit) => {
      if (remoteDescriptionSet) {
        void pc.addIceCandidate(candidate)
      } else {
        queue.push(candidate)
      }
    },
    markRemoteDescriptionSet: () => {
      remoteDescriptionSet = true
      for (const c of queue.splice(0)) void pc.addIceCandidate(c)
    },
  }
}

function requireSdp(desc: RTCSessionDescriptionInit): SdpPayload {
  if (!desc.sdp) throw new Error('local description has no sdp')
  return { sdp: desc.sdp, type: desc.type }
}

function waitForChannelOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    channel.addEventListener('open', () => resolve(), { once: true })
    channel.addEventListener('error', () => reject(new Error(`${channel.label} data channel error`)), { once: true })
  })
}

/** Client side: creates the offer and both DataChannels (§5.2: ctl ordered, data unordered). */
export async function negotiateAsOfferer(relay: SignalClient, turn?: TurnConfig): Promise<DataChannels> {
  const pc = new RTCPeerConnection({ iceServers: iceServers(turn) })
  const ice = bufferedIceHandler(pc)
  const unsubscribers: (() => void)[] = []

  const ctl = pc.createDataChannel('ctl') // ordered + reliable by default
  const data = pc.createDataChannel('data', { ordered: false })
  // Both channels carry binary frames now that ctl is encrypted too (§5.3).
  ctl.binaryType = 'arraybuffer'
  data.binaryType = 'arraybuffer'

  pc.addEventListener('icecandidate', (ev) => {
    if (ev.candidate) relay.relay('RTC_ICE', { candidate: ev.candidate.toJSON() } satisfies IcePayload)
  })
  unsubscribers.push(
    relay.onMessage((e) => {
      if (e.type === 'RTC_ICE') ice.onIceFromPeer((e.payload as IcePayload).candidate)
    }),
  )

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  relay.relay('RTC_OFFER', requireSdp(offer))

  const answerEnvelope = await relay.waitFor(matches('RTC_ANSWER'), 20_000)
  const answer = answerEnvelope.payload as SdpPayload
  await pc.setRemoteDescription({ sdp: answer.sdp, type: answer.type })
  ice.markRemoteDescriptionSet()

  await Promise.all([waitForChannelOpen(ctl), waitForChannelOpen(data)])
  for (const unsub of unsubscribers) unsub()

  const connectionType = await resolveConnectionType(pc)
  return { pc, ctl, data, connectionType, close: () => pc.close() }
}

/** Depot side: waits for the offer, answers, and picks up the Client-opened DataChannels. */
export async function negotiateAsAnswerer(relay: SignalClient, clientId: string, turn?: TurnConfig): Promise<DataChannels> {
  const pc = new RTCPeerConnection({ iceServers: iceServers(turn) })
  const ice = bufferedIceHandler(pc)
  const unsubscribers: (() => void)[] = []

  const channels = new Map<string, RTCDataChannel>()
  const channelsReady = new Promise<void>((resolve) => {
    pc.addEventListener('datachannel', (ev) => {
      channels.set(ev.channel.label, ev.channel)
      if (channels.has('ctl') && channels.has('data')) resolve()
    })
  })

  pc.addEventListener('icecandidate', (ev) => {
    if (ev.candidate) relay.relay('RTC_ICE', { candidate: ev.candidate.toJSON() } satisfies IcePayload, clientId)
  })
  unsubscribers.push(
    relay.onMessage((e) => {
      if (e.type === 'RTC_ICE' && e.clientId === clientId) ice.onIceFromPeer((e.payload as IcePayload).candidate)
    }),
  )

  const offerEnvelope = await relay.waitFor(matches('RTC_OFFER', clientId), 20_000)
  const offer = offerEnvelope.payload as SdpPayload
  await pc.setRemoteDescription({ sdp: offer.sdp, type: offer.type })
  ice.markRemoteDescriptionSet()

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  relay.relay('RTC_ANSWER', requireSdp(answer), clientId)

  await channelsReady
  const ctl = channels.get('ctl')!
  const data = channels.get('data')!
  ctl.binaryType = 'arraybuffer'
  data.binaryType = 'arraybuffer'
  await Promise.all([waitForChannelOpen(ctl), waitForChannelOpen(data)])
  for (const unsub of unsubscribers) unsub()

  const connectionType = await resolveConnectionType(pc)
  return { pc, ctl, data, connectionType, close: () => pc.close() }
}
