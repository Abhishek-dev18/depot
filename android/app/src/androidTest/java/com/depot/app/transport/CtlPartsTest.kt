package com.depot.app.transport

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * §5.8 PARTs. A MANIFEST for a large file does not fit one data-channel
 * message; before these existed, send() refused it and the file could not
 * be sent at all.
 */
@RunWith(AndroidJUnit4::class)
class CtlPartsTest {

    private fun manifestOf(chunks: Int): JSONObject {
        val array = JSONArray()
        for (i in 0 until chunks) {
            array.put(JSONObject().put("index", i).put("offset", i * 32768L).put("length", 32768).put("hash", "h".repeat(43)))
        }
        // A name that is not ASCII, cut wherever the pieces fall.
        return JSONObject().put("type", "MANIFEST").put("manifest", JSONObject().put("name", "très grand 📼.mp4").put("chunks", array))
    }

    @Test
    fun aSmallMessageGoesAsItself() {
        val bytes = """{"type":"LIST","handle":""}""".toByteArray()
        val parts = ctlParts(bytes, id = 0)
        assertEquals(1, parts.size)
        assertTrue(parts[0].contentEquals(bytes))
    }

    @Test
    fun aLargeOneIsCutIntoPiecesThatEachFitAndReassembleExactly() {
        val original = manifestOf(4000) // ~400 KB, far past 64 KB
        val parts = ctlParts(original.toString().toByteArray(Charsets.UTF_8), id = 7)
        assertTrue(parts.size > 1)
        assertTrue("a PART outgrew the channel", parts.all { it.size < 64 * 1024 - 64 })

        val assembler = CtlAssembler()
        val results = parts.map { assembler.offer(JSONObject(String(it, Charsets.UTF_8))) }
        results.dropLast(1).forEach { assertNull(it) }
        assertEquals(original.toString(), results.last().toString())
    }

    @Test
    fun piecesOfTwoMessagesInterleavedStillComeApart() {
        val a = manifestOf(1500)
        val b = manifestOf(1700)
        val pa = ctlParts(a.toString().toByteArray(), id = 1).map { JSONObject(String(it)) }
        val pb = ctlParts(b.toString().toByteArray(), id = 2).map { JSONObject(String(it)) }
        val assembler = CtlAssembler()
        val done = mutableListOf<JSONObject>()
        for (i in 0 until maxOf(pa.size, pb.size)) {
            pa.getOrNull(i)?.let { assembler.offer(it)?.let(done::add) }
            pb.getOrNull(i)?.let { assembler.offer(it)?.let(done::add) }
        }
        assertEquals(setOf(a.toString(), b.toString()), done.map { it.toString() }.toSet())
    }

    @Test
    fun aDuplicatedOrNonsensicalPieceIsIgnored() {
        val assembler = CtlAssembler()
        val part = JSONObject().put("type", "PART").put("id", 3).put("index", 0).put("count", 2).put("data", "e30")
        assertNull(assembler.offer(part))
        assertNull(assembler.offer(part)) // the same piece again
        assertNull(assembler.offer(JSONObject().put("type", "PART").put("id", 3).put("index", 5).put("count", 2).put("data", "")))
        assertNull(assembler.offer(JSONObject().put("type", "PART").put("id", 4).put("index", 0).put("count", 2)))
    }
}
