package com.depot.app.ui.theme

import androidx.compose.ui.graphics.Color
import kotlin.math.pow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PaletteTest {

    private fun channel(c: Float): Double =
        if (c <= 0.03928f) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)

    private fun luminance(c: Color): Double =
        0.2126 * channel(c.red) + 0.7152 * channel(c.green) + 0.0722 * channel(c.blue)

    private fun contrast(a: Color, b: Color): Double {
        val (hi, lo) = listOf(luminance(a), luminance(b)).sortedDescending()
        return (hi + 0.05) / (lo + 0.05)
    }

    /**
     * Amber text on a light page was the reason the light palette could not
     * just reuse the dark one's colours: #FFB020 on white is 1.8:1. Every
     * colour used for text has to be readable on the surface it sits on.
     */
    @Test
    fun lightTextIsReadableOnItsSurface() {
        val p = LightPalette
        for ((name, colour) in listOf(
            "ink" to p.ink, "ink2" to p.ink2, "ink3" to p.ink3,
            "amber" to p.amber, "green" to p.green, "red" to p.red, "blue" to p.blue,
        )) {
            val ratio = contrast(colour, p.surface)
            assertTrue("$name is $ratio:1 on the light surface", ratio >= 4.5)
        }
    }

    /** Fills keep the bright amber, and what sits on them stays dark. */
    @Test
    fun amberFillsCarryDarkTextInBothThemes() {
        for (p in listOf(DarkPalette, LightPalette)) {
            val ratio = contrast(p.onAmber, p.amberFill)
            assertTrue("on-amber is $ratio:1 (dark=${p.isDark})", ratio >= 7.0)
        }
    }

    @Test
    fun theNamedColoursFollowThePalette() {
        val before = DepotColors.palette
        try {
            DepotColors.palette = LightPalette
            assertEquals(LightPalette.bg, DepotColors.Bg)
            assertEquals(LightPalette.amber, DepotColors.Amber)
            DepotColors.palette = DarkPalette
            assertEquals(DarkPalette.bg, DepotColors.Bg)
            assertEquals(DarkPalette.amber, DepotColors.Amber)
        } finally {
            DepotColors.palette = before
        }
    }
}
