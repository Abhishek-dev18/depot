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
        assertEquals(offered, source.open(null))
    }

    @Test
    fun aHandleItNeverIssuedResolvesToNothing() {
        // §5.9: handles are minted by the Depot, so anything the Client
        // invents — including something shaped like a path — is simply
        // not in the table. There is no path parsing to get wrong.
        val source = SingleFileSource { file("a.bin", 8) }
        assertNull(source.open("../../etc/passwd"))
        assertNull(source.open("offered-but-not-quite"))
        assertEquals(emptyList<DirEntry>(), source.list("anything"))
    }
}
