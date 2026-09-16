package com.depot.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

/**
 * Dark only, and no dynamic color. The artifact's palette is the product's
 * identity — letting Android recolor it from the user's wallpaper would
 * make the phone and the browser look like two different applications, and
 * the amber accent carries meaning here rather than decoration.
 */
private val DepotColorScheme = darkColorScheme(
    primary = DepotColors.Amber,
    onPrimary = DepotColors.Bg,
    primaryContainer = DepotColors.AmberBg,
    onPrimaryContainer = DepotColors.Amber,
    secondary = DepotColors.Ink2,
    onSecondary = DepotColors.Bg,
    background = DepotColors.Bg,
    onBackground = DepotColors.Ink,
    surface = DepotColors.Surface,
    onSurface = DepotColors.Ink,
    surfaceVariant = DepotColors.Surface2,
    onSurfaceVariant = DepotColors.Ink2,
    outline = DepotColors.Line2,
    outlineVariant = DepotColors.Line,
    error = DepotColors.Red,
    onError = DepotColors.Bg,
    errorContainer = DepotColors.RedBg,
    onErrorContainer = DepotColors.Red,
)

@Composable
fun DepotTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DepotColorScheme,
        typography = DepotTypography,
        content = content,
    )
}
