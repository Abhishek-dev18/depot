package com.depot.app.signal

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Go relay decodes these into signal/envelope.go's struct, whose fields
 * are all `omitempty`. A misspelled key here would not error — Signal would
 * simply route nothing, which is far harder to diagnose than a failure.
 *
 * Instrumented because org.json is stubbed in JVM unit tests.
 */
@RunWith(AndroidJUnit4::class)
class EnvelopeTest {

    @Test
    fun omitsAbsentFields() {
        val json = JSONObject(Envelope(type = TYPE_REGISTER, depotId = "abc").toJson())
        assertEquals(TYPE_REGISTER, json.getString("type"))
        assertEquals("abc", json.getString("depotId"))
        // Go's omitempty means a null must not appear as a key at all.
        assertTrue(!json.has("sessionId"))
        assertTrue(!json.has("clientId"))
        assertTrue(!json.has("reason"))
        assertTrue(!json.has("payload"))
    }

    @Test
    fun fieldNamesMatchTheGoServer() {
        val payload = JSONObject().put("clientEk", "ek")
        val json = JSONObject(
            Envelope(
                type = TYPE_CONNECT,
                sessionId = "s",
                depotId = "d",
                clientId = "c",
                reason = "r",
                payload = payload,
            ).toJson(),
        )
        assertEquals(setOf("type", "sessionId", "depotId", "clientId", "reason", "payload"), json.keys().asSequence().toSet())
        assertEquals("ek", json.getJSONObject("payload").getString("clientEk"))
    }

    @Test
    fun parsesServerRepliesAndDistinguishesAbsentFromEmpty() {
        val e = Envelope.fromJson("""{"type":"error","reason":"depot_offline"}""")
        assertEquals(TYPE_ERROR, e.type)
        assertEquals(REASON_DEPOT_OFFLINE, e.reason)
        // optString() would give "" here; absent must stay null.
        assertNull(e.sessionId)
        assertNull(e.payload)
    }

    @Test
    fun roundTripsAnOpaqueRelayPayload() {
        val original = Envelope(
            type = "CHALLENGE",
            clientId = "c1",
            payload = JSONObject().put("depotEk", "dek").put("challengeNonce", "n"),
        )
        val parsed = Envelope.fromJson(original.toJson())
        assertEquals("CHALLENGE", parsed.type)
        assertEquals("c1", parsed.clientId)
        assertEquals("dek", parsed.payload!!.getString("depotEk"))
        assertEquals("n", parsed.payload!!.getString("challengeNonce"))
    }

    @Test
    fun rejectOnErrorThrowsOnlyForErrorEnvelopes() {
        val ok = Envelope(type = TYPE_SESSION_CREATED, sessionId = "s")
        assertEquals(ok, rejectOnError(ok))

        try {
            rejectOnError(Envelope(type = TYPE_ERROR, reason = REASON_RATE_LIMITED))
            throw AssertionError("expected rejectOnError to throw")
        } catch (e: SignalException) {
            assertTrue(e.message!!.contains(REASON_RATE_LIMITED))
        }
    }
}
