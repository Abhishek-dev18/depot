package com.depot.app.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * The palette straight out of the "Depot — Interface Design" artifact
 * (https://claude.ai/artifact/CMxsYXcZNY8XTzkoSGYwPn), kept in step with
 * web/src/index.css so the phone and the browser read as one product.
 *
 * Dark only, deliberately: the artifact has no light variant, and a
 * freight-terminal metaphor does not really have one.
 */
object DepotColors {
    val Bg = Color(0xFF0C0D0F)
    val Bg2 = Color(0xFF131519)
    val Surface = Color(0xFF181B21)
    val Surface2 = Color(0xFF1F232B)
    val Line = Color(0xFF2A2F39)
    val Line2 = Color(0xFF373D4A)

    val Ink = Color(0xFFECEEF2)
    val Ink2 = Color(0xFF9AA3B2)
    val Ink3 = Color(0xFF626B7C)

    val Amber = Color(0xFFFFB020)
    val AmberDim = Color(0xFF8A5F12)

    /**
     * Amber text sits on amber fills, so the fill needs a dark foreground
     * rather than the page background — this is the artifact's `#1A1203`,
     * a near-black with a trace of the accent still in it.
     */
    val OnAmber = Color(0xFF1A1203)

    /** rgba(255,176,32,.09) — the SAS digit tiles. */
    val AmberBg = Color(0x17FFB020)

    /** rgba(255,176,32,.05) — the SAS panel behind them. */
    val AmberBgFaint = Color(0x0DFFB020)

    val Green = Color(0xFF3FCF8E)
    val GreenBg = Color(0x1F3FCF8E)

    /** The halo on the live pulse dot: 0 0 0 3px rgba(63,207,142,.16). */
    val GreenGlow = Color(0x293FCF8E)

    /** rgba(63,207,142,.25) — the connection badge's border. */
    val GreenLine = Color(0x403FCF8E)

    val Red = Color(0xFFF2545B)
    val RedBg = Color(0x1AF2545B)
    val RedLine = Color(0x40F2545B)

    val Blue = Color(0xFF5B9DFF)

    /** The scanner's viewfinder backdrop — darker than the page itself. */
    val ScanBg = Color(0xFF07080A)
}
