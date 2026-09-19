package com.depot.app.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pre-§5.9 path, which has to keep working: a Client that predates
 * browsing sends REQUEST_FILE with no handle at all and expects whatever
 * the Depot is offering.
 *
 * AndroidDepotSource needs a ContentResolver and so belongs in the
 * instrumented suite; this one is pure Kotlin and runs on the JVM.
 */
class SingleFileSourceTest {

    private fun file(name: String, size: Int) = OfferedFile(name, ByteArray(size) { it.toByte() })

    @Test
    fun theRootListsWhateverIsOffered() {
        val source = SingleFileSource { file("report.pdf", 1234) }
        val entries = source.list("")

        assertEquals(1, entries.size)
        assertEquals("report.pdf", entries[0].name)
        assertEquals(1234L, entries[0].size)
        assertTrue(!entries[0].isDirectory)
    }

    @Test
    fun anEmptyDepotListsNothingRatherThanFailing() {
        val source = SingleFileSource { null }
        assertEquals(emptyList<DirEntry>(), source.list(""))
        assertNull(source.open(null))
    }

    @Test
    fun aRequestWithNoHandleStillGetsTheOfferedFile() {
        val offered = file("a.bin", 8)
        val source = SingleFileSource { offered }

        val servable = source.open(null)!!
        assertEquals("a.bin", servable.name)
        assertEquals(8L, servable.size)
        assertEquals(offered.bytes.toList(), servable.openStream().readBytes().toList())
    }

    @Test
    fun theStreamCanBeOpenedMoreThanOnce() {
        // §5.7 reads a file twice — once for the manifest, once to answer
        // NEED — so a source that handed back a single consumed stream
        // would serve an empty second pass.
        val source = SingleFileSource { file("a.bin", 32) }
        val servable = source.open(null)!!
        assertEquals(
            servable.openStream().readBytes().toList(),
            servable.openStream().readBytes().toList(),
        )
    }

    @Test
    fun theHandleIsStableAcrossListings() {
        // A Client that keeps what it received recognises a file by its
        // handle. Re-minting on every listing would tell it that the file
        // it is holding had become something else, on every refresh.
        val source = SingleFileSource { file("a.bin", 8) }
        assertEquals(source.list("")[0].handle, source.list("")[0].handle)
    }

    @Test
    fun aDifferentFileGetsADifferentHandle() {
        // One constant handle for "whatever is picked right now" would
        // let a new file inherit the last one's identity, and a Client
        // holding the old bytes would go on showing them.
        var offered = file("a.bin", 8)
        val source = SingleFileSource { offered }
        val first = source.list("")[0].handle

        offered = file("b.bin", 9)
        val second = source.list("")[0].handle
        assertTrue("a second file must not reuse the first handle", first != second)

        // And the handle for the file that is gone no longer opens
        // anything, rather than quietly serving the new one.
        assertNull(source.open(first))
        assertEquals("b.bin", source.open(second)!!.name)
    }

    @Test
    fun aHandleItNeverIssuedResolvesToNothing() {
        // §5.9: handles are minted by the Depot, so anything the Client
        // invents — including something shaped like a path — is simply
        // not in the table. There is no path parsing to get wrong.
        val source = SingleFileSource { file("a.bin", 8) }
        assertNull(source.open("../../etc/passwd"))
        assertNull(source.open("offered-but-not-quite"))
        assertNull(source.open("offered:8:b.bin"))
        assertEquals(emptyList<DirEntry>(), source.list("anything"))
    }
}
