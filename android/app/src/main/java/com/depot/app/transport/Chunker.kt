package com.depot.app.transport

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

/** Length of the next chunk starting at [offset]. */
private fun findCutLength(bytes: ByteArray, offset: Int, params: CdcParams): Int {
    val remaining = bytes.size - offset
    if (remaining <= params.minSize) return remaining
    val end = minOf(remaining, params.maxSize)

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
        val length = findCutLength(bytes, offset, params)
        lengths.add(length)
        offset += length
    }
    return lengths
}

/** protocol.md §5.5 — CDC parameters for a target average chunk size. */
fun cdcParamsForAvg(avgSize: Int): CdcParams = CdcParams(
    minSize = maxOf(1024, avgSize / 4),
    avgSize = avgSize,
    maxSize = avgSize * 4,
)
