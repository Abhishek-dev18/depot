package com.depot.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.depot.app.storage.DeviceRecord
import com.depot.app.transport.ConnectionType
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.MonoStyle

/** A base64 key is 43 characters of noise; enough to recognise, not to read. */
private fun shortId(id: String): String = if (id.length <= 16) id else id.take(16) + "…"

/**
 * The SAS, rendered as the artifact specifies: six large amber digits in
 * individual boxes. This is the one screen where the user is doing
 * security-critical work, so the digits are the largest thing on it.
 */
@Composable
fun SasDigits(sas: String, modifier: Modifier = Modifier) {
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (digit in sas) {
            Box(
                modifier = Modifier
                    .size(width = 44.dp, height = 60.dp)
                    .background(DepotColors.AmberBg, RoundedCornerShape(9.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = digit.toString(),
                    color = DepotColors.Amber,
                    style = MonoStyle.copy(fontSize = 32.sp),
                )
            }
        }
    }
}

@Composable
fun SasPrompt(sas: String, onApprove: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .border(1.dp, DepotColors.AmberDim, RoundedCornerShape(11.dp))
            .background(DepotColors.Bg2, RoundedCornerShape(11.dp))
            .padding(18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "DOES THE CLIENT SHOW THIS NUMBER?",
            color = DepotColors.Ink2,
            style = MonoStyle.copy(fontSize = 11.sp, letterSpacing = 1.sp),
            textAlign = TextAlign.Center,
        )
        SasDigits(sas, Modifier.padding(vertical = 16.dp))
        Text(
            text = "If the numbers differ, someone may be intercepting the connection.",
            color = DepotColors.Ink3,
            style = MonoStyle.copy(fontSize = 12.sp),
            textAlign = TextAlign.Center,
        )
        Button(
            onClick = onApprove,
            modifier = Modifier.padding(top = 16.dp),
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
private fun DeviceRow(device: DeviceRecord, onRevoke: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp)
            .background(DepotColors.Surface, RoundedCornerShape(9.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = shortId(device.clientIdentityPub),
                color = if (device.revoked) DepotColors.Ink3 else DepotColors.Ink,
                style = MonoStyle,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                // Revoked is the state that matters most here, so it is
                // said plainly rather than shown as a colour alone.
                text = if (device.revoked) "REVOKED" else device.label,
                color = if (device.revoked) DepotColors.Red else DepotColors.Ink3,
                style = MonoStyle.copy(fontSize = 11.sp),
            )
        }
        if (!device.revoked) {
            TextButton(onClick = onRevoke) {
                Text("Revoke", color = DepotColors.Red, style = MonoStyle)
            }
        }
    }
}

@Composable
fun PairingScreen(
    state: PairingUiState,
    onPayloadChange: (String) -> Unit,
    onJoin: () -> Unit,
    onApprove: () -> Unit,
    onRevoke: (DeviceRecord) -> Unit,
    onDismissResult: () -> Unit,
    onSignalUrlChange: (String) -> Unit,
    onToggleListening: () -> Unit,
    onPickFile: () -> Unit,
    onScanQr: () -> Unit,
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
            modifier = Modifier.padding(top = 4.dp, bottom = 18.dp),
        )

        Button(
            onClick = onScanQr,
            enabled = !state.busy,
            colors = ButtonDefaults.buttonColors(
                containerColor = DepotColors.Amber,
                contentColor = DepotColors.Bg,
                disabledContainerColor = DepotColors.Surface2,
                disabledContentColor = DepotColors.Ink3,
            ),
            shape = RoundedCornerShape(9.dp),
        ) {
            Text("Scan QR code", fontSize = 16.sp)
        }
        Text(
            // §3.1: the camera is what Signal cannot reach, so this is the
            // path that actually carries the security property. Pasting is
            // the fallback for a browser tab with no camera to point at.
            "or paste the payload if you cannot scan",
            color = DepotColors.Ink3,
            style = MonoStyle.copy(fontSize = 12.sp),
            modifier = Modifier.padding(top = 14.dp, bottom = 6.dp),
        )
        OutlinedTextField(
            value = state.payload,
            onValueChange = onPayloadChange,
            label = { Text("QR payload JSON") },
            placeholder = { Text("Paste from the Client", style = MonoStyle) },
            modifier = Modifier.fillMaxWidth(),
            textStyle = MonoStyle.copy(fontSize = 12.sp),
            minLines = 3,
            maxLines = 6,
        )

        Button(
            onClick = onJoin,
            enabled = !state.busy && state.payload.isNotBlank(),
            modifier = Modifier.padding(top = 12.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = DepotColors.Surface2,
                contentColor = DepotColors.Ink,
                disabledContainerColor = DepotColors.Surface,
                disabledContentColor = DepotColors.Ink3,
            ),
            shape = RoundedCornerShape(9.dp),
        ) {
            Text(if (state.busy) "Pairing…" else "Join pairing", fontSize = 16.sp)
        }

        state.sas?.let { sas ->
            Box(Modifier.padding(top = 18.dp)) {
                SasPrompt(sas = sas, onApprove = onApprove)
            }
        }

        state.justPaired?.let { device ->
            Column(
                Modifier
                    .padding(top = 18.dp)
                    .fillMaxWidth()
                    .border(1.dp, DepotColors.Green, RoundedCornerShape(11.dp))
                    .background(DepotColors.GreenBg, RoundedCornerShape(11.dp))
                    .padding(16.dp),
            ) {
                Text("Paired", color = DepotColors.Green, fontSize = 18.sp)
                Text(
                    "This Client can now reconnect without pairing again.",
                    color = DepotColors.Ink2,
                    style = MonoStyle.copy(fontSize = 12.sp),
                    modifier = Modifier.padding(top = 4.dp),
                )
                Text(
                    shortId(device.clientIdentityPub),
                    color = DepotColors.Ink,
                    style = MonoStyle,
                    modifier = Modifier.padding(top = 8.dp),
                )
                TextButton(
                    onClick = onDismissResult,
                    contentPadding = PaddingValues(vertical = 8.dp),
                    modifier = Modifier.padding(top = 4.dp),
                ) {
                    Text("Dismiss", color = DepotColors.Ink2, style = MonoStyle)
                }
            }
        }

        state.error?.let { error ->
            Column(
                Modifier
                    .padding(top = 18.dp)
                    .fillMaxWidth()
                    .background(DepotColors.RedBg, RoundedCornerShape(9.dp))
                    .padding(12.dp),
            ) {
                Text(error, color = DepotColors.Red, style = MonoStyle)
                TextButton(onClick = onDismissResult, contentPadding = PaddingValues(vertical = 8.dp)) {
                    Text("Dismiss", color = DepotColors.Ink2, style = MonoStyle)
                }
            }
        }

        Text(
            "RECONNECTION",
            color = DepotColors.Ink3,
            style = MonoStyle.copy(fontSize = 11.sp, letterSpacing = 1.sp),
            modifier = Modifier.padding(top = 26.dp),
        )
        Text(
            "Paired Clients can only reach this Depot while it is listening.",
            color = DepotColors.Ink3,
            style = MonoStyle.copy(fontSize = 12.sp),
            modifier = Modifier.padding(top = 4.dp),
        )
        OutlinedTextField(
            value = state.signalUrl,
            onValueChange = onSignalUrlChange,
            label = { Text("Signal URL") },
            placeholder = { Text("ws://host:8080/ws", style = MonoStyle) },
            singleLine = true,
            enabled = state.listeningAs == null,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 10.dp),
            textStyle = MonoStyle.copy(fontSize = 12.sp),
        )
        Button(
            onClick = onToggleListening,
            modifier = Modifier.padding(top = 10.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = if (state.listeningAs != null) DepotColors.Surface2 else DepotColors.Amber,
                contentColor = if (state.listeningAs != null) DepotColors.Ink else DepotColors.Bg,
            ),
            shape = RoundedCornerShape(9.dp),
        ) {
            Text(if (state.listeningAs != null) "Stop listening" else "Start listening", fontSize = 16.sp)
        }
        state.listeningAs?.let { depotId ->
            Row(
                modifier = Modifier.padding(top = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(8.dp)
                        .background(DepotColors.Green, RoundedCornerShape(4.dp)),
                )
                Text(
                    "  listening as ${shortId(depotId)}",
                    color = DepotColors.Green,
                    style = MonoStyle.copy(fontSize = 12.sp),
                )
            }
        }

        Text(
            "FILE TO OFFER",
            color = DepotColors.Ink3,
            style = MonoStyle.copy(fontSize = 11.sp, letterSpacing = 1.sp),
            modifier = Modifier.padding(top = 26.dp),
        )
        Button(
            onClick = onPickFile,
            modifier = Modifier.padding(top = 10.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = DepotColors.Surface2,
                contentColor = DepotColors.Ink,
            ),
            shape = RoundedCornerShape(9.dp),
        ) {
            Text(if (state.offeredFileName == null) "Choose a file" else "Choose a different file")
        }
        state.offeredFileName?.let { name ->
            Text(
                "$name  (${state.offeredFileSize} bytes)",
                color = DepotColors.Ink,
                style = MonoStyle.copy(fontSize = 12.sp),
                modifier = Modifier.padding(top = 8.dp),
            )
        }

        if (state.progressTotal > 0) {
            Column(
                Modifier
                    .padding(top = 14.dp)
                    .fillMaxWidth()
                    .background(DepotColors.Surface, RoundedCornerShape(9.dp))
                    .padding(12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${state.progressIndex}/${state.progressTotal} chunks",
                        color = DepotColors.Ink,
                        style = MonoStyle.copy(fontSize = 12.sp),
                    )
                    state.connectionType?.let { type ->
                        Text(
                            "   ● $type",
                            // The artifact insists this is never hidden: a
                            // relayed path means bytes cross a third machine.
                            color = if (type == ConnectionType.RELAYED) DepotColors.Amber else DepotColors.Green,
                            style = MonoStyle.copy(fontSize = 12.sp),
                        )
                    }
                }
                Text(
                    "${state.bytesSent} / ${state.bytesTotal} bytes",
                    color = DepotColors.Ink3,
                    style = MonoStyle.copy(fontSize = 11.sp),
                    modifier = Modifier.padding(top = 4.dp),
                )
                LinearProgressIndicator(
                    progress = {
                        if (state.bytesTotal > 0) {
                            (state.bytesSent.toFloat() / state.bytesTotal.toFloat()).coerceIn(0f, 1f)
                        } else {
                            0f
                        }
                    },
                    color = DepotColors.Amber,
                    trackColor = DepotColors.Line,
                    modifier = Modifier
                        .padding(top = 10.dp)
                        .fillMaxWidth(),
                )
            }
        }

        if (state.devices.isNotEmpty()) {
            Text(
                "PAIRED DEVICES",
                color = DepotColors.Ink3,
                style = MonoStyle.copy(fontSize = 11.sp, letterSpacing = 1.sp),
                modifier = Modifier.padding(top = 26.dp),
            )
            for (device in state.devices) {
                DeviceRow(device = device, onRevoke = { onRevoke(device) })
            }
        }

        if (state.log.isNotEmpty()) {
            Text(
                "LOG",
                color = DepotColors.Ink3,
                style = MonoStyle.copy(fontSize = 11.sp, letterSpacing = 1.sp),
                modifier = Modifier.padding(top = 26.dp),
            )
            for (line in state.log) {
                Text(line, color = DepotColors.Ink2, style = MonoStyle.copy(fontSize = 12.sp))
            }
        }
    }
}
