package com.depot.app.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * The palette from the "Depot — Interface Design" artifact, kept in step
 * with web/src/index.css so the phone and the browser read as one product.
 * Dark only, deliberately: this is a tool for looking at your own files at
 * night, and a light mode would be a second thing to keep honest.
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
    val AmberBg = Color(0x17FFB020) // 9% over the dark background

    val Green = Color(0xFF3FCF8E)
    val GreenBg = Color(0x1F3FCF8E)
    val Red = Color(0xFFF2545B)
    val RedBg = Color(0x1AF2545B)
    val Blue = Color(0xFF5B9DFF)
}
