import { CHUNK_FRAME_OVERHEAD } from './frame'

/**
 * How large a single message on a data channel may be.
 *
 * SCTP negotiates this in the SDP (`a=max-message-size`) and it is a
 * hard limit, not a suggestion: `send()` on an oversized message throws
 * `Trying to send message larger than max-message-size` in a browser,
 * and returns false — silently — in libwebrtc. Nothing in this codebase
 * looked at it, so §5.5's chunk sizes were chosen as though the wire
 * would carry whatever it was given.
 *
 * It mostly did, by luck. §5.5's lowest tier is 64 KB, whose frames sit
 * well inside every implementation's limit, and that is the tier every
 * session starts at. Once a link measured well and the tier climbed, the
 * frames outgrew the channel: a download stalled at a few percent
 * because libwebrtc dropped them without a word, and an upload failed
 * outright with the browser's exception. Both were reported as soon as
 * this was tried on real hardware, and neither could happen against the
 * fake channel the tests use, which has no limit at all.
 */

/**
 * What to assume when the connection will not say.
 *
 * RFC 8831 §6.6 requires every implementation to handle at least 64 KB,
 * so this is the largest figure that needs no negotiation to be safe.
 */
const ASSUMED_MAX_MESSAGE = 64 * 1024

/**
 * As high as this will go on a connection's own word.
 *
 * Firefox reports a value near 2^30. SCTP can fragment that far in
 * principle and implementations disagree about it in practice, and a
 * megabyte chunk is past the point where a larger one buys anything —
 * §5.5's top tier is 1 MB and the gain from 256 KB to 1 MB is already
 * slight. Believing a huge number here would trade a real risk for no
 * benefit.
 */
const TRUSTED_CEILING = 256 * 1024

/** Never propose chunks below this, however mean the transport is. */
const FLOOR = 8 * 1024

/**
 * The largest chunk *plaintext* this connection can carry in one message.
 *
 * Takes the connection's own figure when it offers one, and leaves room
 * for the frame that will be wrapped around it.
 */
export function maxChunkBytesFor(pc: Pick<RTCPeerConnection, 'sctp'> | undefined): number {
  const reported = pc?.sctp?.maxMessageSize
  const usable =
    typeof reported === 'number' && Number.isFinite(reported) && reported > 0
      ? Math.min(reported, TRUSTED_CEILING)
      : ASSUMED_MAX_MESSAGE
  return Math.max(FLOOR, usable - CHUNK_FRAME_OVERHEAD)
}
