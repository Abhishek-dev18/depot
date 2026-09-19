package com.depot.app.transport

import java.io.ByteArrayInputStream
import java.io.InputStream
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The invariant the whole streaming path rests on.
 *
 * §5.7 reads a file twice — once to build the manifest, once to answer
 * NEED — and the manifest's offsets and hashes only describe the second
 * pass if both produce the same boundaries. They also have to match what
 * the array chunker produces, because the web side and the shared test
 * vectors are built from that one.
 *
 * If this ever fails, chunks arrive with the wrong bytes and every hash
 * check downstream fails with nothing to say about why.
 */
class ChunkStreamTest {

    private fun pseudoRandom(size: Int, seed: Int = 1): ByteArray {
        var a = seed
        val out = ByteArray(size)
        for (i in 0 until size) {
            a += 0x6D2B79F5.toInt()
            var t = (a xor (a ushr 15)) * (1 or a)
            t = (t + ((t xor (t ushr 7)) * (61 or t))) xor t
            out[i] = ((t xor (t ushr 14)) and 0xff).toByte()
        }
        return out
    }

    private fun streamedLengths(bytes: ByteArray, params: CdcParams, input: InputStream? = null): List<Int> {
        val lengths = mutableListOf<Int>()
        chunkStream(input ?: ByteArrayInputStream(bytes), params) { lengths.add(it.size) }
        return lengths
    }

    private fun streamedBytes(bytes: ByteArray, params: CdcParams): ByteArray {
        val out = ArrayList<Byte>(bytes.size)
        chunkStream(ByteArrayInputStream(bytes), params) { chunk -> chunk.forEach(out::add) }
        return out.toByteArray()
    }

    @Test
    fun streamingProducesTheSameBoundariesAsTheArrayChunker() {
        val params = cdcParamsForAvg(64 * 1024)
        for (seed in 1..4) {
            val bytes = pseudoRandom(700 * 1024, seed)
            assertEquals(
                "seed $seed",
                chunkLengths(bytes, params),
                streamedLengths(bytes, params),
            )
        }
    }

    @Test
    fun theSameHoldsAcrossChunkSizeTiers() {
        val bytes = pseudoRandom(3 * 1024 * 1024, 11)
        for (avg in listOf(64 * 1024, 256 * 1024, 1024 * 1024)) {
            val params = cdcParamsForAvg(avg)
            assertEquals("avg $avg", chunkLengths(bytes, params), streamedLengths(bytes, params))
        }
    }

    @Test
    fun theChunksReassembleToTheOriginal() {
        val bytes = pseudoRandom(300 * 1024, 5)
        assertEquals(
            bytes.toList(),
            streamedBytes(bytes, cdcParamsForAvg(64 * 1024)).toList(),
        )
    }

    @Test
    fun aStreamThatReturnsShortReadsStillChunksIdentically() {
        // Content providers are under no obligation to fill the buffer,
        // and a chunker that assumed they would would cut in the wrong
        // places only on real devices.
        val bytes = pseudoRandom(400 * 1024, 9)
        val params = cdcParamsForAvg(64 * 1024)
        val stingy = object : InputStream() {
            private val inner = ByteArrayInputStream(bytes)
            override fun read(): Int = inner.read()
            override fun read(b: ByteArray, off: Int, len: Int): Int =
                inner.read(b, off, minOf(len, 1024))
        }
        assertEquals(chunkLengths(bytes, params), streamedLengths(bytes, params, stingy))
    }

    @Test
    fun anEmptyFileProducesNoChunks() {
        assertEquals(emptyList<Int>(), streamedLengths(ByteArray(0), cdcParamsForAvg(64 * 1024)))
    }

    @Test
    fun aFileSmallerThanOneChunkIsOneChunk() {
        val bytes = pseudoRandom(900, 3)
        assertEquals(listOf(900), streamedLengths(bytes, cdcParamsForAvg(64 * 1024)))
    }
}
