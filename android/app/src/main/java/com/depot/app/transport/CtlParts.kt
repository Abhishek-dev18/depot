package com.depot.app.transport

import com.depot.app.crypto.fromBase64
import com.depot.app.crypto.toBase64
import org.json.JSONObject

/*
 * protocol.md §5.8: a ctl message too large for one data-channel message
 * goes as PARTs — its UTF-8 bytes cut into pieces, each carried as
 * {type: "PART", id, index, count, data: base64} — and the receiver
 * reassembles them into the message they were cut from.
 *
 * A MANIFEST lists every chunk and a LIST_OK every entry, so both grow
 * with the file or the folder, while SCTP holds each message to what it
 * negotiated. Past a few thousand chunks the one message outgrew the
 * channel, send() returned false, and a file of a hundred megabytes or so
 * could not be sent either way.
 */

/** Anything larger is refused rather than gathered: ~500k chunks' worth. */
const val MAX_CTL_MESSAGE_BYTES = 48 * 1024 * 1024

/** Raw bytes per PART — well inside the 64 KB every implementation takes, once base64'd and wrapped. */
const val CTL_PART_BYTES = 16 * 1024

private const val MAX_CTL_ASSEMBLIES = 4

/** [plaintext] as it goes on the wire: itself if it fits, otherwise its PARTs. */
fun ctlParts(plaintext: ByteArray, id: Long, partBytes: Int = CTL_PART_BYTES): List<ByteArray> {
    if (plaintext.size <= partBytes) return listOf(plaintext)
    require(plaintext.size <= MAX_CTL_MESSAGE_BYTES) {
        "a ${plaintext.size} byte message is more than one exchange can describe"
    }
    val count = (plaintext.size + partBytes - 1) / partBytes
    return (0 until count).map { index ->
        val from = index * partBytes
        val to = minOf(plaintext.size, from + partBytes)
        JSONObject()
            .put("type", "PART")
            .put("id", id)
            .put("index", index)
            .put("count", count)
            .put("data", plaintext.copyOfRange(from, to).toBase64())
            .toString()
            .toByteArray(Charsets.UTF_8)
    }
}

/** Gathers PARTs back into the messages they were cut from. */
class CtlAssembler {
    private class Entry(val pieces: Array<ByteArray?>) {
        var have = 0
        var bytes = 0L
    }

    // Insertion-ordered, so the oldest gathering is the one dropped.
    private val assembling = LinkedHashMap<Long, Entry>()

    /**
     * [msg] itself when it is not a PART; the whole message when [msg] is
     * the last piece of one; null while pieces are still to come, or for a
     * PART that makes no sense.
     */
    @Synchronized
    fun offer(msg: JSONObject): JSONObject? {
        if (msg.optString("type") != "PART") return msg
        val id = msg.optLong("id", -1L)
        val index = msg.optInt("index", -1)
        val count = msg.optInt("count", -1)
        val data = if (msg.has("data")) msg.optString("data") else return null
        if (id < 0 || count < 1 || index !in 0 until count) return null
        if (count.toLong() * 1024 > MAX_CTL_MESSAGE_BYTES * 2L) return null

        val entry = assembling[id] ?: Entry(arrayOfNulls(count)).also {
            if (assembling.size >= MAX_CTL_ASSEMBLIES) assembling.remove(assembling.keys.first())
            assembling[id] = it
        }
        if (entry.pieces.size != count || entry.pieces[index] != null) return null

        val piece = try {
            data.fromBase64()
        } catch (_: IllegalArgumentException) {
            return null
        }
        entry.bytes += piece.size
        if (entry.bytes > MAX_CTL_MESSAGE_BYTES) {
            assembling.remove(id)
            return null
        }
        entry.pieces[index] = piece
        entry.have++
        if (entry.have < count) return null

        assembling.remove(id)
        val whole = ByteArray(entry.bytes.toInt())
        var at = 0
        for (p in entry.pieces) {
            p!!.copyInto(whole, at)
            at += p.size
        }
        return JSONObject(String(whole, Charsets.UTF_8))
    }
}
