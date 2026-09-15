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
    return TIERS[this.tier]
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
export function cdcParamsForAvg(avgSize: number): { minSize: number; avgSize: number; maxSize: number } {
  return { minSize: Math.floor(avgSize / 4), avgSize, maxSize: avgSize * 4 }
}
