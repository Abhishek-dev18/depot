package com.depot.app.transport

import com.depot.app.crypto.Direction
import com.depot.app.crypto.decodeCtlFrame
import com.depot.app.crypto.encodeChunkFrame
import com.depot.app.crypto.EncodedChunk
import com.depot.app.crypto.encodeCtlFrame
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import org.json.JSONObject
import org.webrtc.DataChannel

class SessionKeys(val kC2D: ByteArray, val kD2C: ByteArray)

/** protocol.md §5.4 — the intersection of both CAPS governs the session. */
private val OUR_CAPS = JSONObject()
    .put("type", "CAPS")
    .put("protocolVersion", 1)
    .put("compression", org.json.JSONArray(listOf("deflate", "none")))
    .put("maxChunkSize", 1024 * 1024)
    .put("features", org.json.JSONArray(listOf("cdc", "browse")))

/**
 * SCTP will buffer without bound if fed faster than the link drains, and a
 * large file can queue hundreds of megabytes. Pausing above a high-water
 * mark keeps memory flat and lets the transfer track the actual link speed.
 */
private const val BUFFER_HIGH_WATER = 4L * 1024 * 1024
private const val BUFFER_LOW_WATER = 1L * 1024 * 1024

/**
 * The encrypted `ctl` channel (protocol.md §5.3). Each side encrypts with
 * its own directional key under a monotonically increasing counter and
 * rejects any counter it has already accepted, so the relay can neither
 * read control messages nor replay them.
 */
class CtlCodec(
    private val channel: DataChannel,
    keys: SessionKeys,
    isDepot: Boolean,
) {
    private val sendKey = if (isDepot) keys.kD2C else keys.kC2D
    private val sendDirection = if (isDepot) Direction.DEPOT_TO_CLIENT else Direction.CLIENT_TO_DEPOT
    private val recvKey = if (isDepot) keys.kC2D else keys.kD2C
    private val recvDirection = if (isDepot) Direction.CLIENT_TO_DEPOT else Direction.DEPOT_TO_CLIENT

    private val sendCounter = AtomicLong(0)
    private val seen = mutableSetOf<Long>()

    fun send(msg: JSONObject) {
        val plaintext = msg.toString().toByteArray(Charsets.UTF_8)
        val frame = encodeCtlFrame(sendKey, sendDirection, sendCounter.getAndIncrement(), plaintext)
        channel.send(DataChannel.Buffer(ByteBuffer.wrap(frame), true))
    }

    /** Returns null for anything undecryptable, malformed, forged or replayed. */
    fun receive(raw: ByteArray): JSONObject? = try {
        val decoded = decodeCtlFrame(recvKey, recvDirection, raw)
        synchronized(seen) {
            if (!seen.add(decoded.counter)) {
                null // replayed by the relay
            } else {
                JSONObject(String(decoded.plaintext, Charsets.UTF_8))
            }
        }
    } catch (_: Exception) {
        null
    }
}

interface TransferCallbacks {
    fun onManifestSent(transferId: Int, chunkCount: Int)
    fun onChunkSent(index: Int, total: Int, bytesSent: Long, bytesTotal: Long)
    fun onError(message: String)
}

/** A file this Depot is willing to serve. */
class OfferedFile(val name: String, val bytes: ByteArray)

/**
 * Depot side of §5.7: answer REQUEST_FILE with a MANIFEST, then stream
 * whatever chunks NEED asks for. Stays running so it can serve repeated
 * NEED rounds, which is how resumption after a dropped connection works.
 */
class FileSender(
    private val channels: DataChannels,
    private val keys: SessionKeys,
    private val source: DepotSource,
    private val cb: TransferCallbacks,
) {
    private val ctl = CtlCodec(channels.ctl, keys, isDepot = true)
    private val transfers = mutableMapOf<Int, Pair<Manifest, ByteArray>>()
    private var nextTransferId = 1
    private val peerCaps = CompletableDeferred<JSONObject>()

    /** Installs the ctl observer and sends our CAPS. */
    fun start(onCtl: (JSONObject) -> Unit) {
        channels.ctl.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) = Unit
            override fun onStateChange() = Unit
            override fun onMessage(buffer: DataChannel.Buffer) {
                val raw = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                ctl.receive(raw)?.let(onCtl)
            }
        })
        ctl.send(OUR_CAPS)
    }

    suspend fun handle(msg: JSONObject) {
        when (msg.optString("type")) {
            "CAPS" -> if (!peerCaps.isCompleted) peerCaps.complete(msg)
            "LIST" -> handleList(msg)
            "REQUEST_FILE" -> handleRequestFile(msg)
            "NEED" -> handleNeed(msg)
        }
    }

    /** protocol.md §5.9. */
    private fun handleList(msg: JSONObject) {
        val handle = msg.optString("handle")
        val entries = org.json.JSONArray()
        for (entry in runCatching { source.list(handle) }.getOrDefault(emptyList())) {
            val o = JSONObject()
                .put("handle", entry.handle)
                .put("name", entry.name)
                .put("kind", if (entry.isDirectory) "dir" else "file")
            entry.size?.let { o.put("size", it) }
            entry.modifiedAt?.let { o.put("modifiedAt", it) }
            entry.count?.let { o.put("count", it) }
            entries.put(o)
        }
        ctl.send(JSONObject().put("type", "LIST_OK").put("handle", handle).put("entries", entries))
    }

    private suspend fun handleRequestFile(msg: JSONObject) {
        // An absent handle is the pre-§5.9 meaning, "whatever you are
        // offering" — not the empty string, which is a handle the Client
        // could have sent deliberately.
        val handle = if (msg.has("handle")) msg.optString("handle") else null
        val file = try {
            source.open(handle)
        } catch (e: Exception) {
            ctl.send(JSONObject().put("type", "ERROR").put("message", e.message ?: "could not read that file"))
            return
        }
        if (file == null) {
            // Deliberately the same answer for "nothing is offered" and
            // "that is not a handle I issued": a Client should not be able
            // to probe which handles exist.
            ctl.send(JSONObject().put("type", "ERROR").put("message", "no such file"))
            return
        }
        val transferId = nextTransferId++
        // CAPS is exchanged before any REQUEST_FILE, but awaiting rather
        // than assuming means a reordered peer stalls instead of crashing.
        val maxChunkSize = minOf(
            OUR_CAPS.getInt("maxChunkSize"),
            peerCaps.await().optInt("maxChunkSize", 1024 * 1024),
        )
        val manifest = buildManifest(transferId, file.name, file.bytes, cdcParamsForAvg(minOf(64 * 1024, maxChunkSize)))
        transfers[transferId] = manifest to file.bytes
        ctl.send(JSONObject().put("type", "MANIFEST").put("manifest", manifest.toJson()))
        cb.onManifestSent(transferId, manifest.chunkCount)
    }

    private suspend fun handleNeed(msg: JSONObject) {
        val transferId = msg.optInt("transferId", -1)
        val entry = transfers[transferId] ?: return
        val (manifest, bytes) = entry
        val indices = msg.optJSONArray("indices") ?: return

        var bytesSent = 0L
        for (i in 0 until indices.length()) {
            val index = indices.getInt(i)
            val info = manifest.chunks.getOrNull(index) ?: continue
            val plaintext = bytes.copyOfRange(info.offset, info.offset + info.length)

            var payload = plaintext
            var compressed = false
            if (shouldCompress(plaintext)) {
                val packed = compress(plaintext)
                // Only worth it if it actually got smaller.
                if (packed.size < plaintext.size) {
                    payload = packed
                    compressed = true
                }
            }

            val frame = encodeChunkFrame(
                keys.kD2C,
                Direction.DEPOT_TO_CLIENT,
                EncodedChunk(transferId, index, payload, compressed),
            )

            awaitDrain()
            channels.data.send(DataChannel.Buffer(ByteBuffer.wrap(frame), true))

            bytesSent += info.length
            cb.onChunkSent(index, manifest.chunkCount, bytesSent, manifest.size.toLong())
        }
    }

    private suspend fun awaitDrain() {
        if (channels.data.bufferedAmount() < BUFFER_HIGH_WATER) return
        while (channels.data.bufferedAmount() > BUFFER_LOW_WATER) {
            delay(20)
        }
    }

    fun stop() {
        runCatching { channels.ctl.unregisterObserver() }
    }
}
