package com.depot.app.storage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Depot side, protocol.md §3.5: one record per paired Client. */
data class DeviceRecord(
    val clientIdentityPub: String, // base64
    val label: String,
    val createdAt: Long,
    val lastSeenAt: Long,
    val revoked: Boolean,
)

/**
 * Everything here is public: Client public keys, labels and timestamps. It
 * is stored in plain SharedPreferences deliberately — unlike the identity
 * key, none of it is secret, and the Depot's decision to trust a device is
 * enforced by §4's signature check, not by hiding this list.
 */
object DeviceStore {

    private const val PREFS = "depot.devices"
    private const val KEY = "depot.devices.json"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun list(context: Context): List<DeviceRecord> {
        val raw = prefs(context).getString(KEY, null) ?: return emptyList()
        val array = JSONArray(raw)
        return (0 until array.length()).map { i ->
            val o = array.getJSONObject(i)
            DeviceRecord(
                clientIdentityPub = o.getString("clientIdentityPub"),
                label = o.getString("label"),
                createdAt = o.getLong("createdAt"),
                lastSeenAt = o.getLong("lastSeenAt"),
                revoked = o.getBoolean("revoked"),
            )
        }
    }

    private fun write(context: Context, devices: List<DeviceRecord>) {
        val array = JSONArray()
        for (d in devices) {
            array.put(
                JSONObject()
                    .put("clientIdentityPub", d.clientIdentityPub)
                    .put("label", d.label)
                    .put("createdAt", d.createdAt)
                    .put("lastSeenAt", d.lastSeenAt)
                    .put("revoked", d.revoked),
            )
        }
        prefs(context).edit().putString(KEY, array.toString()).apply()
    }

    /** Forgets every device, for when the identity they were paired with is gone. */
    fun clear(context: Context) {
        prefs(context).edit().remove(KEY).commit()
    }

    fun save(context: Context, device: DeviceRecord) {
        write(context, list(context).filterNot { it.clientIdentityPub == device.clientIdentityPub } + device)
    }

    fun get(context: Context, clientIdentityPub: String): DeviceRecord? =
        list(context).find { it.clientIdentityPub == clientIdentityPub }

    /** protocol.md §6 — the Depot refusing the §4 handshake is what revocation actually is. */
    fun revoke(context: Context, clientIdentityPub: String) {
        val device = get(context, clientIdentityPub) ?: return
        save(context, device.copy(revoked = true))
    }

    /**
     * The Client never tells the Depot what it is called. That is
     * deliberate — a self-reported name is worth nothing, since a Client
     * could claim to be anything — so the name is whatever the person
     * holding the phone decides to write down.
     */
    fun rename(context: Context, clientIdentityPub: String, label: String) {
        val device = get(context, clientIdentityPub) ?: return
        save(context, device.copy(label = label.trim().ifBlank { device.label }))
    }

    /**
     * Drops the record entirely.
     *
     * Different from [revoke], which keeps the device listed as refused —
     * a record worth having, since it says a device was once trusted and
     * no longer is. Forgetting is for when the list itself should stop
     * mentioning it. The Client is then simply unknown, and pairing again
     * from a fresh code would work exactly as it did the first time.
     */
    fun forget(context: Context, clientIdentityPub: String) {
        write(context, list(context).filterNot { it.clientIdentityPub == clientIdentityPub })
    }

    fun touch(context: Context, clientIdentityPub: String) {
        val device = get(context, clientIdentityPub) ?: return
        save(context, device.copy(lastSeenAt = System.currentTimeMillis()))
    }
}
