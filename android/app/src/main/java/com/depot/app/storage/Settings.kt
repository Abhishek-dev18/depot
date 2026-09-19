package com.depot.app.storage

import android.content.Context
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
object Settings {

    private const val PREFS = "depot.settings"
    private const val KEY_SIGNAL_URL = "signalUrl"
    private const val KEY_MOVED_DAY = "movedDay"
    private const val KEY_MOVED_BYTES = "movedBytes"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun signalUrl(context: Context): String = prefs(context).getString(KEY_SIGNAL_URL, "") ?: ""

    fun setSignalUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_SIGNAL_URL, url.trim()).apply()
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
