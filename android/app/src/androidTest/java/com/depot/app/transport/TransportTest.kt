package com.depot.app.transport

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.depot.app.crypto.randomBytes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TransportTest {

    /** Deterministic filler so failures are reproducible. */
    private fun pseudoRandom(n: Int, seed: Int = 1): ByteArray {
        var a = seed
        val out = ByteArray(n)
        for (i in out.indices) {
            a = a * 1664525 + 1013904223
            out[i] = (a ushr 24).toByte()
        }
        return out
    }

    @Test
    fun chunkLengthsCoverTheInputExactly() {
        val bytes = pseudoRandom(700 * 1024)
        val lengths = chunkLengths(bytes)
        // Losing or duplicating a byte here would corrupt every transfer.
        assertEquals(bytes.size, lengths.sum())
        assertTrue(lengths.isNotEmpty())
    }

    @Test
    fun chunkSizesRespectMinAndMax() {
        val params = CdcParams(minSize = 4 * 1024, avgSize = 16 * 1024, maxSize = 64 * 1024)
        val lengths = chunkLengths(pseudoRandom(500 * 1024, seed = 7), params)
        for (length in lengths.dropLast(1)) {
            assertTrue("chunk $length below minSize", length >= params.minSize)
            assertTrue("chunk $length above maxSize", length <= params.maxSize)
        }
    }

    @Test
    fun chunkingIsDeterministic() {
        val bytes = pseudoRandom(300 * 1024, seed = 3)
        assertEquals(chunkLengths(bytes), chunkLengths(bytes))
    }

    @Test
    fun insertingBytesOnlyPerturbsNearbyBoundaries() {
        // The whole reason for content-defined chunking: an insertion near
        // the start must not renumber every chunk after it.
        val original = pseudoRandom(600 * 1024, seed = 11)
        val modified = ByteArray(original.size + 64)
        original.copyInto(modified, 0, 0, 1000)
        pseudoRandom(64, seed = 99).copyInto(modified, 1000)
        original.copyInto(modified, 1064, 1000)

        val a = chunkLengths(original)
        val b = chunkLengths(modified)
        val sharedTail = a.reversed().zip(b.reversed()).takeWhile { (x, y) -> x == y }.count()
        assertTrue("expected shared trailing boundaries, got $sharedTail", sharedTail > a.size / 2)
    }

    @Test
    fun compressionRoundTripsAndShrinksRepetitiveData() {
        val repetitive = ByteArray(64 * 1024) { (it % 16).toByte() }
        assertTrue(shouldCompress(repetitive))
        val packed = compress(repetitive)
        assertTrue("expected compression to shrink it", packed.size < repetitive.size)
        assertEquals(repetitive.toList(), decompress(packed).toList())
    }

    @Test
    fun highEntropyDataIsNotCompressed() {
        // Random bytes only get bigger, so §5.6 gates on entropy.
        val random = randomBytes(64 * 1024)
        assertTrue(estimateEntropy(random) > 7.5)
        assertTrue(!shouldCompress(random))
    }

    @Test
    fun manifestHashesEveryChunkAndTheWholeFile() {
        val bytes = pseudoRandom(200 * 1024, seed = 5)
        val manifest = buildManifest(transferId = 1, name = "test.bin", bytes = bytes)

        assertEquals(bytes.size.toLong(), manifest.size)
        assertEquals(manifest.chunks.size, manifest.chunkCount)
        assertEquals(hashBytes(bytes), manifest.fileHash)

        var offset = 0
        for (chunk in manifest.chunks) {
            assertEquals(offset.toLong(), chunk.offset)
            assertEquals(
                hashBytes(bytes.copyOfRange(chunk.offset.toInt(), chunk.offset.toInt() + chunk.length)),
                chunk.hash,
            )
            offset += chunk.length
        }
        assertEquals(bytes.size, offset)
    }

    @Test
    fun theStreamedManifestIsIdenticalToTheBufferedOne() {
        // The one that matters for large files: a Depot builds the
        // manifest by reading the file rather than holding it, and the
        // result has to be the same manifest — same cuts, same hashes,
        // same whole-file hash — or the second pass sends bytes that do
        // not match what it promised.
        val bytes = pseudoRandom(900 * 1024, seed = 23)
        val params = cdcParamsForAvg(64 * 1024)

        val buffered = buildManifest(transferId = 7, name = "big.bin", bytes = bytes, cdcParams = params)
        val streamed = buildManifestStreaming(transferId = 7, name = "big.bin", cdcParams = params) {
            java.io.ByteArrayInputStream(bytes)
        }

        assertEquals(buffered.size, streamed.size)
        assertEquals(buffered.chunkCount, streamed.chunkCount)
        assertEquals(buffered.fileHash, streamed.fileHash)
        assertEquals(buffered.chunks, streamed.chunks)
    }

    @Test
    fun manifestSerialisesTheFieldsTheClientNeeds() {
        val manifest = buildManifest(transferId = 9, name = "café ☕.bin", bytes = pseudoRandom(40 * 1024))
        val json = manifest.toJson()

        assertEquals(9, json.getInt("transferId"))
        assertEquals("café ☕.bin", json.getString("name"))
        assertEquals(manifest.chunkCount, json.getJSONArray("chunks").length())

        val first = json.getJSONArray("chunks").getJSONObject(0)
        for (key in listOf("index", "offset", "length", "hash")) {
            assertTrue("manifest chunk missing $key", first.has(key))
        }
    }
}
