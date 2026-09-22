import { describe, expect, it } from 'vitest'
import { CHUNK_FRAME_OVERHEAD } from './frame'
import { maxChunkBytesFor } from './messageSize'

/**
 * The limit that was never consulted.
 *
 * SCTP negotiates a maximum message size and enforces it: a browser
 * throws "Trying to send message larger than max-message-size", and
 * libwebrtc returns false without a word. §5.5's chunk sizes were picked
 * as though neither happened.
 */
describe('what one message on this connection can carry', () => {
  const withSctp = (maxMessageSize: number) =>
    ({ sctp: { maxMessageSize } }) as unknown as Pick<RTCPeerConnection, 'sctp'>

  it('leaves room for the frame around the chunk', () => {
    // The figure that must fit under the limit is the frame, not the
    // plaintext inside it. Off by the header and the AEAD tag is still
    // off, and fails only on the chunks that land exactly at the edge.
    expect(maxChunkBytesFor(withSctp(262_144))).toBe(262_144 - CHUNK_FRAME_OVERHEAD)
  })

  it('assumes the guaranteed minimum when the connection will not say', () => {
    // RFC 8831 §6.6: every implementation handles at least 64 KB.
    expect(maxChunkBytesFor(undefined)).toBe(64 * 1024 - CHUNK_FRAME_OVERHEAD)
    expect(maxChunkBytesFor({ sctp: null } as unknown as Pick<RTCPeerConnection, 'sctp'>)).toBe(
      64 * 1024 - CHUNK_FRAME_OVERHEAD,
    )
  })

  it('does not take a very large claim at face value', () => {
    // Firefox reports a number near 2^30. Implementations disagree about
    // fragmenting that far, and a chunk past 256 KB buys almost nothing
    // — §5.5's own top tier is 1 MB and the gain from 256 KB is slight.
    expect(maxChunkBytesFor(withSctp(1_073_741_823))).toBe(256 * 1024 - CHUNK_FRAME_OVERHEAD)
  })

  it('never proposes something absurdly small', () => {
    expect(maxChunkBytesFor(withSctp(100))).toBeGreaterThanOrEqual(8 * 1024)
  })
})
