package com.depot.app.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * These run on the JVM, with no device involved.
 *
 * Everything else in this app needs a handset — libsodium's native
 * library, WebRTC, the camera — so the few pieces of pure logic that can
 * be checked in a second are worth checking here. What they pin down is
 * the interface spec's own notation: "41.2 GB", "612 MB", "6h 12m",
 * "0:09". Those exact shapes are what the design asks for, and they are
 * easy to break without noticing.
 */
class FormatTest {

    @Test
    fun bytesUseDecimalUnitsLikeThePhonesOwnStorageScreen() {
        assertEquals("0 B", formatBytes(0))
        assertEquals("999 B", formatBytes(999))
        assertEquals("1.0 KB", formatBytes(1_000))
        assertEquals("1.5 KB", formatBytes(1_500))
    }

    @Test
    fun oneDecimalBelowAHundredAndNoneAbove() {
        assertEquals("99.9 KB", formatBytes(99_900))
        assertEquals("100 KB", formatBytes(100_000))
        assertEquals("4.2 MB", formatBytes(4_200_000))
        assertEquals("612 MB", formatBytes(612_000_000))
        assertEquals("41.2 GB", formatBytes(41_200_000_000))
    }

    @Test
    fun durationsReadTheWayTheUptimeCellDoes() {
        assertEquals("0s", formatDuration(0))
        assertEquals("45s", formatDuration(45_000))
        assertEquals("1m 5s", formatDuration(65_000))
        assertEquals("6h 12m", formatDuration(22_320_000))
    }

    @Test
    fun etaIsMinutesAndSecondsUntilItIsWorthAnHour() {
        assertEquals("0:09", formatEta(remainingBytes = 900, bytesPerSecond = 100.0))
        assertEquals("1:40", formatEta(remainingBytes = 10_000, bytesPerSecond = 100.0))
        assertEquals("2h 46m", formatEta(remainingBytes = 1_000_000, bytesPerSecond = 100.0))
    }

    @Test
    fun anUnknowableFigureIsAnEmDashRatherThanAZero() {
        // A transfer that has not moved yet has no rate, and printing
        // "0 B/s eta 0:00" would be a confident lie about a stall.
        assertEquals("—", formatRate(0.0))
        assertEquals("—", formatRate(Double.NaN))
        assertEquals("—", formatEta(remainingBytes = 100, bytesPerSecond = 0.0))
        assertEquals("—", formatEta(remainingBytes = 0, bytesPerSecond = 100.0))
    }

    @Test
    fun ratesCarryTheUnit() {
        assertEquals("41.2 MB/s", formatRate(41_200_000.0))
    }

    @Test
    fun lastSeenIsCoarseAndCaps() {
        val now = 1_700_000_000_000L
        assertEquals("JUST NOW", formatLastSeen(now - 60_000, now))
        assertEquals("5M AGO", formatLastSeen(now - 300_000, now))
        assertEquals("2H AGO", formatLastSeen(now - 2 * 3_600_000, now))
        assertEquals("3D AGO", formatLastSeen(now - 3 * 86_400_000L, now))
    }

    @Test
    fun keysAreShortenedForRowsAndGroupedForReadingAcross() {
        val key = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
        assertEquals(43, key.length) // a base64 X25519/Ed25519 public key
        assertEquals("abcdefghijkl…", shortId(key))
        assertEquals("abcd efgh ijkl mnop", fingerprint(key))
        assertEquals("abcd efgh ijkl mnop qrst uvwx", fingerprint(key, groups = 6))
    }

    @Test
    fun aShortIdIsLeftAloneWhenThereIsNothingToTrim() {
        assertEquals("short", shortId("short"))
    }
}
