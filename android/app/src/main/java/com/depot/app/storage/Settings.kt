package com.depot.app.storage

import android.content.Context

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

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun signalUrl(context: Context): String = prefs(context).getString(KEY_SIGNAL_URL, "") ?: ""

    fun setSignalUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_SIGNAL_URL, url.trim()).apply()
    }
}
