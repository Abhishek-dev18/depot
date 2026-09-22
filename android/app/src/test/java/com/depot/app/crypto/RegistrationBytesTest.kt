package com.depot.app.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Test

/**
 * The bytes a Depot signs to register (§7.1) are built separately here,
 * on the web, and in signal/register.go. If they drift apart, no Depot
 * can register at all — so all three are pinned to the same answer.
 */
class RegistrationBytesTest {
    @Test
    fun matchesTheBytesSignalChecks() {
        val label = "depot-signal-register/v1".toByteArray(Charsets.US_ASCII)
        val expected = byteArrayOf(0, 24) + label + byteArrayOf(0, 2, 'A'.code.toByte(), 'B'.code.toByte(), 0, 2, 1, 2)
        assertArrayEquals(expected, registerSigningBytes("AB", byteArrayOf(1, 2)))
    }
}
