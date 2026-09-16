package com.depot.app.pairing

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

/** protocol.md §3.1. Instrumented because org.json is stubbed in JVM unit tests. */
@RunWith(AndroidJUnit4::class)
class QrPayloadTest {

    private val valid = """
        {"v":1,"s":"ws://10.0.2.2:8080/ws","id":"c2Vzc2lvbg","ek":"ZWs","ik":"aWs","n":"bm9uY2U"}
    """.trimIndent()

    @Test
    fun parsesAValidPayload() {
        val qr = QrPayload.parse(valid)
        assertEquals(1, qr.v)
        assertEquals("ws://10.0.2.2:8080/ws", qr.signalUrl)
        assertEquals("c2Vzc2lvbg", qr.sessionId)
        assertEquals("ZWs", qr.clientEk)
        assertEquals("aWs", qr.clientIk)
        assertEquals("bm9uY2U", qr.nonce)
    }

    @Test
    fun rejectsNonJson() {
        val e = assertThrows(IllegalArgumentException::class.java) { QrPayload.parse("not json at all") }
        assertEquals("that is not valid QR payload JSON", e.message)
    }

    @Test
    fun rejectsAPayloadMissingKeyMaterial() {
        // Dropping "ek" removes the security anchor — the ephemeral key
        // transferred out-of-band via the camera. Proceeding without it
        // would mean pairing with whatever Signal supplied instead.
        val withoutEk = """{"v":1,"s":"ws://x/ws","id":"a","ik":"b","n":"c"}"""
        val e = assertThrows(IllegalArgumentException::class.java) { QrPayload.parse(withoutEk) }
        assertEquals("QR payload is missing required fields", e.message)
    }

    @Test
    fun refusesAnIncompatibleProtocolVersion() {
        // §3.1: the version exists so this fails cleanly here rather than
        // later as an unexplained SAS mismatch.
        val v2 = valid.replace("\"v\":1", "\"v\":2")
        val e = assertThrows(IllegalArgumentException::class.java) { QrPayload.parse(v2) }
        assertEquals("unsupported protocol version 2", e.message)
    }

    @Test
    fun refusesAPayloadWithNoVersionAtAll() {
        val noVersion = """{"s":"ws://x/ws","id":"a","ek":"b","ik":"c","n":"d"}"""
        assertThrows(IllegalArgumentException::class.java) { QrPayload.parse(noVersion) }
    }
}
