package com.depot.app.storage

import android.content.Context
import com.depot.app.transport.NetworkPreference
import com.depot.app.ui.theme.ThemePreference
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The handful of preferences the Depot needs to come back up on its own.
 *
 * The Signal URL matters most: without it, a phone that has been restarted
 * cannot start listening again until someone types the address back in,
 * which makes an app that is meant to be a server dependent on a human
 * being nearby. It is public routing information, so plain preferences are
 * the right place for it — unlike the identity key, there is nothing here
 * worth wrapping in the keystore.
 */
/** What the settings screen collects for a relay; blank url means none. */
data class TurnSettings(val url: String = "", val username: String = "", val credential: String = "")

object Settings {

    private const val PREFS = "depot.settings"
    private const val KEY_SIGNAL_URL = "signalUrl"
    private const val KEY_TURN_URL = "turnUrl"
    private const val KEY_TURN_USER = "turnUsername"
    private const val KEY_TURN_CREDENTIAL = "turnCredential"
    private const val KEY_NETWORK = "networkPreference"
    private const val KEY_THEME = "themePreference"
    private const val KEY_MOVED_DAY = "movedDay"
    private const val KEY_MOVED_BYTES = "movedBytes"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun signalUrl(context: Context): String = prefs(context).getString(KEY_SIGNAL_URL, "") ?: ""

    fun setSignalUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_SIGNAL_URL, url.trim()).apply()
    }

    /**
     * The optional TURN relay (§5.1). A blank URL means "not configured",
     * which is different from a configured server that happens to fail —
     * the UI can only say "add a relay" honestly if it knows which it is.
     */
    fun turn(context: Context): TurnSettings {
        val p = prefs(context)
        return TurnSettings(
            url = p.getString(KEY_TURN_URL, "") ?: "",
            username = p.getString(KEY_TURN_USER, "") ?: "",
            credential = p.getString(KEY_TURN_CREDENTIAL, "") ?: "",
        )
    }

    /**
     * What the user said about this connection, if anything.
     *
     * AUTO is the answer for almost everyone: the phone can see which
     * network it is on. The override is for when that reading is wrong
     * — a hotspot the system has not been told is metered, say — not
     * for deciding this by hand every time.
     */
    fun network(context: Context): NetworkPreference =
        runCatching {
            NetworkPreference.valueOf(prefs(context).getString(KEY_NETWORK, null) ?: "AUTO")
        }.getOrDefault(NetworkPreference.AUTO)

    fun setNetwork(context: Context, preference: NetworkPreference) {
        prefs(context).edit().putString(KEY_NETWORK, preference.name).apply()
    }

    /** Light, dark, or whatever the system says — the default. */
    fun theme(context: Context): ThemePreference =
        runCatching {
            ThemePreference.valueOf(prefs(context).getString(KEY_THEME, null) ?: "SYSTEM")
        }.getOrDefault(ThemePreference.SYSTEM)

    fun setTheme(context: Context, preference: ThemePreference) {
        prefs(context).edit().putString(KEY_THEME, preference.name).apply()
    }

    fun setTurn(context: Context, turn: TurnSettings) {
        prefs(context).edit()
            .putString(KEY_TURN_URL, turn.url.trim())
            .putString(KEY_TURN_USER, turn.username.trim())
            .putString(KEY_TURN_CREDENTIAL, turn.credential)
            .apply()
    }

    /** Today as yyyy-MM-dd, which is what the running total is keyed on. */
    fun today(): String =
        SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(System.currentTimeMillis()))

    /**
     * Bytes moved on [day], or zero if the stored total belongs to some
     * other day. Rolling over by comparing dates rather than scheduling a
     * midnight reset means a phone that was asleep at midnight still
     * reports the right figure when it wakes.
     */
    fun movedOn(context: Context, day: String): Long {
        val stored = prefs(context).getString(KEY_MOVED_DAY, null)
        if (stored != day) return 0L
        return prefs(context).getLong(KEY_MOVED_BYTES, 0L)
    }

    fun setMovedOn(context: Context, day: String, bytes: Long) {
        prefs(context).edit()
            .putString(KEY_MOVED_DAY, day)
            .putLong(KEY_MOVED_BYTES, bytes)
            .apply()
    }
}
