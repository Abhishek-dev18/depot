package com.depot.app.transport

import java.io.InputStream

/**
 * Content-defined chunking (FastCDC-style, normalized level 1), per
 * protocol.md §5.7: boundaries depend on local content rather than fixed
 * offsets, so inserting bytes anywhere only perturbs boundaries near the
 * insertion and everything after it re-syncs.
 *
 * A gear-hash table drives a rolling hash; a boundary is declared where the
 * hash satisfies a mask. Two masks are used — stricter before the average
 * size, looser after — which concentrates chunk sizes around avgSize
 * instead of drifting toward the extremes. That is what "normalized" means
 * here.
 */
data class CdcParams(val minSize: Int, val avgSize: Int, val maxSize: Int)

val DEFAULT_CDC_PARAMS = CdcParams(
    minSize = 16 * 1024,
    avgSize = 64 * 1024,
    maxSize = 256 * 1024,
)

/**
 * Mirrors the web implementation's mulberry32. Kotlin's Int is 32-bit and
 * multiplication wraps, which is exactly JavaScript's Math.imul, so the
 * two produce identical tables.
 */
private fun mulberry32(seed: Int): () -> Int {
    var a = seed
    return {
        a += 0x6D2B79F5.toInt()
        var t = (a xor (a ushr 15)) * (1 or a)
        t = (t + ((t xor (t ushr 7)) * (61 or t))) xor t
        t xor (t ushr 14)
    }
}

// Fixed seed: the table only has to be well distributed and identical on
// every run, not secret or unpredictable.
private const val GEAR_SEED = -0x61c88647 // 0x9e3779b9 as a signed Int

private val GEAR: IntArray = IntArray(256).also { table ->
    val rand = mulberry32(GEAR_SEED)
    for (i in 0 until 256) table[i] = rand()
}

private fun maskWithBits(bits: Double): Int {
    val n = Math.round(bits).toInt().coerceIn(1, 30)
    return (1 shl n) - 1
}

/**
 * Length of the next chunk starting at [offset], considering [available]
 * bytes from there.
 *
 * [available] is separate from the array's length so the streaming
 * chunker can pass a window rather than a whole file. The two agree
 * exactly as long as the caller offers at least maxSize bytes whenever
 * more of the file remains — which is what makes a streamed manifest
 * identical to one built from a buffer.
 */
private fun findCutLength(bytes: ByteArray, offset: Int, available: Int, params: CdcParams): Int {
    if (available <= params.minSize) return available
    val end = minOf(available, params.maxSize)

    val avgBits = kotlin.math.ln(params.avgSize.toDouble()) / kotlin.math.ln(2.0)
    val maskS = maskWithBits(avgBits + 2) // stricter: fewer boundaries before avgSize
    val maskL = maskWithBits(avgBits - 2) // looser: more boundaries after avgSize

    var hash = 0
    // Warm up across the mandatory minimum run so those bytes count too.
    for (j in 0 until params.minSize) {
        hash = (hash shl 1) + GEAR[bytes[offset + j].toInt() and 0xff]
    }

    for (i in params.minSize until end) {
        hash = (hash shl 1) + GEAR[bytes[offset + i].toInt() and 0xff]
        val mask = if (i < params.avgSize) maskS else maskL
        if ((hash and mask) == 0) return i + 1
    }
    return end
}

/** Splits bytes into content-defined chunks, returning each length in order. */
fun chunkLengths(bytes: ByteArray, params: CdcParams = DEFAULT_CDC_PARAMS): List<Int> {
    val lengths = mutableListOf<Int>()
    var offset = 0
    while (offset < bytes.size) {
        val length = findCutLength(bytes, offset, bytes.size - offset, params)
        lengths.add(length)
        offset += length
    }
    return lengths
}

/**
 * Splits a stream into content-defined chunks without holding it.
 *
 * A sliding window of twice maxSize means every boundary decision is made
 * with at least maxSize bytes in hand, so the cuts are the same ones
 * [chunkLengths] would make over the whole file — which matters, because
 * the manifest is built in one pass and the bytes are re-read in another,
 * and the two have to agree.
 *
 * [sink] receives each chunk as its own array; it must not retain it
 * beyond the call if the point is to stay off the heap.
 */
fun chunkStream(input: InputStream, params: CdcParams, sink: (ByteArray) -> Unit) {
    val capacity = maxOf(params.maxSize * 2, 64 * 1024)
    val buffer = ByteArray(capacity)
    var filled = 0
    var eof = false

    while (true) {
        while (!eof && filled < capacity) {
            val read = input.read(buffer, filled, capacity - filled)
            if (read < 0) eof = true else filled += read
        }
        if (filled == 0) return

        // Either the buffer is full (so at least maxSize is available) or
        // the file has ended and this is genuinely all that is left.
        val length = findCutLength(buffer, 0, filled, params)
        sink(buffer.copyOfRange(0, length))
        System.arraycopy(buffer, length, buffer, 0, filled - length)
        filled -= length
    }
}

/**
 * protocol.md §5.5 — CDC parameters for a target average chunk size,
 * never exceeding what §5.4's CAPS agreed.
 *
 * [ceiling] matters more than it looks. A chunker asked for an average
 * of N produces chunks of up to 4N — that spread is how content-defined
 * chunking finds its boundaries — while the negotiated maxChunkSize is
 * a hard limit that the peer rejects a whole manifest for exceeding.
 * Deriving the parameters from the average alone therefore built
 * manifests a Client was entitled to refuse, and did: §5.5's tier starts
 * at 64 KB, whose maximum of 256 KB sits comfortably inside a 1 MB
 * ceiling, so the first fetch of a session worked; once the link
 * measured well and the tier climbed to 1 MB the maximum became 4 MB and
 * every fetch after that was refused.
 *
 * So the ceiling caps the maximum, and the average follows it down
 * rather than the other way about.
 */
fun cdcParamsForAvg(avgSize: Int, ceiling: Int = Int.MAX_VALUE): CdcParams {
    val maxSize = minOf(avgSize.toLong() * 4, ceiling.toLong()).toInt()
    val avg = maxOf(1, minOf(avgSize, maxSize / 4))
    return CdcParams(
        // The 1 KB floor the original carried, but never above the
        // maximum — a ceiling small enough to squeeze them together
        // would otherwise produce params that cannot be satisfied.
        minSize = minOf(maxOf(1024, avg / 4), maxSize),
        avgSize = avg,
        maxSize = maxSize,
    )
}
