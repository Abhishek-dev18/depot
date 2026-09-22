/**
 * How fast the wire is actually draining, smoothed.
 *
 * §5.5 samples RTT and loss from getStats() to pick a chunk size. This
 * measures something getStats() does not offer usefully across browsers:
 * throughput. It is taken from the transfer itself — bytes handed to the
 * data channel, over the time the channel took to accept them — so it
 * needs no probe traffic and costs nothing.
 *
 * It exists for one decision, in compression.ts: whether packing a chunk
 * saves more time than it costs. That decision is wrong in both
 * directions if the link's speed is guessed, and the guess that matters
 * is "is this a LAN or a phone on mobile data", which is two orders of
 * magnitude apart and obvious from one sample.
 */

/** Weight of each new sample. Low, because a single stall is not a trend. */
const ALPHA = 0.25

/**
 * Sends faster than this are not measured.
 *
 * A chunk the channel accepts instantly — because its buffer had room —
 * says nothing about the wire; it says the buffer had room. Timing that
 * yields absurd figures, which would then argue against compressing on
 * a link that is in fact slow. Only a send that had to wait carries
 * information, and the drain wait is what produces one.
 */
const MIN_MEANINGFUL_MS = 1

export class LinkSpeed {
  private smoothed: number | undefined

  /** One chunk's worth: how many bytes, and how long the channel took. */
  sample(bytes: number, elapsedMs: number): void {
    if (elapsedMs < MIN_MEANINGFUL_MS || bytes <= 0) return
    const observed = (bytes * 1000) / elapsedMs
    this.smoothed =
      this.smoothed === undefined ? observed : ALPHA * observed + (1 - ALPHA) * this.smoothed
  }

  /** Bytes per second, or undefined while nothing has been measured. */
  current(): number | undefined {
    return this.smoothed
  }
}
