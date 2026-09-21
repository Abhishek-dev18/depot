package com.depot.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Text
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotType

/**
 * `.sheet` — the artifact puts anything that demands a decision on a
 * panel that rises over a dimmed screen, rather than inline in the page.
 * That framing is the point: the screen behind is visibly suspended until
 * the question is answered.
 */
@Composable
fun BottomSheet(
    modifier: Modifier = Modifier,
    onDismiss: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp)
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.62f))
            .pointerInput(onDismiss) {
                detectTapGestures { onDismiss?.invoke() }
            },
    ) {
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .clip(shape)
                .background(DepotColors.Surface)
                .border(1.dp, DepotColors.Line2, shape)
                // Taps inside the sheet are the sheet's own; without this
                // they fall through to the scrim and dismiss it.
                .pointerInput(Unit) { detectTapGestures { } }
                // navigationBarsPadding() alone was not enough. The
                // activity asks for adjustResize, but enableEdgeToEdge()
                // makes that a no-op — an edge-to-edge window is told
                // where the keyboard is and has to move itself. Until
                // this, the keyboard opened straight over whatever field
                // had just been tapped.
                //
                // Chained rather than combined: each of these consumes
                // what it applies, so the second pads by what is left
                // rather than by the whole IME inset again.
                .navigationBarsPadding()
                .imePadding()
                // A sheet with the keyboard up has little room left, and
                // the button it is asking you to press is at the bottom
                // of it. Scrolling keeps that reachable instead of
                // pushing it off the screen.
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 22.dp, bottom = 22.dp),
            content = content,
        )
    }
}

/** `.sheet-k` — the amber kicker naming what the sheet is asking. */
@Composable
fun SheetKicker(text: String, modifier: Modifier = Modifier, color: Color = DepotColors.Amber) {
    Text(text, style = DepotType.Label, color = color, modifier = modifier)
}
