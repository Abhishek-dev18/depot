package com.depot.app.transport

import com.depot.app.crypto.Sodium
import com.depot.app.crypto.require
import com.depot.app.crypto.toBase64
import org.json.JSONArray
import org.json.JSONObject

/** protocol.md §5.7 — one entry per content-defined chunk. */
data class ChunkInfo(
    val index: Int,
    val offset: Int,
    val length: Int,
    val hash: String, // base64 BLAKE2b-32
)

data class Manifest(
    val transferId: Int,
    val name: String,
    val size: Int,
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
        chunks.add(ChunkInfo(index, offset, length, hash))
        offset += length
    }
    return Manifest(
        transferId = transferId,
        name = name,
        size = bytes.size,
        chunkCount = chunks.size,
        chunks = chunks,
        fileHash = hashBytes(bytes),
    )
}
