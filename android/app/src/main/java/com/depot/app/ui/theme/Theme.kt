package com.depot.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.snapshots.Snapshot

/** What the user chose in Settings: follow the system, or insist. */
enum class ThemePreference { SYSTEM, LIGHT, DARK }

@Composable
fun ThemePreference.isDark(): Boolean = when (this) {
    ThemePreference.SYSTEM -> isSystemInDarkTheme()
    ThemePreference.LIGHT -> false
    ThemePreference.DARK -> true
}

/*
 * No dynamic color. The artifact's palette is the product's identity —
 * letting Android recolor it from the user's wallpaper would make the
 * phone and the browser look like two different applications, and the
 * amber accent carries meaning here rather than decoration. Light and
 * dark are both the product's own.
 */
private fun colorSchemeFor(p: DepotPalette) = if (p.isDark) {
    darkColorScheme(
        primary = p.amber, onPrimary = p.onAmber,
        primaryContainer = p.amberBg, onPrimaryContainer = p.amber,
        secondary = p.ink2, onSecondary = p.bg,
        background = p.bg, onBackground = p.ink,
        surface = p.surface, onSurface = p.ink,
        surfaceVariant = p.surface2, onSurfaceVariant = p.ink2,
        outline = p.line2, outlineVariant = p.line,
        error = p.red, onError = p.bg,
        errorContainer = p.redBg, onErrorContainer = p.red,
    )
} else {
    lightColorScheme(
        primary = p.amber, onPrimary = p.surface,
        primaryContainer = p.amberBg, onPrimaryContainer = p.amber,
        secondary = p.ink2, onSecondary = p.surface,
        background = p.bg, onBackground = p.ink,
        surface = p.surface, onSurface = p.ink,
        surfaceVariant = p.surface2, onSurfaceVariant = p.ink2,
        outline = p.line2, outlineVariant = p.line,
        error = p.red, onError = p.surface,
        errorContainer = p.redBg, onErrorContainer = p.red,
    )
}

@Composable
fun DepotTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val palette = if (dark) DarkPalette else LightPalette
    // Set at the root, before anything below reads a colour, so the first
    // frame is already right and a change redraws everything that used one.
    // Compared without observing, so the write is not a write to state this
    // same composition has just read, which would force a second pass.
    if (Snapshot.withoutReadObservation { DepotColors.palette } !== palette) DepotColors.palette = palette
    MaterialTheme(
        colorScheme = colorSchemeFor(palette),
        typography = DepotTypography,
        content = content,
    )
}
