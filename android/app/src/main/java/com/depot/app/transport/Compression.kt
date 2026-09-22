package com.depot.app.transport

import java.io.ByteArrayOutputStream
import java.util.zip.DataFormatException
import java.util.zip.Deflater
import java.util.zip.Inflater

/**
 * protocol.md §5.6: sample the start of a chunk, estimate entropy, and skip
 * compression for high-entropy data — already-compressed, encrypted or
 * random bytes only get bigger and cost CPU.
 *
 * The spec names zstd level 3. Both implementations use raw DEFLATE
 * instead — the browser's CompressionStream('deflate-raw'), and
 * Deflater(nowrap = true) here, which produce the same wire format. Same
 * entropy gate, same FLAG_COMPRESSED bit. Swapping in real zstd later
 * touches only this file and its web counterpart.
 */
private const val ENTROPY_SAMPLE_SIZE = 64 * 1024
private const val ENTROPY_THRESHOLD_BITS_PER_BYTE = 7.5

fun estimateEntropy(sample: ByteArray): Double {
    if (sample.isEmpty()) return 0.0
    val counts = IntArray(256)
    for (b in sample) counts[b.toInt() and 0xff]++
    var entropy = 0.0
    val total = sample.size.toDouble()
    for (c in counts) {
        if (c == 0) continue
        val p = c / total
        entropy -= p * (kotlin.math.ln(p) / kotlin.math.ln(2.0))
    }
    return entropy
}

fun shouldCompress(bytes: ByteArray): Boolean {
    val sample = if (bytes.size <= ENTROPY_SAMPLE_SIZE) bytes else bytes.copyOfRange(0, ENTROPY_SAMPLE_SIZE)
    return estimateEntropy(sample) < ENTROPY_THRESHOLD_BITS_PER_BYTE
}

fun compress(bytes: ByteArray): ByteArray {
    // nowrap = true is raw DEFLATE, matching the web's 'deflate-raw'.
    val deflater = Deflater(Deflater.DEFAULT_COMPRESSION, true)
    try {
        deflater.setInput(bytes)
        deflater.finish()
        val out = ByteArrayOutputStream(bytes.size)
        val buffer = ByteArray(16 * 1024)
        while (!deflater.finished()) {
            val n = deflater.deflate(buffer)
            if (n == 0 && deflater.needsInput()) break
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    } finally {
        deflater.end()
    }
}

/**
 * Inflates one chunk, refusing to produce more than [maxBytes] — the
 * chunk's length from the manifest, which is all a genuine one inflates
 * to. Deflate reaches about 1000:1, so without a limit one small frame can
 * demand tens of megabytes before its hash is ever checked.
 */
fun decompress(bytes: ByteArray, maxBytes: Int = Int.MAX_VALUE): ByteArray {
    val inflater = Inflater(true)
    try {
        inflater.setInput(bytes)
        val out = ByteArrayOutputStream(minOf(maxBytes.toLong(), bytes.size * 2L).toInt())
        val buffer = ByteArray(16 * 1024)
        while (!inflater.finished()) {
            val n = inflater.inflate(buffer)
            if (n == 0 && (inflater.needsInput() || inflater.needsDictionary())) break
            if (out.size().toLong() + n > maxBytes) {
                throw DataFormatException("chunk inflates past the $maxBytes bytes its manifest allows")
            }
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    } finally {
        inflater.end()
    }
}
