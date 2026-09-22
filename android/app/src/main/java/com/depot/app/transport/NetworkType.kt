package com.depot.app.transport

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/**
 * What kind of connection this phone is on.
 *
 * Asked for as a button to pick between Wi-Fi and mobile data. The phone
 * already knows — it has ACCESS_NETWORK_STATE and ConnectivityManager
 * answers in a line — and a setting the user has to remember to change
 * is wrong the moment they leave the house. So the answer is detected,
 * shown, and overridable: the override exists for the case the detection
 * gets wrong, not as the way this is normally decided.
 *
 * What it is *for* is the part worth stating. Measuring the link already
 * tells the protocol how fast it is (§5.6); it does not tell it whether
 * bytes cost money. Those are different questions with different
 * answers: on a fast connection compression is a waste of time, unless
 * the connection is metered, in which case time is the cheap thing and
 * bytes are not.
 */
enum class NetworkType {
    WIFI,
    CELLULAR,
    OTHER,
    UNKNOWN;

    /** What §5.4 carries to the Client, which knows nothing about this phone. */
    fun wireName(): String = name.lowercase()
}

data class NetworkState(
    val type: NetworkType,
    /**
     * Whether the system considers this connection to cost money.
     *
     * Not simply "is it cellular": a metered Wi-Fi hotspot is someone's
     * phone plan, and an unmetered cellular plan exists too. Android
     * tracks the distinction and the user can set it per network, so the
     * system's answer is better than one inferred from the transport.
     */
    val metered: Boolean,
) {
    companion object {
        val Unknown = NetworkState(NetworkType.UNKNOWN, metered = false)
    }
}

/** What the user asked for, which is normally "work it out". */
enum class NetworkPreference { AUTO, WIFI, CELLULAR }

object Network {

    fun current(context: Context): NetworkState {
        val cm = context.getSystemService(ConnectivityManager::class.java)
            ?: return NetworkState.Unknown
        val caps = runCatching { cm.getNetworkCapabilities(cm.activeNetwork) }.getOrNull()
            ?: return NetworkState.Unknown

        val type = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> NetworkType.WIFI
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> NetworkType.CELLULAR
            else -> NetworkType.OTHER
        }
        // NOT_METERED is stated rather than implied, so its absence on an
        // unknown network reads as "assume it costs" — the safer way to
        // be wrong about someone else's data plan.
        val metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        return NetworkState(type, metered)
    }

    /**
     * What to act on: the user's choice where they made one, and the
     * detected answer otherwise.
     *
     * An override changes what is *assumed about cost*, which is the
     * only thing this is used for. It cannot move the phone onto a
     * different network and does not pretend to.
     */
    fun effective(context: Context, preference: NetworkPreference): NetworkState {
        val detected = current(context)
        return when (preference) {
            NetworkPreference.AUTO -> detected
            NetworkPreference.WIFI -> NetworkState(NetworkType.WIFI, metered = false)
            NetworkPreference.CELLULAR -> NetworkState(NetworkType.CELLULAR, metered = true)
        }
    }
}
