package com.depot.app.transport

import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import org.webrtc.PeerConnection
import org.webrtc.RTCStatsCollectorCallback
import org.webrtc.RTCStatsReport

/**
 * Adaptive chunk sizing, protocol.md §5.5:
 *   RTT <20ms, loss <0.1%  -> 1 MB
 *   RTT <100ms, loss <1%   -> 256 KB
 *   worse                  -> 32-64 KB
 *
 * EWMA-smoothed measurements, one discrete step per adjustment, a 5s
 * cooldown, and different thresholds for stepping up than down. All four
 * rules exist for the same reason: a link sitting right on a boundary
 * would otherwise flap between tiers, and re-chunking a file is not free.
 *
 * Deliberately the same constants as the web implementation's
 * chunkSize.ts. A Depot and a Client that disagreed about sizing would
 * still interoperate — CAPS bounds it and the manifest carries the actual
 * lengths — but they would behave differently on the same link for no
 * reason anyone could see.
 */
data class NetworkSample(val rttMs: Double, val lossFraction: Double)

private val TIERS = intArrayOf(64 * 1024, 256 * 1024, 1024 * 1024)

class AdaptiveChunkSize(
    private val alpha: Double = 0.3,
    private val cooldownMs: Long = 5_000,
) {
    private var tier = 0
    private var smoothedRtt = 0.0
    private var smoothedLoss = 0.0
    private var initialized = false
    private var lastAdjustedAt = 0L

    fun current(): Int = TIERS[tier]

    @Synchronized
    fun update(sample: NetworkSample, now: Long = System.currentTimeMillis()) {
        if (!initialized) {
            smoothedRtt = sample.rttMs
            smoothedLoss = sample.lossFraction
            initialized = true
            return
        }
        smoothedRtt = alpha * sample.rttMs + (1 - alpha) * smoothedRtt
        smoothedLoss = alpha * sample.lossFraction + (1 - alpha) * smoothedLoss

        if (now - lastAdjustedAt < cooldownMs) return

        if (tier < TIERS.size - 1 && canUpgrade()) {
            tier += 1
            lastAdjustedAt = now
        } else if (tier > 0 && shouldDowngrade()) {
            tier -= 1
            lastAdjustedAt = now
        }
    }

    /** Stricter than the nominal thresholds: clear headroom before stepping up. */
    private fun canUpgrade(): Boolean = when (tier) {
        0 -> smoothedRtt < 80 && smoothedLoss < 0.008
        1 -> smoothedRtt < 15 && smoothedLoss < 0.0008
        else -> false
    }

    /** At or looser than nominal: react to degradation promptly. */
    private fun shouldDowngrade(): Boolean = when (tier) {
        2 -> smoothedRtt >= 20 || smoothedLoss >= 0.001
        1 -> smoothedRtt >= 100 || smoothedLoss >= 0.01
        else -> false
    }
}

/**
 * RTT off the active candidate pair.
 *
 * getStats() exposes no dependable loss fraction for an SCTP data channel,
 * so loss is reported as zero rather than inventing a number sizing cannot
 * actually justify — the same call the web side makes, and the same
 * admission.
 */
suspend fun sampleNetwork(pc: PeerConnection): NetworkSample? {
    val report: RTCStatsReport = suspendCancellableCoroutine { cont ->
        pc.getStats(RTCStatsCollectorCallback { cont.resume(it) })
    }
    val pair = report.statsMap.values.firstOrNull { s ->
        s.type == "candidate-pair" && s.members["state"] == "succeeded"
    } ?: return null
    val rtt = when (val value = pair.members["currentRoundTripTime"]) {
        is Number -> value.toDouble() * 1000.0
        else -> 0.0
    }
    return NetworkSample(rttMs = rtt, lossFraction = 0.0)
}
