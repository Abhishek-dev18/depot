package com.depot.app.storage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * One folder the user has chosen to share (protocol.md §5.9).
 *
 * [treeUri] is a Storage Access Framework tree the app holds a persisted
 * read permission for. Nothing here is secret: it is the list the ACCESS
 * screen shows back to the user, and the point of that screen is that they
 * can see exactly what a Client could ask for.
 */
data class Grant(
    val treeUri: String,
    val label: String,
    val enabled: Boolean,
    val addedAt: Long,
)

/**
 * The grants, and only the grants.
 *
 * Android's Storage Access Framework already forces per-folder consent;
 * the interface spec's position is that this is the feature rather than an
 * apology for it, so the app keeps the list explicit and shows it. A
 * folder that is not in here has no handle, and §5.9 means a Client cannot
 * name one.
 */
object GrantStore {

    private const val PREFS = "depot.grants"
    private const val KEY = "depot.grants.json"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun list(context: Context): List<Grant> {
        val raw = prefs(context).getString(KEY, null) ?: return emptyList()
        val array = JSONArray(raw)
        return (0 until array.length()).map { i ->
            val o = array.getJSONObject(i)
            Grant(
                treeUri = o.getString("treeUri"),
                label = o.getString("label"),
                enabled = o.optBoolean("enabled", true),
                addedAt = o.optLong("addedAt", 0L),
            )
        }
    }

    /** The grants a Client may actually see. */
    fun enabled(context: Context): List<Grant> = list(context).filter { it.enabled }

    private fun write(context: Context, grants: List<Grant>) {
        val array = JSONArray()
        for (g in grants) {
            array.put(
                JSONObject()
                    .put("treeUri", g.treeUri)
                    .put("label", g.label)
                    .put("enabled", g.enabled)
                    .put("addedAt", g.addedAt),
            )
        }
        prefs(context).edit().putString(KEY, array.toString()).apply()
    }

    fun add(context: Context, grant: Grant) {
        write(context, list(context).filterNot { it.treeUri == grant.treeUri } + grant)
    }

    fun setEnabled(context: Context, treeUri: String, enabled: Boolean) {
        write(context, list(context).map { if (it.treeUri == treeUri) it.copy(enabled = enabled) else it })
    }

    fun remove(context: Context, treeUri: String) {
        write(context, list(context).filterNot { it.treeUri == treeUri })
    }
}
