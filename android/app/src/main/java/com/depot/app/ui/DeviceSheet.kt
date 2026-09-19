package com.depot.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.depot.app.storage.DeviceRecord
import com.depot.app.transport.ConnectionType
import com.depot.app.ui.components.BottomSheet
import com.depot.app.ui.components.DepotTextField
import com.depot.app.ui.components.SheetButton
import com.depot.app.ui.components.SheetKicker
import com.depot.app.ui.components.fingerprint
import com.depot.app.ui.components.formatDateTime
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotType

/**
 * One linked device, and the two things a person ever wants to do with
 * one: call it something they will recognise, or cut it off.
 */
@Composable
fun DeviceSheet(
    device: DeviceRecord,
    connection: ConnectionType?,
    onRename: (String) -> Unit,
    onRevoke: () -> Unit,
    onForget: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var name by remember(device.clientIdentityPub) { mutableStateOf(device.label) }
    var confirmingRevoke by remember(device.clientIdentityPub) { mutableStateOf(false) }

    BottomSheet(modifier = modifier, onDismiss = onClose) {
        SheetKicker(
            when {
                device.revoked -> "REVOKED"
                connection == ConnectionType.RELAYED -> "LINKED · RELAYED"
                connection != null -> "LINKED · DIRECT"
                else -> "LINKED · IDLE"
            },
            color = when {
                device.revoked -> DepotColors.Red
                connection == ConnectionType.RELAYED -> DepotColors.Amber
                connection != null -> DepotColors.Green
                else -> DepotColors.Ink3
            },
        )

        DepotTextField(
            value = name,
            onValueChange = { name = it },
            placeholder = "Name this device",
            enabled = !device.revoked,
            textStyle = DepotType.Body.copy(fontSize = 17.sp),
            modifier = Modifier.padding(top = 14.dp),
        )

        Text(
            fingerprint(device.clientIdentityPub, groups = 6),
            style = DepotType.FactSmall,
            color = DepotColors.Ink3,
            modifier = Modifier.padding(top = 14.dp),
        )
        Text(
            "LINKED ${formatDateTime(device.createdAt).uppercase()}",
            style = DepotType.FactSmall,
            color = DepotColors.Ink3,
            modifier = Modifier.padding(top = 4.dp),
        )
        Text(
            "LAST SEEN ${formatDateTime(device.lastSeenAt).uppercase()}",
            style = DepotType.FactSmall,
            color = DepotColors.Ink3,
            modifier = Modifier.padding(top = 4.dp),
        )

        Spacer(Modifier.height(20.dp))

        if (device.revoked) {
            Text(
                "This device's credential is no longer honoured. It can be linked " +
                    "again from scratch, with a fresh code and a fresh comparison.",
                style = DepotType.Body.copy(fontSize = 13.sp),
                color = DepotColors.Ink3,
                modifier = Modifier.padding(bottom = 18.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                // Forgetting changes nothing about access — the device is
                // already refused. It only stops the list mentioning it.
                SheetButton(
                    "Forget",
                    primary = false,
                    onClick = onForget,
                    modifier = Modifier.weight(1f),
                )
                SheetButton("Close", primary = true, onClick = onClose, modifier = Modifier.weight(1f))
            }
        } else if (confirmingRevoke) {
            Text(
                // §6: revocation is the Depot refusing the §4 handshake.
                // Saying what actually happens is more use than "are you
                // sure?", because the consequence is the decision.
                "Cutting this device off takes effect immediately, including " +
                    "mid-transfer. It will have to be linked again from a new code.",
                style = DepotType.Body.copy(fontSize = 13.sp),
                color = DepotColors.Ink2,
                modifier = Modifier.padding(bottom = 18.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                SheetButton(
                    "Keep",
                    primary = false,
                    onClick = { confirmingRevoke = false },
                    modifier = Modifier.weight(1f),
                )
                SheetButton(
                    "Cut it off",
                    primary = true,
                    onClick = onRevoke,
                    modifier = Modifier.weight(1f),
                )
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                SheetButton(
                    "Revoke",
                    primary = false,
                    onClick = { confirmingRevoke = true },
                    modifier = Modifier.weight(1f),
                )
                SheetButton(
                    "Save",
                    primary = true,
                    onClick = { onRename(name) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}
