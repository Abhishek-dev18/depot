package com.depot.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.depot.app.ui.theme.DepotColors

/**
 * The icon set, drawn rather than imported.
 *
 * The app carries no `material-icons` dependency, and the artifact's
 * glyphs are not Material's rounded line art anyway — they are the
 * geometric marks ▣ ▤ ✕ ⚙, squares and hard corners that belong with the
 * freight-terminal type. Drawing them keeps the vocabulary exact and costs
 * no artifact.
 *
 * Each glyph is laid out in a 0..1 space scaled by the requested size, so
 * one definition works at any dimension.
 */
@Composable
private fun Glyph(
    size: Dp,
    modifier: Modifier = Modifier,
    weight: Float = 0.09f,
    draw: DrawScope.(u: Float, stroke: Stroke) -> Unit,
) {
    Canvas(modifier.size(size)) {
        val u = this.size.minDimension
        val stroke = Stroke(
            width = u * weight,
            // Square caps, not round: the artifact's marks have corners.
            cap = StrokeCap.Butt,
            join = StrokeJoin.Miter,
        )
        draw(u, stroke)
    }
}

/**
 * The Depot mark: a crate seen head-on, which is also the `.mark` rule in
 * the artifact's stylesheet — an amber square, a seam across the top, and
 * a solid block at its centre.
 */
@Composable
fun BrandMark(size: Dp = 34.dp, tint: Color = DepotColors.Amber, modifier: Modifier = Modifier) =
    Glyph(size, modifier, weight = 0.06f) { u, stroke ->
        drawRoundRect(
            color = tint,
            topLeft = Offset(u * 0.06f, u * 0.06f),
            size = Size(u * 0.88f, u * 0.88f),
            cornerRadius = CornerRadius(u * 0.08f),
            style = stroke,
        )
        // the ::before seam
        drawLine(
            tint,
            Offset(u * 0.21f, u * 0.21f),
            Offset(u * 0.79f, u * 0.21f),
            stroke.width,
            StrokeCap.Butt,
        )
        // the ::after block
        drawRoundRect(
            color = tint,
            topLeft = Offset(u * 0.40f, u * 0.40f),
            size = Size(u * 0.20f, u * 0.20f),
            cornerRadius = CornerRadius(u * 0.03f),
        )
    }

/** ▣ — a linked device, or a file in a listing. */
@Composable
fun IconBlock(tint: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) =
    Glyph(size, modifier, weight = 0.10f) { u, stroke ->
        drawRect(
            color = tint,
            topLeft = Offset(u * 0.12f, u * 0.12f),
            size = Size(u * 0.76f, u * 0.76f),
            style = stroke,
        )
        drawRect(
            color = tint,
            topLeft = Offset(u * 0.34f, u * 0.34f),
            size = Size(u * 0.32f, u * 0.32f),
        )
    }

/** ▤ — a shared folder or file grant. */
@Composable
fun IconGrant(tint: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) =
    Glyph(size, modifier, weight = 0.10f) { u, stroke ->
        drawRect(
            color = tint,
            topLeft = Offset(u * 0.12f, u * 0.12f),
            size = Size(u * 0.76f, u * 0.76f),
            style = stroke,
        )
        drawLine(tint, Offset(u * 0.28f, u * 0.36f), Offset(u * 0.72f, u * 0.36f), stroke.width, StrokeCap.Butt)
        drawLine(tint, Offset(u * 0.28f, u * 0.50f), Offset(u * 0.72f, u * 0.50f), stroke.width, StrokeCap.Butt)
        drawLine(tint, Offset(u * 0.28f, u * 0.64f), Offset(u * 0.72f, u * 0.64f), stroke.width, StrokeCap.Butt)
    }

/** ⚙ — settings, drawn as sliders so it stays in the geometric family. */
@Composable
fun IconSettings(tint: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) =
    Glyph(size, modifier, weight = 0.09f) { u, stroke ->
        for ((i, y) in listOf(0.26f, 0.50f, 0.74f).withIndex()) {
            drawLine(tint, Offset(u * 0.14f, u * y), Offset(u * 0.86f, u * y), stroke.width, StrokeCap.Butt)
            val knobX = if (i % 2 == 0) 0.66f else 0.34f
            drawRect(
                color = tint,
                topLeft = Offset(u * (knobX - 0.07f), u * (y - 0.07f)),
                size = Size(u * 0.14f, u * 0.14f),
            )
        }
    }

/** ✕ */
@Composable
fun IconClose(tint: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) =
    Glyph(size, modifier, weight = 0.10f) { u, stroke ->
        drawLine(tint, Offset(u * 0.20f, u * 0.20f), Offset(u * 0.80f, u * 0.80f), stroke.width, StrokeCap.Square)
        drawLine(tint, Offset(u * 0.80f, u * 0.20f), Offset(u * 0.20f, u * 0.80f), stroke.width, StrokeCap.Square)
    }

/** + */
@Composable
fun IconPlus(tint: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) =
    Glyph(size, modifier, weight = 0.10f) { u, stroke ->
        drawLine(tint, Offset(u * 0.50f, u * 0.18f), Offset(u * 0.50f, u * 0.82f), stroke.width, StrokeCap.Butt)
        drawLine(tint, Offset(u * 0.18f, u * 0.50f), Offset(u * 0.82f, u * 0.50f), stroke.width, StrokeCap.Butt)
    }

/** ← */
@Composable
fun IconBack(tint: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) =
    Glyph(size, modifier, weight = 0.10f) { u, stroke ->
        drawLine(tint, Offset(u * 0.84f, u * 0.50f), Offset(u * 0.18f, u * 0.50f), stroke.width, StrokeCap.Butt)
        val head = Path().apply {
            moveTo(u * 0.44f, u * 0.24f)
            lineTo(u * 0.16f, u * 0.50f)
            lineTo(u * 0.44f, u * 0.76f)
        }
        drawPath(head, tint, style = stroke)
    }

/** ▲ — the first, preferred option in a fallback list. */
@Composable
fun IconUp(tint: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) =
    Glyph(size, modifier, weight = 0.10f) { u, _ ->
        val tri = Path().apply {
            moveTo(u * 0.50f, u * 0.16f)
            lineTo(u * 0.86f, u * 0.80f)
            lineTo(u * 0.14f, u * 0.80f)
            close()
        }
        drawPath(tri, tint)
    }

/** ◆ — the second option. */
@Composable
fun IconDiamond(tint: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) =
    Glyph(size, modifier, weight = 0.10f) { u, _ ->
        val d = Path().apply {
            moveTo(u * 0.50f, u * 0.12f)
            lineTo(u * 0.88f, u * 0.50f)
            lineTo(u * 0.50f, u * 0.88f)
            lineTo(u * 0.12f, u * 0.50f)
            close()
        }
        drawPath(d, tint)
    }

/** The tick on a settled pairing. */
@Composable
fun IconCheck(tint: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) =
    Glyph(size, modifier, weight = 0.11f) { u, stroke ->
        val path = Path().apply {
            moveTo(u * 0.18f, u * 0.52f)
            lineTo(u * 0.40f, u * 0.74f)
            lineTo(u * 0.82f, u * 0.26f)
        }
        drawPath(path, tint, style = Stroke(stroke.width, cap = StrokeCap.Square, join = StrokeJoin.Miter))
    }
