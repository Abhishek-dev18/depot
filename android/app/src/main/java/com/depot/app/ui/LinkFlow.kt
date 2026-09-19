package com.depot.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.depot.app.storage.DeviceRecord
import com.depot.app.ui.components.BottomSheet
import com.depot.app.ui.components.DepotTextField
import com.depot.app.ui.components.FailState
import com.depot.app.ui.components.IconCheck
import com.depot.app.ui.components.IconDiamond
import com.depot.app.ui.components.IconUp
import com.depot.app.ui.components.OptionRow
import com.depot.app.ui.components.SheetButton
import com.depot.app.ui.components.SheetKicker
import com.depot.app.ui.components.fingerprint
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotType

/**
 * `.sasdigits` — the artifact is explicit that this is the hero of its
 * screen, not an alert. The digits are the largest thing in view, in the
 * accent colour, under a question phrased as an action, because comparing
 * them is the single step that stops a Signal-in-the-middle (§3.4).
 */
@Composable
fun SasDigits(sas: String, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        for (digit in sas) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(54.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(DepotColors.AmberBg),
                contentAlignment = Alignment.Center,
            ) {
                Text(digit.toString(), style = DepotType.SasDigit, color = DepotColors.Amber)
            }
        }
    }
}

/**
 * APPROVE · SAS CHECK. Reject is a real button with equal footing, not a
 * dismissal in the corner: a check that only offers one answer is not a
 * check.
 */
@Composable
fun ApproveSheet(
    sas: String,
    via: String,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BottomSheet(modifier = modifier) {
        SheetKicker("VERIFY BEFORE APPROVING")
        Text(
            "A Client wants to link",
            style = DepotType.Title,
            color = DepotColors.Ink,
            modifier = Modifier.padding(top = 13.dp),
        )
        Text(
            // Not a location or a device name: the Depot genuinely does
            // not know either yet, and printing an unverified claim here
            // would undercut the comparison the screen is asking for.
            "VIA ${via.ifBlank { "SIGNAL" }}\nREQUESTED JUST NOW",
            style = DepotType.FactSmall,
            color = DepotColors.Ink3,
            modifier = Modifier.padding(top = 6.dp),
        )

        Column(
            Modifier
                .fillMaxWidth()
                .padding(top = 18.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(DepotColors.AmberBgFaint)
                .border(1.dp, DepotColors.AmberDim, RoundedCornerShape(12.dp))
                .padding(14.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                "DOES THE CLIENT SHOW THIS NUMBER?",
                style = DepotType.Label.copy(letterSpacing = 0.13.em),
                color = DepotColors.Ink2,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(12.dp))
            SasDigits(sas)
        }

        Text(
            "If the numbers differ, someone may be intercepting the connection. Reject it.",
            style = DepotType.Body.copy(fontSize = 13.sp),
            color = DepotColors.Ink3,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 18.dp),
        )

        Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            SheetButton("Reject", primary = false, onClick = onReject, modifier = Modifier.weight(1f))
            SheetButton("Approve", primary = true, onClick = onApprove, modifier = Modifier.weight(1f))
        }
    }
}

/** Step 2 is under way and there is nothing for the user to do but wait. */
@Composable
fun LinkingSheet(status: String?, onCancel: () -> Unit, modifier: Modifier = Modifier) {
    BottomSheet(modifier = modifier) {
        SheetKicker("STEP 2 OF 2")
        Text(
            "Linking",
            style = DepotType.Title,
            color = DepotColors.Ink,
            modifier = Modifier.padding(top = 13.dp),
        )
        Text(
            (status ?: "starting").uppercase(),
            style = DepotType.FactSmall,
            color = DepotColors.Ink3,
            modifier = Modifier.padding(top = 6.dp, bottom = 20.dp),
        )
        SheetButton("Cancel", primary = false, onClick = onCancel, modifier = Modifier.fillMaxWidth())
    }
}

/**
 * Pairing settled. The name is asked for here rather than invented,
 * because the Client never sends one — and a name a Client could assert
 * about itself would be worth nothing anyway.
 */
@Composable
fun PairedSheet(
    device: DeviceRecord,
    onSave: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var name by remember(device.clientIdentityPub) { mutableStateOf(device.label) }

    BottomSheet(modifier = modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(DepotColors.GreenBg),
                contentAlignment = Alignment.Center,
            ) {
                IconCheck(DepotColors.Green, 18.dp)
            }
            Spacer(Modifier.width(12.dp))
            Column {
                Text("Linked", style = DepotType.Title, color = DepotColors.Ink)
                Text(
                    "THIS CLIENT CAN NOW RECONNECT ON ITS OWN",
                    style = DepotType.Label.copy(letterSpacing = 0.1.em),
                    color = DepotColors.Ink3,
                    modifier = Modifier.padding(top = 3.dp),
                )
            }
        }

        Text(
            fingerprint(device.clientIdentityPub),
            style = DepotType.Fact,
            color = DepotColors.Ink2,
            modifier = Modifier.padding(top = 18.dp),
        )

        Text(
            "WHAT SHOULD THIS DEVICE BE CALLED?",
            style = DepotType.Label,
            color = DepotColors.Ink3,
            modifier = Modifier.padding(top = 18.dp, bottom = 9.dp),
        )
        DepotTextField(
            value = name,
            onValueChange = { name = it },
            placeholder = "Laptop, work desktop, …",
            textStyle = DepotType.Body.copy(fontSize = 15.sp),
        )

        Spacer(Modifier.height(18.dp))
        SheetButton("Done", primary = true, onClick = { onSave(name) }, modifier = Modifier.fillMaxWidth())
    }
}

/**
 * A dead end, in the shape the artifact gives them: what happened, why,
 * and two concrete things to do about it — never a spinner and a vague
 * "try again".
 */
@Composable
fun LinkFailSheet(
    message: String,
    onRetry: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BottomSheet(modifier = modifier, onDismiss = onClose) {
        FailState(
            title = "Linking did not finish",
            body = message,
        ) {
            OptionRow(
                title = "Refresh the code and scan again",
                detail = "A PAIRING CODE IS SINGLE-USE AND EXPIRES AFTER TWO MINUTES",
                icon = { IconUp(DepotColors.Amber, 16.dp) },
                onClick = onRetry,
            )
            OptionRow(
                title = "Check both devices reach the same Signal server",
                detail = "SETTINGS › SIGNAL SERVER · THE QR CARRIES THIS ADDRESS",
                icon = { IconDiamond(DepotColors.Amber, 16.dp) },
                onClick = onClose,
            )
        }
        Spacer(Modifier.height(14.dp))
        SheetButton("Close", primary = false, onClick = onClose, modifier = Modifier.fillMaxWidth())
    }
}

/**
 * The paste fallback. §3.1 means the camera is the intended path — it is
 * the one channel Signal cannot reach — so this stays a secondary route
 * off the scanner rather than a peer of it.
 */
@Composable
fun PasteSheet(
    payload: String,
    onPayloadChange: (String) -> Unit,
    onJoin: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    BottomSheet(modifier = modifier, onDismiss = onCancel) {
        SheetKicker("FALLBACK · PASTE THE PAYLOAD", color = DepotColors.Ink3)
        Text(
            "Paste instead",
            style = DepotType.Title,
            color = DepotColors.Ink,
            modifier = Modifier.padding(top = 13.dp),
        )
        Text(
            "Scanning is what keeps the Signal server out of the exchange. " +
                "Use this only when there is no camera to point at the code.",
            style = DepotType.Body.copy(fontSize = 13.sp),
            color = DepotColors.Ink3,
            modifier = Modifier.padding(top = 6.dp, bottom = 16.dp),
        )
        DepotTextField(
            value = payload,
            onValueChange = onPayloadChange,
            placeholder = "{\"v\":1,\"s\":\"ws://…\"}",
            singleLine = false,
            minHeight = 104.dp,
            textStyle = DepotType.FactSmall,
        )
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            SheetButton("Cancel", primary = false, onClick = onCancel, modifier = Modifier.weight(1f))
            SheetButton("Link", primary = true, onClick = onJoin, modifier = Modifier.weight(1f))
        }
    }
}
