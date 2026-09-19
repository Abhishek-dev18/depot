package com.depot.app.transport

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import com.depot.app.crypto.randomBytes
import com.depot.app.storage.GrantStore
import java.util.concurrent.ConcurrentHashMap

/** protocol.md §5.9 — one row of a directory listing. */
data class DirEntry(
    val handle: String,
    val name: String,
    val isDirectory: Boolean,
    val size: Long? = null,
    val modifiedAt: Long? = null,
    val count: Int? = null,
)

/**
 * What this Depot exposes to a Client (protocol.md §5.9). The empty string
 * lists the grants themselves; any other handle is one this Depot minted.
 */
interface DepotSource {
    fun list(handle: String): List<DirEntry>

    /** Null means "no such file", which is also the answer for a handle we never issued. */
    fun open(handle: String?): OfferedFile?
}

/** What a handle points at. Never sent anywhere. */
private data class Location(val treeUri: Uri, val documentId: String, val isDirectory: Boolean)

/**
 * The real Depot's source: the folders the user granted, plus whichever
 * single file they picked directly.
 *
 * Handles are random, minted here, and live only as long as this object.
 * That is the whole of the access control, and it is deliberately not a
 * path check: a Client never names a location, it can only echo back
 * something this Depot already decided to tell it about. There is no
 * traversal to get wrong because there is no path to parse — the one rule
 * to keep is that nothing outside a grant ever gets a handle.
 */
class AndroidDepotSource(
    private val context: Context,
    private val offered: () -> OfferedFile?,
) : DepotSource {

    private val handles = ConcurrentHashMap<String, Location>()

    /** The pre-§5.9 REQUEST_FILE, which names nothing at all. */
    private val offeredHandle = "offered"

    private fun mint(location: Location): String {
        val handle = Base64.encodeToString(randomBytes(12), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        handles[handle] = location
        return handle
    }

    override fun list(handle: String): List<DirEntry> {
        if (handle.isEmpty()) return listRoots()
        val location = handles[handle] ?: return emptyList()
        if (!location.isDirectory) return emptyList()
        return listChildren(location.treeUri, location.documentId)
    }

    private fun listRoots(): List<DirEntry> {
        val roots = GrantStore.enabled(context).mapNotNull { grant ->
            val treeUri = runCatching { Uri.parse(grant.treeUri) }.getOrNull() ?: return@mapNotNull null
            val documentId = runCatching { DocumentsContract.getTreeDocumentId(treeUri) }.getOrNull()
                ?: return@mapNotNull null
            DirEntry(
                handle = mint(Location(treeUri, documentId, isDirectory = true)),
                name = grant.label,
                isDirectory = true,
                count = countChildren(treeUri, documentId),
            )
        }

        // The single picked file, if there is one, sits alongside the
        // folders rather than replacing them.
        val file = offered()
        if (file == null) return roots
        return roots + DirEntry(
            handle = offeredHandle,
            name = file.name,
            isDirectory = false,
            size = file.bytes.size.toLong(),
        )
    }

    private fun childrenUri(treeUri: Uri, documentId: String): Uri =
        DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId)

    private fun countChildren(treeUri: Uri, documentId: String): Int? = runCatching {
        context.contentResolver.query(
            childrenUri(treeUri, documentId),
            arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID),
            null,
            null,
            null,
        )?.use { it.count }
    }.getOrNull()

    private fun listChildren(treeUri: Uri, documentId: String): List<DirEntry> = runCatching {
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        context.contentResolver.query(childrenUri(treeUri, documentId), projection, null, null, null)?.use { c ->
            val idCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val nameCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            val mimeCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
            val sizeCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE)
            val modifiedCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_LAST_MODIFIED)

            val out = ArrayList<DirEntry>(c.count)
            while (c.moveToNext()) {
                val childId = c.getString(idCol) ?: continue
                val isDir = c.getString(mimeCol) == DocumentsContract.Document.MIME_TYPE_DIR
                out += DirEntry(
                    handle = mint(Location(treeUri, childId, isDir)),
                    name = c.getString(nameCol) ?: childId,
                    isDirectory = isDir,
                    size = if (isDir || c.isNull(sizeCol)) null else c.getLong(sizeCol),
                    modifiedAt = if (c.isNull(modifiedCol)) null else c.getLong(modifiedCol),
                )
            }
            // Folders first, then by name — the order a person expects,
            // not whatever order the provider happened to return.
            out.sortedWith(compareByDescending<DirEntry> { it.isDirectory }.thenBy { it.name.lowercase() })
        } ?: emptyList()
    }.getOrElse { emptyList() }

    override fun open(handle: String?): OfferedFile? {
        if (handle == null || handle == offeredHandle) return offered()
        val location = handles[handle] ?: return null
        if (location.isDirectory) return null
        return readDocument(location)
    }

    private fun readDocument(location: Location): OfferedFile {
        val uri = DocumentsContract.buildDocumentUriUsingTree(location.treeUri, location.documentId)
        val resolver = context.contentResolver

        val name = resolver.query(uri, null, null, null, null)?.use { c ->
            val index = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (index >= 0 && c.moveToFirst()) c.getString(index) else null
        } ?: "file"

        // §5.7 is streamed on the wire but assembled in memory here, which
        // is the one place this implementation cannot serve what its own
        // interface shows: a 600 MB video would take the process down.
        // Refusing loudly beats an OutOfMemoryError that kills a Depot
        // other people are connected to.
        val size = resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
            val index = c.getColumnIndex(OpenableColumns.SIZE)
            if (index >= 0 && c.moveToFirst() && !c.isNull(index)) c.getLong(index) else -1L
        } ?: -1L
        if (size > maxServableBytes()) {
            throw IllegalStateException(
                "$name is ${size / (1024 * 1024)} MB; this build reads a whole file into memory " +
                    "and can serve at most ${maxServableBytes() / (1024 * 1024)} MB",
            )
        }

        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
            ?: throw IllegalStateException("could not open $name")
        return OfferedFile(name, bytes)
    }

    /**
     * A quarter of the heap. Chunking, compression and the outgoing frame
     * all need room beyond the file itself, so the ceiling is well under
     * what would fit exactly once.
     */
    private fun maxServableBytes(): Long = Runtime.getRuntime().maxMemory() / 4
}

/** What the ACCESS screen shows under a grant's name. */
data class GrantStats(val files: Int, val bytes: Long)

/**
 * Counts a granted folder's immediate children and adds up their sizes.
 *
 * Immediate children only, not the whole tree: the figure is there to give
 * a person a sense of what they have shared, and walking a deep photo
 * library to refine it would cost far more than the refinement is worth.
 */
fun grantStats(context: Context, treeUri: Uri): GrantStats? = runCatching {
    val documentId = DocumentsContract.getTreeDocumentId(treeUri)
    val projection = arrayOf(
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
    )
    context.contentResolver.query(
        DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId),
        projection,
        null,
        null,
        null,
    )?.use { c ->
        val mimeCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
        val sizeCol = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE)
        var files = 0
        var bytes = 0L
        while (c.moveToNext()) {
            if (c.getString(mimeCol) == DocumentsContract.Document.MIME_TYPE_DIR) continue
            files++
            if (!c.isNull(sizeCol)) bytes += c.getLong(sizeCol)
        }
        GrantStats(files, bytes)
    }
}.getOrNull()

/** Serves one file and nothing else — what the app did before §5.9. */
class SingleFileSource(private val offered: () -> OfferedFile?) : DepotSource {
    override fun list(handle: String): List<DirEntry> {
        if (handle.isNotEmpty()) return emptyList()
        val file = offered() ?: return emptyList()
        return listOf(DirEntry("offered", file.name, isDirectory = false, size = file.bytes.size.toLong()))
    }

    override fun open(handle: String?): OfferedFile? =
        if (handle == null || handle == "offered") offered() else null
}
