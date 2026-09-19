package com.depot.app.transport

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * protocol.md §5.5's four anti-oscillation rules, which are the whole
 * reason this is not just an if-statement on RTT. A link sitting near a
 * boundary must not flap between tiers, because re-chunking a file costs a
 * full pass over it.
 */
class AdaptiveChunkSizeTest {

    private val tier0 = 64 * 1024
    private val tier1 = 256 * 1024
    private val tier2 = 1024 * 1024

    private fun sizer() = AdaptiveChunkSize()

    @Test
    fun startsAtTheSmallestTier() {
        // Nothing is known about the link yet, so assume the worst.
        assertEquals(tier0, sizer().current())
    }

    @Test
    fun theFirstSampleOnlySeedsTheAverage() {
        val s = sizer()
        s.update(NetworkSample(rttMs = 1.0, lossFraction = 0.0), now = 0)
        assertEquals(tier0, s.current())
    }

    @Test
    fun aFastLinkClimbsOneTierAtATime() {
        val s = sizer()
        s.update(NetworkSample(1.0, 0.0), now = 0)
        s.update(NetworkSample(1.0, 0.0), now = 10_000)
        assertEquals(tier1, s.current())

        // Still inside the cooldown, so no second step yet.
        s.update(NetworkSample(1.0, 0.0), now = 12_000)
        assertEquals(tier1, s.current())

        s.update(NetworkSample(1.0, 0.0), now = 20_000)
        assertEquals(tier2, s.current())
    }

    @Test
    fun aSlowLinkStaysAtTheBottom() {
        val s = sizer()
        var now = 0L
        repeat(6) {
            s.update(NetworkSample(rttMs = 250.0, lossFraction = 0.05), now = now)
            now += 10_000
        }
        assertEquals(tier0, s.current())
    }

    @Test
    fun degradationStepsBackDown() {
        val s = sizer()
        s.update(NetworkSample(1.0, 0.0), now = 0)
        s.update(NetworkSample(1.0, 0.0), now = 10_000)
        s.update(NetworkSample(1.0, 0.0), now = 20_000)
        assertEquals(tier2, s.current())

        // One bad sample is smoothed away; sustained badness is not.
        var now = 30_000L
        repeat(5) {
            s.update(NetworkSample(rttMs = 400.0, lossFraction = 0.05), now = now)
            now += 10_000
        }
        assertEquals(tier0, s.current())
    }

    @Test
    fun aLinkHoveringOnTheBoundaryDoesNotFlap() {
        // The hysteresis rule: stepping up to tier 1 needs RTT under 80ms,
        // but stepping back down needs 100ms. A link at 90ms therefore
        // settles instead of oscillating.
        val s = sizer()
        var now = 0L
        repeat(10) {
            s.update(NetworkSample(rttMs = 90.0, lossFraction = 0.0), now = now)
            now += 10_000
        }
        assertEquals(tier0, s.current())
    }
}
