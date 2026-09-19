package com.depot.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotType

/**
 * A flat, dark input — the artifact has no filled Material text fields in
 * it, and everything typed into this app is a machine fact (a URL, a
 * payload) or a name, so the field is built from the same tokens as every
 * other surface rather than themed out of M3.
 */
@Composable
fun DepotTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    minHeight: Dp = 52.dp,
    textStyle: TextStyle = DepotType.Fact,
) {
    val shape = RoundedCornerShape(11.dp)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = minHeight)
            .clip(shape)
            .background(if (enabled) DepotColors.Bg else DepotColors.Bg2)
            .border(1.dp, DepotColors.Line2, shape)
            .padding(horizontal = 14.dp, vertical = 15.dp),
    ) {
        if (value.isEmpty()) {
            Text(placeholder, style = textStyle, color = DepotColors.Ink3)
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = singleLine,
            textStyle = textStyle.copy(color = if (enabled) DepotColors.Ink else DepotColors.Ink3),
            cursorBrush = SolidColor(DepotColors.Amber),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
