package com.depot.app.transport

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import java.io.ByteArrayInputStream
import java.io.InputStream
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
    /** §5.10 — directories only, and null means no. */
    val writable: Boolean? = null,
    /**
     * What the storage layer calls this file, where it says.
     *
     * A display name is not always enough for the Client to know what it
     * is holding: providers hand back names with no extension at all, and
     * a Client reading only extensions calls those unpreviewable. The
     * provider already tells us, so passing it on costs nothing.
     */
    val mime: String? = null,
)

/**
 * A file the Depot will serve, read on demand rather than held.
 *
 * [openStream] is called once to build the manifest and again to answer
 * NEED, so it has to be re-openable — a single consumed stream could not
 * do both.
 */
class ServableFile(
    val name: String,
    val size: Long,
    val openStream: () -> InputStream,
)

/**
 * What this Depot exposes to a Client (protocol.md §5.9). The empty string
 * lists the grants themselves; any other handle is one this Depot minted.
 */
interface DepotSource {
    fun list(handle: String): List<DirEntry>

    /** Null means "no such file", which is also the answer for a handle we never issued. */
    fun open(handle: String?): ServableFile?

    /**
     * protocol.md §5.10 — where a Client may put a file.
     *
     * Null is the answer for a handle this Depot never issued, for a
     * file rather than a directory, and for a directory the user has not
     * marked writable. Deliberately the same answer to all three: a
     * Client must not be able to map which handles exist by trying to
     * write to them.
     */
    fun writable(handle: String): WritableTarget? = null
}

/**
 * A directory an upload is allowed to land in (protocol.md §5.10).
 *
 * [reserve] returns a name that is free, which is how "never overwrite"
 * is a property of the destination rather than a rule the transfer has
 * to remember. [store] is called once, with bytes that have already been
 * verified whole.
 */
interface WritableTarget {
    fun reserve(name: String): String
    fun store(name: String, bytes: ByteArray)
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
    /**
     * The files picked directly, in the order they were added.
     *
     * A list rather than one file: replacing the offer every time meant
     * sending a second file was a matter of un-sharing the first, and a
     * Client that had already fetched the first found it gone.
     */
    private val offered: () -> List<OfferedFile>,
) : DepotSource {

    private val handles = ConcurrentHashMap<String, Location>()
    private val minted = ConcurrentHashMap<Location, String>()

    /** The pre-§5.9 REQUEST_FILE, which names nothing at all. */
    private val offeredHandle = "offered"

    /**
     * A handle names a file, so a second pick is a second handle. One
     * constant for "whatever is picked right now" would let a new file
     * inherit the last one's identity at a Client that keeps what it
     * received. Name and length are all that is known without reading
     * the file, so two picks alike in both still collide.
     */
    private fun offeredHandleFor(file: OfferedFile) = "offered:${file.bytes.size}:${file.name}"

    /**
     * The same location keeps the same handle for as long as this source
     * lives.
     *
     * Minting a fresh one per listing looked harmless — every handle is
     * valid and the Client only ever echoes back what it was given. It is
     * not: a Client that holds a received file recognises it by handle,
     * so re-minting on every refresh told it that everything it held had
     * become something else, and a refresh happens on every
     * SHARED_CHANGED and every return to the tab. It also grew this map
     * without bound, a row at a time, for the life of the session.
     *
     * Still unguessable and still session-scoped, which is what the
     * access control actually rests on. Only the churn is gone.
     */
    private fun mint(location: Location): String = minted.computeIfAbsent(location) { key ->
        val handle = Base64.encodeToString(randomBytes(12), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        handles[handle] = key
        handle
    }

    override fun list(handle: String): List<DirEntry> {
        if (handle.isEmpty()) return listRoots()
        val location = handles[handle] ?: return emptyList()
        if (!location.isDirectory) return emptyList()
        return listChildren(location.treeUri, location.documentId)
    }

    /** The grant a location sits inside, or null. */
    private fun grantFor(treeUri: Uri): com.depot.app.storage.Grant? =
        GrantStore.enabled(context).firstOrNull { it.treeUri == treeUri.toString() }

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
                writable = grant.writable,
            )
        }

        // The picked files sit alongside the folders rather than
        // replacing them, in the order they were added.
        return roots + offered().map { file ->
            DirEntry(
                handle = offeredHandleFor(file),
                name = file.name,
                isDirectory = false,
                size = file.bytes.size.toLong(),
                mime = file.mime,
            )
        }
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

            val writableTree = grantFor(treeUri)?.writable == true
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
                    mime = if (isDir) null else c.getString(mimeCol),
                    // Inherited from the grant: marking a folder writable
                    // means the tree under it, which is what the user
                    // sees themselves agreeing to.
                    writable = if (isDir) writableTree else null,
                )
            }
            // Folders first, then by name — the order a person expects,
            // not whatever order the provider happened to return.
            out.sortedWith(compareByDescending<DirEntry> { it.isDirectory }.thenBy { it.name.lowercase() })
        } ?: emptyList()
    }.getOrElse { emptyList() }

    /**
     * protocol.md §5.10. Three refusals, one answer.
     *
     * The consent check is the grant's writable flag; the handle check is
     * what makes it meaningful, since a handle is a location this Depot
     * chose to mention. Neither is a path check, because there is no path
     * — which is the whole point of §5.9.
     */
    override fun writable(handle: String): WritableTarget? {
        val location = handles[handle] ?: return null
        if (!location.isDirectory) return null
        if (grantFor(location.treeUri)?.writable != true) return null
        return SafFolder(context, location)
    }

    override fun open(handle: String?): ServableFile? {
        val files = offered()
        // A null handle, and the bare constant behind it, are §5.9's
        // "whatever you are offering" — which is the first of them, since
        // a Client old enough to send no handle has no way to say which.
        if (handle == null || handle == offeredHandle) return files.firstOrNull()?.servable()
        files.firstOrNull { offeredHandleFor(it) == handle }?.let { return it.servable() }
        val location = handles[handle] ?: return null
        if (location.isDirectory) return null
        return describeDocument(location)
    }

    /**
     * Describes the document without reading it. §5.7 streams, so the
     * bytes are pulled through twice — once to build the manifest, once to
     * answer NEED — and neither pass holds more than a chunk. A 600 MB
     * video is no different here from a 600 KB one.
     */
    private fun describeDocument(location: Location): ServableFile? {
        val uri = DocumentsContract.buildDocumentUriUsingTree(location.treeUri, location.documentId)
        val resolver = context.contentResolver

        val cursor = resolver.query(uri, null, null, null, null) ?: return null
        val (name, size) = cursor.use { c ->
            if (!c.moveToFirst()) return null
            val nameIndex = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIndex = c.getColumnIndex(OpenableColumns.SIZE)
            val name = if (nameIndex >= 0) c.getString(nameIndex) ?: "file" else "file"
            val size = if (sizeIndex >= 0 && !c.isNull(sizeIndex)) c.getLong(sizeIndex) else -1L
            name to size
        }

        return ServableFile(name, size) {
            resolver.openInputStream(uri) ?: throw IllegalStateException("could not open $name")
        }
    }
}

/** An in-memory offer, served through the same streaming path. */
fun OfferedFile.servable(): ServableFile =
    ServableFile(name, bytes.size.toLong()) { ByteArrayInputStream(bytes) }

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
    // As in AndroidDepotSource: the handle names the file, not the slot.
    private fun handleFor(file: OfferedFile) = "offered:${file.bytes.size}:${file.name}"

    override fun list(handle: String): List<DirEntry> {
        if (handle.isNotEmpty()) return emptyList()
        val file = offered() ?: return emptyList()
        return listOf(
            DirEntry(
                handleFor(file),
                file.name,
                isDirectory = false,
                size = file.bytes.size.toLong(),
                mime = file.mime,
            ),
        )
    }

    /**
     * SingleFileSource has no folders, so there is nowhere for an upload
     * to go. The default from DepotSource already answers null; this
     * says so out loud, because "accepts nothing" is the behaviour the
     * protocol asks for by default, not an omission.
     */

    override fun open(handle: String?): ServableFile? {
        val file = offered() ?: return null
        // null and the bare constant are §5.9's "whatever you are offering".
        return if (handle == null || handle == "offered" || handle == handleFor(file)) file.servable() else null
    }
}

/**
 * A granted folder, written through the Storage Access Framework.
 *
 * createDocument takes a display name rather than a path, so it cannot
 * be made to write outside the tree however the name is spelled — and it
 * renames rather than replaces when a name is taken, which is exactly
 * §5.10's "never overwrite". Both are properties of the platform here
 * rather than rules this code has to remember, which is the version of
 * that rule least likely to be got wrong later.
 */
private class SafFolder(
    private val context: Context,
    private val location: Location,
) : WritableTarget {

    /** Set by [reserve], written by [store]. */
    private var pending: Uri? = null
    private var pendingName: String? = null

    override fun reserve(name: String): String {
        val parent = DocumentsContract.buildDocumentUriUsingTree(location.treeUri, location.documentId)
        // The type is what the provider files it under; the name decides
        // what it is called. A generic type keeps the extension intact
        // rather than having the provider append one of its own.
        val uri = DocumentsContract.createDocument(
            context.contentResolver,
            parent,
            "application/octet-stream",
            name,
        ) ?: throw IllegalStateException("could not create a file in that folder")

        pending = uri
        // Whatever it ended up called, which is not always what was
        // asked for — the provider appends when a name is taken.
        val actual = context.contentResolver.query(uri, null, null, null, null)?.use { c ->
            val index = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (c.moveToFirst() && index >= 0) c.getString(index) else null
        } ?: name
        pendingName = actual
        return actual
    }

    override fun store(name: String, bytes: ByteArray) {
        val uri = pending
        if (uri == null || pendingName != name) {
            throw IllegalStateException("store() without a matching reserve()")
        }
        try {
            context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
                ?: throw IllegalStateException("could not open the new file for writing")
        } catch (e: Exception) {
            // A half-written file with a plausible name is worse than no
            // file: §5.10 publishes nothing it has not verified whole.
            runCatching { DocumentsContract.deleteDocument(context.contentResolver, uri) }
            throw e
        } finally {
            pending = null
            pendingName = null
        }
    }
}
