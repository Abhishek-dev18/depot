package com.depot.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotType

/**
 * The artifact's CSS classes, translated one for one into Compose.
 *
 * Keeping them as named atoms rather than inlining their styling is what
 * stops the design drifting screen by screen: `.dev`, `.lbl`, `.cta` and
 * the rest appear on several phone frames in the spec, and they should
 * stay identical wherever they land.
 */

/** `.appbar` — a title, a mono subtitle stating machine state, one action. */
@Composable
fun AppBar(
    title: String,
    sub: String,
    modifier: Modifier = Modifier,
    subColor: Color = DepotColors.Ink3,
    leading: (@Composable () -> Unit)? = null,
    action: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = DepotType.Title, color = DepotColors.Ink)
            Text(
                sub,
                style = DepotType.Label.copy(letterSpacing = 0.14.em),
                color = subColor,
                modifier = Modifier.padding(top = 3.dp),
            )
        }
        if (action != null) action()
    }
}

/** `.icobtn` — a 1px square of chrome, never a filled button. */
@Composable
fun IcoButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .size(40.dp)
            .clip(RoundedCornerShape(9.dp))
            .border(1.dp, DepotColors.Line, RoundedCornerShape(9.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

/**
 * `.lbl` — a tracked mono caption whose rule runs out to the right edge.
 * The trailing hairline is what makes these read as section dividers
 * rather than as headings.
 */
@Composable
fun SectionLabel(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = DepotColors.Ink3,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(top = 24.dp, bottom = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = DepotType.Label, color = color)
        Box(
            Modifier
                .padding(start = 11.dp)
                .weight(1f)
                .height(1.dp)
                .background(DepotColors.Line),
        )
        if (trailing != null) {
            Spacer(Modifier.width(11.dp))
            trailing()
        }
    }
}

/**
 * `.status-hero` — the card the home screen is built around, with the
 * 3px accent bar down its left edge carrying the live/idle state.
 */
@Composable
fun StatusHero(
    accent: Color,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(DepotColors.Surface)
            .drawBehind {
                drawRect(accent, Offset.Zero, Size(3.dp.toPx(), size.height))
            }
            .border(1.dp, DepotColors.Line, shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(start = 22.dp, end = 20.dp, top = 20.dp, bottom = 20.dp),
        content = content,
    )
}

/** `.pulse i` — a dot inside a soft halo of its own colour. */
@Composable
fun PulseDot(
    color: Color,
    glow: Color,
    modifier: Modifier = Modifier,
    size: Dp = 16.dp,
) {
    Canvas(modifier.size(size)) {
        val radius = this.size.minDimension / 2f
        drawCircle(glow, radius = radius)
        drawCircle(color, radius = radius * 0.44f)
    }
}

/** `.pulse` — the whole live-state line. */
@Composable
fun PulseRow(text: String, color: Color, glow: Color, modifier: Modifier = Modifier) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        PulseDot(color = color, glow = glow)
        Text(
            text,
            style = DepotType.Pulse,
            color = color,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

/** `.hrow div` — one cell of the hero's statistics strip. */
@Composable
fun HeroStat(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(label, style = DepotType.Label.copy(letterSpacing = 0.1.em), color = DepotColors.Ink3)
        Text(
            value,
            style = DepotType.Fact,
            color = DepotColors.Ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 5.dp),
        )
    }
}

/** `.dev .ic` — the small tile a row's glyph sits in. */
@Composable
fun RowTile(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(
        modifier = modifier
            .size(40.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(DepotColors.Surface2),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

/**
 * `.dev` — a linked device. The trailing dot is `.live` or `.idle`: the
 * artifact never leaves connection state to be inferred.
 */
@Composable
fun ListRow(
    name: String,
    meta: String,
    modifier: Modifier = Modifier,
    nameColor: Color = DepotColors.Ink,
    metaColor: Color = DepotColors.Ink3,
    onClick: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val shape = RoundedCornerShape(12.dp)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = 9.dp)
            .clip(shape)
            .background(DepotColors.Surface)
            .border(1.dp, DepotColors.Line, shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.width(13.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(
                name,
                style = DepotType.RowName,
                color = nameColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                meta,
                style = DepotType.FactSmall,
                color = metaColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 3.dp),
            )
        }
        if (trailing != null) {
            Spacer(Modifier.width(12.dp))
            trailing()
        }
    }
}

/** `.live` / `.idle` — the 6px state dot at the end of a device row. */
@Composable
fun StateDot(color: Color, modifier: Modifier = Modifier) {
    Box(modifier.size(9.dp).clip(CircleShape).background(color))
}

/** `.sw` — the folder-grant toggle, drawn rather than themed from M3. */
@Composable
fun GrantSwitch(on: Boolean, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(width = 46.dp, height = 26.dp)
            .clip(RoundedCornerShape(13.dp))
            .background(if (on) DepotColors.AmberFill else DepotColors.Line2),
        contentAlignment = if (on) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Box(
            Modifier
                .padding(horizontal = 3.dp)
                .size(20.dp)
                .clip(CircleShape)
                .background(if (on) DepotColors.OnAmber else DepotColors.Ink3),
        )
    }
}

/** `.cta` — the single amber commitment pinned to the bottom of a screen. */
@Composable
fun Cta(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(14.dp)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(56.dp)
            .clip(shape)
            .background(if (enabled) DepotColors.AmberFill else DepotColors.Surface2)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = DepotType.Button,
            color = if (enabled) DepotColors.OnAmber else DepotColors.Ink3,
        )
    }
}

/** `.btn.yes` and `.btn.no` — the approval sheet's pair. */
@Composable
fun SheetButton(
    text: String,
    primary: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(14.dp)
    Box(
        modifier = modifier
            .height(56.dp)
            .clip(shape)
            .then(
                if (primary) Modifier.background(DepotColors.AmberFill)
                else Modifier.border(1.dp, DepotColors.Line2, shape),
            )
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = DepotType.Button.copy(fontSize = 16.sp),
            color = if (primary) DepotColors.OnAmber else DepotColors.Ink2,
        )
    }
}

/**
 * `.conn` — DIRECT or RELAYED, always on screen while a peer is connected.
 * The artifact is explicit that this is never hidden: a relayed path means
 * bytes are crossing a third machine, and a privacy tool that quietly
 * stopped saying so would be undercutting its own claim.
 */
@Composable
fun ConnectionBadge(
    label: String,
    color: Color,
    borderColor: Color,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .border(1.dp, borderColor, RoundedCornerShape(6.dp))
            .padding(horizontal = 9.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(color))
        Text(
            label,
            style = DepotType.Label.copy(letterSpacing = 0.1.em),
            color = color,
            modifier = Modifier.padding(start = 7.dp),
        )
    }
}

/**
 * `.opt` — a concrete thing the user can do about a failure. The artifact
 * is firm that failure screens offer options rather than apologies, so
 * these rows carry an action and the trade-off that comes with it.
 */
@Composable
fun OptionRow(
    title: String,
    detail: String,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    icon: (@Composable () -> Unit)? = null,
) {
    val shape = RoundedCornerShape(11.dp)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = 9.dp)
            .clip(shape)
            .border(1.dp, DepotColors.Line, shape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            icon()
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = DepotType.Body.copy(fontSize = 15.sp), color = DepotColors.Ink)
            Text(
                detail,
                style = DepotType.FactSmall,
                color = DepotColors.Ink3,
                modifier = Modifier.padding(top = 3.dp),
            )
        }
    }
}

/**
 * `.failwrap` — the shape every dead end takes: a ring, a plain-language
 * title, what the machine was actually trying to do, then the options.
 */
@Composable
fun FailState(
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    accent: Color = DepotColors.Red,
    mark: String = "!",
    options: (@Composable ColumnScope.() -> Unit)? = null,
) {
    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier
                .size(58.dp)
                .clip(CircleShape)
                .border(2.dp, accent, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(mark, style = DepotType.Title.copy(fontSize = 26.sp), color = accent)
        }
        Text(
            title,
            style = DepotType.Title.copy(fontSize = 20.sp),
            color = DepotColors.Ink,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 18.dp),
        )
        Text(
            body,
            style = DepotType.Body,
            color = DepotColors.Ink2,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 9.dp),
        )
        if (options != null) {
            Column(
                Modifier.fillMaxWidth().padding(top = 20.dp),
                verticalArrangement = Arrangement.spacedBy(0.dp),
                content = options,
            )
        }
    }
}
