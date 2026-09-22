/**
 * Adaptive chunk sizing, protocol.md §5.5:
 *   RTT <20ms, loss <0.1%  -> 1 MB
 *   RTT <100ms, loss <1%   -> 256 KB
 *   worse                  -> 32-64 KB
 * with EWMA-smoothed measurements, discrete steps only (one tier per
 * adjustment), a 5s cooldown between adjustments, and hysteresis
 * (different thresholds for stepping up vs down) to prevent oscillation.
 */

export interface NetworkSample {
  rttMs: number
  lossFraction: number
}

const TIERS = [64 * 1024, 256 * 1024, 1024 * 1024] as const

export class AdaptiveChunkSize {
  private tier = 0
  private smoothedRtt = 0
  private smoothedLoss = 0
  private initialized = false
  private lastAdjustedAt = 0
  private readonly alpha: number
  private readonly cooldownMs: number

  constructor(options: { alpha?: number; cooldownMs?: number } = {}) {
    this.alpha = options.alpha ?? 0.3
    this.cooldownMs = options.cooldownMs ?? 5000
  }

  current(): number {
    // A test hook, in the same shape as the stall windows in
    // transferSession.ts. Climbing a tier honestly takes a 5s cooldown
    // and real getStats() samples, which is exactly the condition that
    // made the second fetch of a session differ from the first — so
    // there has to be some way to reach it without waiting.
    const forced = (globalThis as { DEPOT_FORCE_CHUNK_TIER?: number }).DEPOT_FORCE_CHUNK_TIER
    return forced ?? TIERS[this.tier]
  }

  update(sample: NetworkSample, now: number = Date.now()): void {
    if (!this.initialized) {
      this.smoothedRtt = sample.rttMs
      this.smoothedLoss = sample.lossFraction
      this.initialized = true
      return
    }
    this.smoothedRtt = this.alpha * sample.rttMs + (1 - this.alpha) * this.smoothedRtt
    this.smoothedLoss = this.alpha * sample.lossFraction + (1 - this.alpha) * this.smoothedLoss

    if (now - this.lastAdjustedAt < this.cooldownMs) return

    if (this.tier < TIERS.length - 1 && this.canUpgrade()) {
      this.tier += 1
      this.lastAdjustedAt = now
    } else if (this.tier > 0 && this.shouldDowngrade()) {
      this.tier -= 1
      this.lastAdjustedAt = now
    }
  }

  // Stricter than the spec's nominal thresholds — requires clear headroom
  // before stepping up, so a link hovering right at the boundary doesn't flap.
  private canUpgrade(): boolean {
    if (this.tier === 0) return this.smoothedRtt < 80 && this.smoothedLoss < 0.008
    if (this.tier === 1) return this.smoothedRtt < 15 && this.smoothedLoss < 0.0008
    return false
  }

  // At or looser than the spec's nominal thresholds — reacts to degradation promptly.
  private shouldDowngrade(): boolean {
    if (this.tier === 2) return this.smoothedRtt >= 20 || this.smoothedLoss >= 0.001
    if (this.tier === 1) return this.smoothedRtt >= 100 || this.smoothedLoss >= 0.01
    return false
  }
}

/**
 * Reads RTT off the active candidate pair. Standard getStats() doesn't
 * expose a reliable cross-browser loss fraction for SCTP data channels, so
 * loss is reported as 0 (optimistic) rather than overclaiming precision —
 * sizing here leans on RTT, with loss folded in wherever a browser does
 * report it.
 */
export async function sampleNetwork(pc: RTCPeerConnection): Promise<NetworkSample | null> {
  const report = await pc.getStats()
  for (const stat of report.values()) {
    const pair = stat as RTCIceCandidatePairStats
    if (pair.type === 'candidate-pair' && pair.state === 'succeeded' && (pair.nominated ?? true)) {
      const rttMs = typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : 0
      return { rttMs, lossFraction: 0 }
    }
  }
  return null
}

/** CDC parameters scaled to a target average chunk size, keeping min/max proportionally bounded. */
/**
 * CDC parameters for a target average, never exceeding what CAPS agreed.
 *
 * [ceiling] matters more than it looks. A chunker asked for an average
 * of N produces chunks of up to 4N — that spread is how content-defined
 * chunking finds its boundaries — while §5.4 makes the negotiated
 * maxChunkSize a hard limit that *both* sides reject a manifest for
 * exceeding. Deriving the parameters from the average alone therefore
 * built manifests that the peer was entitled to refuse, and did:
 *
 *  - Uploading passed the negotiated size straight in as the average,
 *    so every chunk four times over the limit. Sending anything from
 *    the browser failed with "chunk 0 is larger than CAPS agreed".
 *  - Serving passed §5.5's current tier. That starts at 64 KB, whose
 *    maximum of 256 KB is comfortably inside a 1 MB ceiling — so the
 *    first fetch of a session worked. Once the link measured well and
 *    the tier climbed to 1 MB, the maximum became 4 MB and every fetch
 *    after that was refused, until the page was reloaded and the tier
 *    reset. "The first one works and then I have to reload" was this.
 *
 * So the ceiling caps the maximum, and the average follows it down
 * rather than the other way about.
 */
export function cdcParamsForAvg(
  avgSize: number,
  ceiling = Number.POSITIVE_INFINITY,
): { minSize: number; avgSize: number; maxSize: number } {
  const maxSize = Math.min(avgSize * 4, ceiling)
  // Half the maximum rather than a quarter of it when the ceiling binds.
  // The chunker's own spread is four times the average, so a quarter
  // would be the figure that never truncates — but truncating the tail
  // of the distribution costs almost nothing here (chunks are used for
  // resuming one transfer, not for dedup across versions) and a quarter
  // would double the number of messages for no gain anyone can measure.
  const avg = Math.max(1, Math.min(avgSize, Math.floor(maxSize / 2)))
  return { minSize: Math.max(1, Math.floor(avg / 4)), avgSize: avg, maxSize }
}
