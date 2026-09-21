package com.depot.app.transport

import com.depot.app.crypto.Direction
import com.depot.app.crypto.decodeChunkFrame
import com.depot.app.crypto.decodeCtlFrame
import com.depot.app.crypto.encodeChunkFrame
import com.depot.app.crypto.EncodedChunk
import com.depot.app.crypto.encodeCtlFrame
import java.io.InputStream
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
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
    .put("features", org.json.JSONArray(listOf("cdc", "browse", "upload")))

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
    private val sendLock = Any()

    /*
     * Replay tracking as a sliding window rather than a growing set.
     *
     * Remembering every counter ever accepted is correct and unbounded,
     * and this runs on a phone for as long as a Client stays connected.
     * Counters only increase at the sender, so anything far enough below
     * the highest seen cannot be a legitimate reordering — it is a replay
     * or a frame too late to be worth anything. Refusing those outright
     * bounds the memory without weakening the check.
     */
    private val recent = mutableSetOf<Long>()
    private var highestSeen = -1L

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
        synchronized(recent) {
            if (!accept(decoded.counter)) {
                null // replayed by the relay, or too old to matter
            } else {
                JSONObject(String(decoded.plaintext, Charsets.UTF_8))
            }
        }
    } catch (_: Exception) {
        null
    }

    /** Callers hold the lock on [recent]. */
    private fun accept(counter: Long): Boolean {
        if (counter <= highestSeen - REPLAY_WINDOW) return false
        if (!recent.add(counter)) return false
        if (counter > highestSeen) {
            highestSeen = counter
            // Whatever just fell out of the window is refused by the
            // first test from now on, so it need not be remembered.
            recent.removeAll { it <= highestSeen - REPLAY_WINDOW }
        }
        return true
    }

    private companion object {
        const val REPLAY_WINDOW = 1024L
    }
}

interface TransferCallbacks {
    fun onManifestSent(transferId: Int, chunkCount: Int)
    fun onChunkSent(index: Int, total: Int, bytesSent: Long, bytesTotal: Long)
    fun onError(message: String)

    /** §5.10 — a Client is sending something up. */
    fun onUploadStarted(name: String, chunkCount: Int) = Unit

    /**
     * It arrived, whole and verified. [where] opens it, or is null when
     * the destination has nothing to open with; [folder] is what to call
     * the place it landed, so the phone can say where to look.
     */
    fun onUploadStored(name: String, size: Long, folder: String, where: String?) = Unit
}

/** A file this Depot is willing to serve. */
class OfferedFile(val name: String, val bytes: ByteArray, val mime: String? = null)

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

    /** §5.10 — uploads in flight, by the id this Depot issued. */
    private class Upload(
        val chunks: List<ChunkInfo>,
        val fileHash: String,
        val target: WritableTarget,
        val reserved: String,
        val size: Int,
    ) {
        val have = java.util.concurrent.ConcurrentHashMap<Int, ByteArray>()
        val outstanding = java.util.Collections.synchronizedSet(chunks.map { it.index }.toMutableSet())
    }

    private val uploads = java.util.concurrent.ConcurrentHashMap<Int, Upload>()
    private val nextUploadId = java.util.concurrent.atomic.AtomicInteger(1)
    /**
     * What the peer said it accepts, or the floor until it says.
     *
     * Awaiting CAPS before answering REQUEST_FILE meant a CAPS that
     * never arrived hung the first fetch for ever with nothing on
     * screen to explain it. Starting at §5.5's lowest tier and letting
     * CAPS raise the ceiling costs nothing — the adaptive sizer starts
     * at that tier anyway — and can only ever send less than the peer
     * is willing to take.
     */
    @Volatile
    private var peerMaxChunkSize = 64 * 1024
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
        // §5.10 — uploaded chunks arrive on the same channel served ones
        // go out on. One standing observer rather than one per upload:
        // the channel belongs to the session.
        channels.data.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) = Unit
            override fun onStateChange() = Unit
            override fun onMessage(buffer: DataChannel.Buffer) {
                val raw = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                onUploadChunk(raw)
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
                "CAPS" -> peerMaxChunkSize = msg.optInt("maxChunkSize", 64 * 1024)
                "LIST" -> handleList(msg)
                "REQUEST_FILE" -> handleRequestFile(msg)
                "NEED" -> handleNeed(msg)
                "PUT" -> handlePut(msg)
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
            entry.mime?.let { o.put("mime", it) }
            entry.writable?.let { o.put("writable", it) }
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
        // CAPS bounds this, and is never waited for: see peerMaxChunkSize.
        val maxChunkSize = minOf(OUR_CAPS.getInt("maxChunkSize"), peerMaxChunkSize)
        // §5.5 picks the target size; CAPS bounds it. The manifest
        // carries the real lengths either way, so the two sides never have
        // to agree about sizing — only about what was actually sent.
        val avgSize = minOf(chunkSizer.current(), maxChunkSize)
        val manifest = buildManifestStreaming(transferId, file.name, cdcParamsForAvg(avgSize), file.openStream)
        // Bounded, because a manifest is not small: one entry per chunk,
        // each with a hash, so a 600 MB file is hundreds of them. Held
        // for the life of the connection they accumulate one browse at a
        // time on a device that has the least memory to spare. The oldest
        // is dropped instead; a Client that comes back to it gets "no
        // such file" and re-requests, which §5.7 already handles.
        while (transfers.size >= MAX_LIVE_TRANSFERS) {
            val oldest = transfers.keys.minOrNull() ?: break
            transfers.remove(oldest)
        }
        transfers[transferId] = manifest to file
        ctl.send(JSONObject().put("type", "MANIFEST").put("manifest", manifest.toJson()))
        cb.onManifestSent(transferId, manifest.chunkCount)
    }

    /**
     * protocol.md §5.10 — a Client offering a file.
     *
     * Consent first, before anything is read from the message: a Client
     * must not be able to learn whether a name is taken in a directory it
     * was never allowed to write to.
     */
    private fun handlePut(msg: JSONObject) {
        val target = source.writable(msg.optString("handle"))
        if (target == null) {
            // The same answer for "not a handle", "not a directory" and
            // "not writable" — they must not be distinguishable.
            ctl.send(err("that is not somewhere this Depot accepts files"))
            return
        }

        val name = try {
            validUploadName(msg.optString("name"))
        } catch (e: Exception) {
            ctl.send(err(e.message ?: "that name cannot be used"))
            return
        }

        val size = msg.optLong("size", -1L)
        val chunksJson = msg.optJSONArray("chunks")
        val fileHash = msg.optString("fileHash")
        if (size < 0 || chunksJson == null || fileHash.isEmpty()) {
            ctl.send(err("the manifest is incomplete"))
            return
        }
        if (size > MAX_UPLOAD_BYTES) {
            ctl.send(err("that file is larger than this Depot will accept"))
            return
        }
        if (chunksJson.length() != msg.optInt("chunkCount", -1)) {
            ctl.send(err("the manifest's chunk count does not match its list"))
            return
        }

        // The chunks must tile the file exactly. Anything else
        // reassembles into something that is not the file, and only the
        // whole-file hash would notice — after the whole transfer.
        val wanted = ArrayList<ChunkInfo>(chunksJson.length())
        var offset = 0L
        for (i in 0 until chunksJson.length()) {
            val o = chunksJson.optJSONObject(i) ?: return ctl.send(err("chunk $i is malformed"))
            val length = o.optInt("length", -1)
            val hash = o.optString("hash")
            if (length <= 0 || hash.isEmpty() || o.optInt("index", -1) != i || o.optLong("offset", -1L) != offset) {
                ctl.send(err("chunk $i does not follow the one before it"))
                return
            }
            if (length > OUR_CAPS.getInt("maxChunkSize")) {
                ctl.send(err("chunk $i is larger than CAPS agreed"))
                return
            }
            wanted += ChunkInfo(i, offset, length, hash)
            offset += length
        }
        if (offset != size) {
            ctl.send(err("the chunks cover $offset bytes but the manifest claims $size"))
            return
        }

        // Reserved before a byte arrives, so two uploads racing for one
        // name cannot both believe they have it.
        val reserved = try {
            target.reserve(name)
        } catch (e: Exception) {
            ctl.send(err(e.message ?: "could not create that file"))
            return
        }

        val uploadId = nextUploadId.getAndIncrement()
        uploads[uploadId] = Upload(wanted, fileHash, target, reserved, size.toInt())
        cb.onUploadStarted(reserved, wanted.size)

        val need = org.json.JSONArray()
        for (c in wanted) need.put(c.index)
        ctl.send(JSONObject().put("type", "PUT_OK").put("uploadId", uploadId).put("need", need))
        if (wanted.isEmpty()) finishUpload(uploadId)
    }

    /** Verified whole before it is published — never a plausible partial. */
    private fun finishUpload(uploadId: Int) {
        val upload = uploads.remove(uploadId) ?: return
        val joined = ByteArray(upload.size)
        var at = 0
        for (info in upload.chunks) {
            val part = upload.have[info.index] ?: run {
                ctl.send(err("chunk ${info.index} never arrived"))
                return
            }
            part.copyInto(joined, at)
            at += part.size
        }

        if (hashBytes(joined) != upload.fileHash) {
            ctl.send(err("the whole-file hash did not match; nothing was written"))
            return
        }

        val where = try {
            upload.target.store(upload.reserved, joined)
        } catch (e: Exception) {
            ctl.send(err(e.message ?: "could not write the file"))
            return
        }
        ctl.send(
            JSONObject().put("type", "PUT_DONE").put("uploadId", uploadId).put("name", upload.reserved),
        )
        cb.onUploadStored(upload.reserved, joined.size.toLong(), upload.target.label, where)
    }

    /**
     * A chunk of an upload. Verified as it arrives, so a corrupt one is
     * dropped rather than written and discovered at the end.
     */
    private fun onUploadChunk(raw: ByteArray) {
        val decoded = try {
            decodeChunkFrame(keys.kC2D, Direction.CLIENT_TO_DEPOT, raw)
        } catch (_: Exception) {
            return // no legitimate sender produces a frame we cannot open
        }
        val upload = uploads[decoded.transferId] ?: return
        if (!upload.outstanding.contains(decoded.chunkIndex)) return
        val info = upload.chunks.getOrNull(decoded.chunkIndex) ?: return

        val plaintext = try {
            if (decoded.compressed) decompress(decoded.plaintext) else decoded.plaintext
        } catch (_: Exception) {
            return
        }
        if (hashBytes(plaintext) != info.hash) return

        upload.have[decoded.chunkIndex] = plaintext
        upload.outstanding.remove(decoded.chunkIndex)
        if (upload.outstanding.isEmpty()) finishUpload(decoded.transferId)
    }

    /**
     * protocol.md §5.10 rule 3. Not the security boundary — the
     * destination is a handle this Depot minted, so there is no path to
     * escape from — but a display name carrying a separator is confusing
     * and may be read as a path by something that is not this protocol.
     */
    private fun validUploadName(name: String): String {
        require(name.isNotEmpty()) { "the name is empty" }
        require(name.length <= 255) { "the name is longer than any filesystem will take" }
        require(!name.contains('/') && !name.contains('\\')) { "\"$name\" looks like a path, not a name" }
        require(!name.startsWith(".")) { "\"$name\" starts with a dot" }
        require(name.none { it.code < 0x20 || it.code == 0x7f }) { "the name contains control characters" }
        return name
    }

    private fun err(message: String) = JSONObject().put("type", "ERROR").put("message", message)

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
        transfers.clear()
        // Half-received uploads are dropped rather than written: §5.10
        // publishes nothing it has not verified whole.
        uploads.clear()
        runCatching { channels.data.unregisterObserver() }
        runCatching { channels.ctl.unregisterObserver() }
    }

    private companion object {
        /**
         * How many manifests to keep answerable at once. Resumption needs
         * the current one; several in flight is already unusual.
         */
        const val MAX_LIVE_TRANSFERS = 8

        /**
         * The ceiling on a single upload. It is held whole in memory to
         * be hashed before it is written, which is what "verify before
         * publishing" costs on a device with this little to spare.
         */
        const val MAX_UPLOAD_BYTES = 256L * 1024 * 1024
    }
}
