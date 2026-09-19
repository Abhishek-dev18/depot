package com.depot.app.transport

import com.depot.app.crypto.Sodium
import java.io.InputStream
import com.depot.app.crypto.require
import com.depot.app.crypto.toBase64
import org.json.JSONArray
import org.json.JSONObject

/** protocol.md §5.7 — one entry per content-defined chunk. */
data class ChunkInfo(
    val index: Int,
    // Long, not Int: a Depot serves whatever the user granted, and a 3 GB
    // video would silently wrap a 32-bit offset.
    val offset: Long,
    val length: Int,
    val hash: String, // base64 BLAKE2b-32
)

data class Manifest(
    val transferId: Int,
    val name: String,
    val size: Long,
    val chunkCount: Int,
    val chunks: List<ChunkInfo>,
    val fileHash: String, // base64 BLAKE2b-32 of the whole file
) {
    fun toJson(): JSONObject {
        val array = JSONArray()
        for (c in chunks) {
            array.put(
                JSONObject()
                    .put("index", c.index)
                    .put("offset", c.offset)
                    .put("length", c.length)
                    .put("hash", c.hash),
            )
        }
        return JSONObject()
            .put("transferId", transferId)
            .put("name", name)
            .put("size", size)
            .put("chunkCount", chunkCount)
            .put("chunks", array)
            .put("fileHash", fileHash)
    }
}

fun hashBytes(bytes: ByteArray): String {
    val out = ByteArray(32)
    require(
        Sodium.lazy.cryptoGenericHash(out, 32, bytes, bytes.size.toLong()),
        "crypto_generichash",
    )
    return out.toBase64()
}

/**
 * Chunk boundaries are content-defined and therefore variable-length, so
 * the manifest has to carry each chunk's offset and length rather than
 * letting the receiver compute them.
 */
fun buildManifest(
    transferId: Int,
    name: String,
    bytes: ByteArray,
    cdcParams: CdcParams = DEFAULT_CDC_PARAMS,
): Manifest {
    val lengths = chunkLengths(bytes, cdcParams)
    val chunks = mutableListOf<ChunkInfo>()
    var offset = 0
    for ((index, length) in lengths.withIndex()) {
        val hash = hashBytes(bytes.copyOfRange(offset, offset + length))
        chunks.add(ChunkInfo(index, offset.toLong(), length, hash))
        offset += length
    }
    return Manifest(
        transferId = transferId,
        name = name,
        size = bytes.size.toLong(),
        chunkCount = chunks.size,
        chunks = chunks,
        fileHash = hashBytes(bytes),
    )
}

/**
 * The same manifest, built by reading the file once instead of holding it.
 *
 * This is what lets a Depot serve a file larger than its own heap. The
 * whole-file hash is computed incrementally as the chunks go past, so no
 * step here ever needs more than one chunk in memory.
 *
 * [openStream] rather than a stream, because §5.7 needs a second pass over
 * the same bytes to answer NEED, and a consumed stream cannot be rewound.
 */
fun buildManifestStreaming(
    transferId: Int,
    name: String,
    cdcParams: CdcParams,
    openStream: () -> InputStream,
): Manifest {
    val state = ByteArray(Sodium.lazy.cryptoGenericHashStateBytes())
    require(Sodium.lazy.cryptoGenericHashInit(state, 32), "crypto_generichash_init")

    val chunks = mutableListOf<ChunkInfo>()
    var offset = 0L
    openStream().use { input ->
        chunkStream(input, cdcParams) { chunk ->
            require(
                Sodium.lazy.cryptoGenericHashUpdate(state, chunk, chunk.size.toLong()),
                "crypto_generichash_update",
            )
            chunks.add(ChunkInfo(chunks.size, offset, chunk.size, hashBytes(chunk)))
            offset += chunk.size
        }
    }

    val fileHash = ByteArray(32)
    require(Sodium.lazy.cryptoGenericHashFinal(state, fileHash, 32), "crypto_generichash_final")

    return Manifest(
        transferId = transferId,
        name = name,
        size = offset,
        chunkCount = chunks.size,
        chunks = chunks,
        fileHash = fileHash.toBase64(),
    )
}
