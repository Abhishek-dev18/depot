package com.depot.app.ui.theme

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color

/**
 * The palette straight out of the "Depot — Interface Design" artifact
 * (https://claude.ai/artifact/CMxsYXcZNY8XTzkoSGYwPn), kept in step with
 * web/src/index.css — both variants, hex for hex — so the phone and the
 * browser read as one product.
 *
 * Dark is the spec and the default. Light keeps the same structure and
 * accent with each colour re-chosen for contrast on a light screen rather
 * than inverted: amber *text* darkens to stay legible, while amber *fills*
 * keep the bright brand amber under dark text.
 */
class DepotPalette(
    val isDark: Boolean,
    val bg: Color,
    val bg2: Color,
    val surface: Color,
    val surface2: Color,
    val line: Color,
    val line2: Color,
    val ink: Color,
    val ink2: Color,
    val ink3: Color,
    val amber: Color,
    val amberFill: Color,
    val amberDim: Color,
    val onAmber: Color,
    val amberBg: Color,
    val amberBgFaint: Color,
    val green: Color,
    val greenBg: Color,
    val greenGlow: Color,
    val greenLine: Color,
    val red: Color,
    val redBg: Color,
    val redLine: Color,
    val blue: Color,
    val scanBg: Color,
    val scrim: Color,
)

val DarkPalette = DepotPalette(
    isDark = true,
    bg = Color(0xFF0C0D0F),
    bg2 = Color(0xFF131519),
    surface = Color(0xFF181B21),
    surface2 = Color(0xFF1F232B),
    line = Color(0xFF2A2F39),
    line2 = Color(0xFF373D4A),
    ink = Color(0xFFECEEF2),
    ink2 = Color(0xFF9AA3B2),
    ink3 = Color(0xFF626B7C),
    amber = Color(0xFFFFB020),
    amberFill = Color(0xFFFFB020),
    amberDim = Color(0xFF8A5F12),
    onAmber = Color(0xFF1A1203),
    amberBg = Color(0x17FFB020),
    amberBgFaint = Color(0x0DFFB020),
    green = Color(0xFF3FCF8E),
    greenBg = Color(0x1F3FCF8E),
    greenGlow = Color(0x293FCF8E),
    greenLine = Color(0x403FCF8E),
    red = Color(0xFFF2545B),
    redBg = Color(0x1AF2545B),
    redLine = Color(0x40F2545B),
    blue = Color(0xFF5B9DFF),
    scanBg = Color(0xFF07080A),
    scrim = Color(0x9E000000),
)

/** Text tokens all clear WCAG AA on white: ink3 4.8, amber 4.9, green 4.8, red 5.3. */
val LightPalette = DepotPalette(
    isDark = false,
    bg = Color(0xFFF3F1ED),
    bg2 = Color(0xFFF8F7F4),
    surface = Color(0xFFFFFFFF),
    surface2 = Color(0xFFEEEBE5),
    line = Color(0xFFDFDBD3),
    line2 = Color(0xFFCBC6BC),
    ink = Color(0xFF16181D),
    ink2 = Color(0xFF4A5160),
    ink3 = Color(0xFF6B7282),
    amber = Color(0xFFA86000),
    amberFill = Color(0xFFFFB020),
    amberDim = Color(0xFFD9A54A),
    onAmber = Color(0xFF1A1203),
    amberBg = Color(0x29FFB020),
    amberBgFaint = Color(0x14FFB020),
    green = Color(0xFF12825A),
    greenBg = Color(0x1A12825A),
    greenGlow = Color(0x2912825A),
    greenLine = Color(0x4D12825A),
    red = Color(0xFFC8323A),
    redBg = Color(0x14C8323A),
    redLine = Color(0x4DC8323A),
    blue = Color(0xFF2563D0),
    // A camera viewfinder stays dark whatever the theme.
    scanBg = Color(0xFF07080A),
    scrim = Color(0x7316181D),
)

/**
 * The colours every screen draws with, by name.
 *
 * Each one reads the current palette, which is Compose state: switching
 * theme redraws whatever used a colour, without a single call site having
 * to know that there is more than one palette.
 */
object DepotColors {
    var palette: DepotPalette by mutableStateOf(DarkPalette)
        internal set

    val Bg: Color get() = palette.bg
    val Bg2: Color get() = palette.bg2
    val Surface: Color get() = palette.surface
    val Surface2: Color get() = palette.surface2
    val Line: Color get() = palette.line
    val Line2: Color get() = palette.line2

    val Ink: Color get() = palette.ink
    val Ink2: Color get() = palette.ink2
    val Ink3: Color get() = palette.ink3

    /** Amber as text, icons and outlines. */
    val Amber: Color get() = palette.amber

    /** Amber as a solid fill, always under [OnAmber]. */
    val AmberFill: Color get() = palette.amberFill
    val AmberDim: Color get() = palette.amberDim

    /**
     * Amber text sits on amber fills, so the fill needs a dark foreground
     * rather than the page background — the artifact's `#1A1203`, a
     * near-black with a trace of the accent still in it.
     */
    val OnAmber: Color get() = palette.onAmber

    /** rgba(255,176,32,.09) in dark — the SAS digit tiles. */
    val AmberBg: Color get() = palette.amberBg

    /** rgba(255,176,32,.05) in dark — the SAS panel behind them. */
    val AmberBgFaint: Color get() = palette.amberBgFaint

    val Green: Color get() = palette.green
    val GreenBg: Color get() = palette.greenBg

    /** The halo on the live pulse dot. */
    val GreenGlow: Color get() = palette.greenGlow

    /** The connection badge's border. */
    val GreenLine: Color get() = palette.greenLine

    val Red: Color get() = palette.red
    val RedBg: Color get() = palette.redBg
    val RedLine: Color get() = palette.redLine

    val Blue: Color get() = palette.blue

    /** The scanner's viewfinder backdrop — darker than the page itself. */
    val ScanBg: Color get() = palette.scanBg

    /** Behind a bottom sheet. */
    val Scrim: Color get() = palette.scrim
}
