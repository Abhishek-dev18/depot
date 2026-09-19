package com.depot.app.ui.components

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Sizes are reported the way the artifact writes them — "41.2 GB",
 * "612 MB" — which means decimal units, not binary. A phone's own storage
 * screen says GB for 10^9 bytes, so matching it keeps the two numbers
 * comparable rather than mysteriously 7% apart.
 *
 * One decimal below 100, none above: "4.2 MB" but "612 MB".
 */
fun formatBytes(bytes: Long): String {
    if (bytes < 1000) return "$bytes B"
    val units = arrayOf("KB", "MB", "GB", "TB", "PB")
    var value = bytes.toDouble() / 1000.0
    var unit = 0
    while (value >= 1000.0 && unit < units.size - 1) {
        value /= 1000.0
        unit++
    }
    val text =
        if (value >= 100.0) String.format(Locale.US, "%.0f", value)
        else String.format(Locale.US, "%.1f", value)
    return "$text ${units[unit]}"
}

fun formatRate(bytesPerSecond: Double): String {
    if (bytesPerSecond <= 0.0 || bytesPerSecond.isNaN() || bytesPerSecond.isInfinite()) return "—"
    return formatBytes(bytesPerSecond.toLong()) + "/s"
}

/** "6h 12m" the way the artifact's UPTIME cell reads. */
fun formatDuration(millis: Long): String {
    val total = (millis / 1000).coerceAtLeast(0)
    val hours = total / 3600
    val minutes = (total % 3600) / 60
    val seconds = total % 60
    return when {
        hours > 0 -> "${hours}h ${minutes}m"
        minutes > 0 -> "${minutes}m ${seconds}s"
        else -> "${seconds}s"
    }
}

/** "0:09 eta", or an em dash while there is nothing to extrapolate from. */
fun formatEta(remainingBytes: Long, bytesPerSecond: Double): String {
    if (bytesPerSecond <= 0.0 || remainingBytes <= 0L) return "—"
    val seconds = (remainingBytes / bytesPerSecond).toLong()
    if (seconds >= 3600) return formatDuration(seconds * 1000)
    return String.format(Locale.US, "%d:%02d", seconds / 60, seconds % 60)
}

/** The artifact's "14 SEP" column. */
fun formatDay(millis: Long): String =
    SimpleDateFormat("d MMM", Locale.getDefault()).format(Date(millis)).uppercase(Locale.getDefault())

fun formatDateTime(millis: Long): String =
    SimpleDateFormat("d MMM yyyy, HH:mm", Locale.getDefault()).format(Date(millis))

/** "ACTIVE NOW", "2H AGO" — the artifact's `.mt` line on a device row. */
fun formatLastSeen(millis: Long, now: Long = System.currentTimeMillis()): String {
    val elapsed = now - millis
    return when {
        elapsed < 2 * 60 * 1000L -> "JUST NOW"
        elapsed < 60 * 60 * 1000L -> "${elapsed / 60000}M AGO"
        elapsed < 24 * 60 * 60 * 1000L -> "${elapsed / 3600000}H AGO"
        elapsed < 30L * 24 * 60 * 60 * 1000L -> "${elapsed / 86400000}D AGO"
        else -> formatDay(millis)
    }
}

/**
 * A base64 identity key is 43 characters of noise. This is enough to tell
 * two devices apart at a glance, which is all a list row needs.
 */
fun shortId(id: String, head: Int = 12): String =
    if (id.length <= head) id else id.take(head) + "…"

/**
 * The same key grouped in fours, for the one screen where a person might
 * actually read it across to another device.
 */
fun fingerprint(id: String, groups: Int = 4): String =
    id.take(groups * 4).chunked(4).joinToString(" ")
