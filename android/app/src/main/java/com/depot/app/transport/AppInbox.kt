package com.depot.app.transport

import android.content.Context
import java.io.File

/**
 * Where a Client's files land when no folder has been granted.
 *
 * protocol.md §5.10 made the only destination a folder the user had
 * granted *and* marked writable. That is the right rule for writing into
 * someone's Downloads; it is the wrong rule for receiving at all,
 * because it made sending from a browser conditional on a setup step
 * taken on the phone, for a file the phone's owner had just asked for.
 *
 * This is the other destination: a directory inside the app's own
 * private storage, which needs no permission because nothing outside
 * this app can read it either. A paired Client — one that has been
 * through the §3 SAS comparison and holds a credential — may put files
 * here. Nothing reaches the user's own storage until they choose to save
 * it, so the consent that the writable flag was protecting is still
 * asked for, just at the moment it means something.
 */
class AppInbox(private val context: Context) : WritableTarget {

    override val label: String = INBOX_LABEL

    private val dir: File
        get() = File(context.filesDir, DIR_NAME).apply { mkdirs() }

    /**
     * Everything received so far, newest first.
     *
     * Empty files are swept rather than listed. A reservation that was
     * never filled is not a received file, and until abandon() existed
     * every failed upload left one — so this also quietly clears what
     * earlier versions left behind.
     */
    fun files(): List<File> {
        val all = dir.listFiles() ?: return emptyList()
        return all
            .filter { file ->
                if (file.isFile && file.length() == 0L) {
                    file.delete()
                    false
                } else {
                    file.isFile
                }
            }
            .sortedByDescending { it.lastModified() }
    }

    /** Drops everything received. Settings' "clear all". */
    fun clear(): Int {
        val doomed = files()
        var gone = 0
        for (file in doomed) if (file.delete()) gone++
        return gone
    }

    fun find(name: String): File? = files().firstOrNull { it.name == name }

    fun delete(name: String): Boolean = find(name)?.delete() ?: false

    /**
     * A name that is free, so "never overwrite" is a property of the
     * destination rather than a rule each transfer has to remember.
     *
     * The name is also flattened to its last path segment first: a
     * Client cannot be trusted to have sent something that stays inside
     * this directory, and validateUploadName on the wire is a check, not
     * a guarantee about every future caller.
     */
    override fun reserve(name: String): String {
        val safe = name.substringAfterLast('/').substringAfterLast('\\').ifBlank { "file" }
        val free = freeName(safe)
        File(dir, free).createNewFile()
        return free
    }

    override fun abandon(name: String) {
        // Only if it is still the empty placeholder reserve() made. A
        // file with bytes in it was stored by something and is not this
        // upload's to remove.
        val file = File(dir, name)
        if (file.isFile && file.length() == 0L) file.delete()
    }

    override fun store(name: String, from: File): String {
        val target = File(dir, name)
        if (target.parentFile?.canonicalFile != dir.canonicalFile) {
            throw IllegalStateException("that name does not stay inside the inbox")
        }
        try {
            // A rename when the scratch file is on the same storage, which
            // it normally is; a copy when it is not. Either way the name
            // only ever holds the whole file or nothing — renaming over the
            // empty reservation is the step that makes it appear.
            if (!from.renameTo(target)) {
                from.inputStream().use { input -> target.outputStream().use { input.copyTo(it) } }
            }
        } catch (e: Exception) {
            // A half-written file with a plausible name is worse than no
            // file: §5.10 publishes nothing it has not verified whole.
            target.delete()
            throw e
        }
        return target.absolutePath
    }

    /** "report.pdf" taken becomes "report (1).pdf", as the SAF path does. */
    private fun freeName(name: String): String {
        if (!File(dir, name).exists()) return name
        val dot = name.lastIndexOf('.')
        val stem = if (dot <= 0) name else name.substring(0, dot)
        val ext = if (dot <= 0) "" else name.substring(dot)
        var n = 1
        while (File(dir, "$stem ($n)$ext").exists()) n++
        return "$stem ($n)$ext"
    }

    companion object {
        /** The handle a Client sees. Fixed, because this root always exists. */
        const val HANDLE = "app-inbox"
        const val INBOX_LABEL = "Depot inbox"
        private const val DIR_NAME = "inbox"
    }
}
