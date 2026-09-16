package com.depot.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.MonoStyle

/**
 * The SAS, rendered as the artifact specifies: six large amber digits in
 * individual boxes. This is the one screen in the app where the user is
 * doing security-critical work, so the digits are the largest thing on it
 * and nothing competes with them.
 */
@Composable
fun SasDigits(sas: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (digit in sas) {
            Box(
                modifier = Modifier
                    .size(width = 46.dp, height = 62.dp)
                    .background(DepotColors.AmberBg, RoundedCornerShape(9.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = digit.toString(),
                    color = DepotColors.Amber,
                    fontSize = 34.sp,
                    style = MonoStyle.copy(fontSize = 34.sp),
                )
            }
        }
    }
}

@Composable
fun SasPrompt(
    sas: String,
    onApprove: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .border(1.dp, DepotColors.AmberDim, RoundedCornerShape(11.dp))
            .background(DepotColors.Bg2, RoundedCornerShape(11.dp))
            .padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "DOES THE CLIENT SHOW THIS NUMBER?",
            color = DepotColors.Ink2,
            style = MonoStyle.copy(fontSize = 12.sp, letterSpacing = 1.sp),
            textAlign = TextAlign.Center,
        )
        SasDigits(sas, Modifier.padding(vertical = 18.dp))
        Text(
            // The honest framing: a mismatch is the only signal the user
            // gets that someone is in the middle, so say what it means.
            text = "If the numbers differ, someone may be intercepting the connection.",
            color = DepotColors.Ink3,
            textAlign = TextAlign.Center,
        )
        Button(
            onClick = onApprove,
            modifier = Modifier.padding(top = 18.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = DepotColors.Amber,
                contentColor = DepotColors.Bg,
            ),
            shape = RoundedCornerShape(9.dp),
        ) {
            Text("Approve", fontSize = 16.sp)
        }
    }
}

@Composable
fun PairingScreen(
    state: PairingUiState,
    onPayloadChange: (String) -> Unit,
    onJoin: () -> Unit,
    onApprove: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(DepotColors.Bg)
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
    ) {
        Text("Depot", color = DepotColors.Ink, fontSize = 26.sp)
        Text(
            "Pair with a Client",
            color = DepotColors.Ink2,
            modifier = Modifier.padding(top = 4.dp, bottom = 20.dp),
        )

        // Until the camera lands, the QR payload is pasted — the same
        // escape hatch the web Depot simulator uses.
        OutlinedTextField(
            value = state.payload,
            onValueChange = onPayloadChange,
            label = { Text("QR payload JSON") },
            modifier = Modifier.fillMaxWidth(),
            textStyle = MonoStyle,
            minLines = 4,
        )

        Button(
            onClick = onJoin,
            enabled = !state.busy && state.payload.isNotBlank(),
            modifier = Modifier.padding(top = 12.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = DepotColors.Surface2,
                contentColor = DepotColors.Ink,
            ),
            shape = RoundedCornerShape(9.dp),
        ) {
            Text(if (state.busy) "Pairing…" else "Join pairing")
        }

        state.sas?.let { sas ->
            Box(Modifier.padding(top = 20.dp)) {
                SasPrompt(sas = sas, onApprove = onApprove)
            }
        }

        state.error?.let { error ->
            Text(
                text = error,
                color = DepotColors.Red,
                style = MonoStyle,
                modifier = Modifier
                    .padding(top = 20.dp)
                    .fillMaxWidth()
                    .background(DepotColors.RedBg, RoundedCornerShape(9.dp))
                    .padding(12.dp),
            )
        }

        if (state.log.isNotEmpty()) {
            Column(Modifier.padding(top = 20.dp)) {
                Text("LOG", color = DepotColors.Ink3, style = MonoStyle.copy(fontSize = 11.sp))
                for (line in state.log) {
                    Text(line, color = DepotColors.Ink2, style = MonoStyle)
                }
            }
        }
    }
}
