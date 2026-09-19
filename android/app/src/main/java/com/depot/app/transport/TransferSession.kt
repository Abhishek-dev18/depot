package com.depot.app.transport

import com.depot.app.crypto.Direction
import com.depot.app.crypto.decodeCtlFrame
import com.depot.app.crypto.encodeChunkFrame
import com.depot.app.crypto.EncodedChunk
import com.depot.app.crypto.encodeCtlFrame
import java.io.InputStream
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
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
    private val sendLock = Any()

    fun send(msg: JSONObject) {
        val plaintext = msg.toString().toByteArray(Charsets.UTF_8)
        // Claiming the counter and writing the frame are one step.
        // Atomic on its own only stops two senders taking the same
        // number; it does not stop the one that took the later number
        // finishing its encryption first and reaching the channel ahead
        // of the earlier one. ctl is written from the coroutines that
        // answer requests and from whichever thread picks a file, so
        // that overtaking is not hypothetical.
        synchronized(sendLock) {
            val frame = encodeCtlFrame(sendKey, sendDirection, sendCounter.getAndIncrement(), plaintext)
            channel.send(DataChannel.Buffer(ByteBuffer.wrap(frame), true))
        }
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
    private val scope: CoroutineScope,
    private val cb: TransferCallbacks,
) {
    private val ctl = CtlCodec(channels.ctl, keys, isDepot = true)
    // Every ctl message is handled in its own coroutine, so everything
    // here is touched concurrently.
    private val transfers = java.util.concurrent.ConcurrentHashMap<Int, Pair<Manifest, ServableFile>>()
    private val nextTransferId = java.util.concurrent.atomic.AtomicInteger(1)
    private val peerCaps = CompletableDeferred<JSONObject>()
    private val chunkSizer = AdaptiveChunkSize()
    private var sampler: Job? = null

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

        // protocol.md §5.5. Sampling on a timer rather than once per
        // transfer is what gives the EWMA anything to smooth: a single
        // reading per file would make the averaging decorative.
        sampler = scope.launch {
            while (isActive) {
                runCatching { sampleNetwork(channels.pc) }.getOrNull()?.let(chunkSizer::update)
                delay(2000)
            }
        }
    }

    /**
     * Nothing in here is allowed to fail quietly.
     *
     * Each message runs in its own coroutine, and only `source.open` was
     * guarded — so a stream that would not open, a document the provider
     * had stopped sharing, or anything else thrown while building a
     * manifest or reading a chunk escaped, killed the coroutine, and sent
     * the Client nothing at all. What the Client saw was a transfer card
     * that never moved: it had asked for a file and no MANIFEST, no
     * chunk and no ERROR ever came back. Reloading the page appeared to
     * fix it because that built a whole new session.
     *
     * Now every path ends in either an answer or an ERROR, and the
     * session survives to serve the next request.
     */
    suspend fun handle(msg: JSONObject) {
        val type = msg.optString("type")
        try {
            when (type) {
                "CAPS" -> if (!peerCaps.isCompleted) peerCaps.complete(msg)
                "LIST" -> handleList(msg)
                "REQUEST_FILE" -> handleRequestFile(msg)
                "NEED" -> handleNeed(msg)
            }
        } catch (e: CancellationException) {
            throw e // the session is shutting down; not this Client's problem
        } catch (e: Exception) {
            val reason = e.message ?: e.toString()
            runCatching {
                ctl.send(JSONObject().put("type", "ERROR").put("message", reason))
            }
            cb.onError("$type failed: $reason")
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
        // A throw here is caught by handle(), which answers with ERROR
        // and names the reason rather than a generic stand-in.
        val file = source.open(handle)
        if (file == null) {
            // Deliberately the same answer for "nothing is offered" and
            // "that is not a handle I issued": a Client should not be able
            // to probe which handles exist.
            ctl.send(JSONObject().put("type", "ERROR").put("message", "no such file"))
            return
        }
        val transferId = nextTransferId.getAndIncrement()
        // CAPS is exchanged before any REQUEST_FILE, but awaiting rather
        // than assuming means a reordered peer stalls instead of crashing.
        val maxChunkSize = minOf(
            OUR_CAPS.getInt("maxChunkSize"),
            peerCaps.await().optInt("maxChunkSize", 1024 * 1024),
        )
        // §5.5 picks the target size; CAPS bounds it. The manifest
        // carries the real lengths either way, so the two sides never have
        // to agree about sizing — only about what was actually sent.
        val avgSize = minOf(chunkSizer.current(), maxChunkSize)
        val manifest = buildManifestStreaming(transferId, file.name, cdcParamsForAvg(avgSize), file.openStream)
        transfers[transferId] = manifest to file
        ctl.send(JSONObject().put("type", "MANIFEST").put("manifest", manifest.toJson()))
        cb.onManifestSent(transferId, manifest.chunkCount)
    }

    private suspend fun handleNeed(msg: JSONObject) {
        val transferId = msg.optInt("transferId", -1)
        val entry = transfers[transferId] ?: return
        val (manifest, file) = entry
        val indices = msg.optJSONArray("indices") ?: return

        // Sorted, so the file is read in one forward pass. A Client may
        // ask in any order — a resumed transfer often does — and seeking
        // backwards on a content-provider stream is not something to rely
        // on.
        val wanted = (0 until indices.length())
            .map { indices.getInt(it) }
            .filter { it in manifest.chunks.indices }
            .distinct()
            .sorted()

        var bytesSent = 0L
        file.openStream().use { stream ->
            var position = 0L
            for (index in wanted) {
                val info = manifest.chunks[index]
                skipTo(stream, position, info.offset)
                val plaintext = ByteArray(info.length)
                readFully(stream, plaintext)
                position = info.offset + info.length

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
                cb.onChunkSent(index, manifest.chunkCount, bytesSent, manifest.size)
            }
        }
    }

    /**
     * Forward-only positioning. InputStream.skip() is allowed to skip
     * fewer bytes than asked — or none at all — so a short skip falls back
     * to reading and discarding rather than silently leaving the stream in
     * the wrong place, which would corrupt every chunk after it.
     */
    private fun skipTo(stream: InputStream, from: Long, target: Long) {
        // Allocated per call rather than shared across the class: two
        // transfers run in two coroutines, and one buffer between them
        // would have each reading the other's bytes.
        val scratch = ByteArray(8 * 1024)
        var position = from
        while (position < target) {
            val remaining = target - position
            val skipped = stream.skip(remaining)
            if (skipped > 0) {
                position += skipped
                continue
            }
            val read = stream.read(scratch, 0, minOf(scratch.size.toLong(), remaining).toInt())
            if (read < 0) throw IllegalStateException("file ended before offset $target")
            position += read
        }
    }

    /** read() may return short; a partly filled chunk would fail its hash. */
    private fun readFully(stream: InputStream, into: ByteArray) {
        var filled = 0
        while (filled < into.size) {
            val read = stream.read(into, filled, into.size - filled)
            if (read < 0) throw IllegalStateException("file ended mid-chunk")
            filled += read
        }
    }

    private suspend fun awaitDrain() {
        if (channels.data.bufferedAmount() < BUFFER_HIGH_WATER) return
        while (channels.data.bufferedAmount() > BUFFER_LOW_WATER) {
            delay(20)
        }
    }

    /**
     * protocol.md §5.9 — this Client is looking at a listing that is no
     * longer true. Best effort: one that misses the notice is stale, not
     * broken, and re-listing at any point puts it right.
     */
    fun notifySharedChanged() {
        runCatching { ctl.send(JSONObject().put("type", "SHARED_CHANGED")) }
    }

    fun stop() {
        sampler?.cancel()
        sampler = null
        runCatching { channels.ctl.unregisterObserver() }
    }
}
