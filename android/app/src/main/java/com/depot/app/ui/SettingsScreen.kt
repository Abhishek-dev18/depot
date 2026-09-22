package com.depot.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.depot.app.storage.TurnSettings
import com.depot.app.transport.NetworkPreference
import com.depot.app.transport.NetworkType
import com.depot.app.ui.components.Cta
import com.depot.app.ui.components.DepotTextField
import com.depot.app.ui.components.ListRow
import com.depot.app.ui.components.IconBack
import com.depot.app.ui.components.AppBar
import com.depot.app.ui.components.IcoButton
import com.depot.app.ui.components.SectionLabel
import com.depot.app.ui.components.fingerprint
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotType

/**
 * Everything the terminal needs to come up, and the running account of
 * what it has been doing. The log lives here rather than on the home
 * screen: it is the most useful thing in the app when something is wrong
 * and the least interesting when nothing is.
 */
@Composable
fun SettingsScreen(
    state: DepotUiState,
    onSignalUrlChange: (String) -> Unit,
    onTurnChange: (TurnSettings) -> Unit,
    onNetworkPreference: (NetworkPreference) -> Unit,
    onToggleListening: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val listening = state.listeningAs != null

    Column(modifier.fillMaxSize().background(DepotColors.Bg).statusBarsPadding()) {
        AppBar(
            title = "Settings",
            sub = "TERMINAL CONFIGURATION",
            action = {
                IcoButton(onClick = onBack) { IconBack(DepotColors.Ink2, 16.dp) }
            },
        )

        Column(
            Modifier
                .weight(1f)
                // Outside the scroll, so the keyboard shrinks the area
                // being scrolled rather than covering the bottom of it:
                // the TURN fields sit low enough to be hidden otherwise,
                // and this window is edge-to-edge, which makes the
                // manifest's adjustResize a no-op.
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            SectionLabel("SIGNAL SERVER")
            DepotTextField(
                value = state.signalUrl,
                onValueChange = onSignalUrlChange,
                placeholder = "ws://192.168.1.11:8080/ws",
                // Changing the address out from under a live registration
                // would leave the UI describing a server it is not on.
                enabled = !listening,
                textStyle = DepotType.FactSmall,
            )
            Text(
                if (listening) {
                    "Stop the terminal to change this."
                } else {
                    "The relay both devices meet through. It learns nothing " +
                        "it could read — it only forwards sealed envelopes — but both " +
                        "sides have to name the same one."
                },
                style = DepotType.Body.copy(fontSize = 13.sp),
                color = DepotColors.Ink3,
                modifier = Modifier.padding(top = 9.dp),
            )

            SectionLabel("CONNECTION")
            Text(
                "Detected, not asked for: this phone can see which network it is on, and a " +
                    "setting you have to remember to change is wrong the moment you leave the " +
                    "house. What it decides is whether bytes are worth compressing before they " +
                    "are sent — on a plan you pay for by the byte, spending a little battery to " +
                    "send fewer of them is the trade most people would want.",
                style = DepotType.Body.copy(fontSize = 13.sp),
                color = DepotColors.Ink3,
                modifier = Modifier.padding(bottom = 10.dp),
            )
            ListRow(
                name = when (state.network.type) {
                    NetworkType.WIFI -> "Wi-Fi"
                    NetworkType.CELLULAR -> "Mobile data"
                    NetworkType.OTHER -> "Wired or tethered"
                    NetworkType.UNKNOWN -> "Not connected"
                },
                meta = if (state.network.metered) {
                    "METERED · BYTES ARE WORTH COMPRESSING"
                } else {
                    "UNMETERED · SPEED DECIDES"
                },
                nameColor = DepotColors.Ink,
                metaColor = if (state.network.metered) DepotColors.Amber else DepotColors.Ink3,
            )
            // The override, for when the reading is wrong — a hotspot the
            // system has not been told is metered, most often. It changes
            // what is assumed about cost; it cannot move the phone onto a
            // different network and does not pretend to.
            Row(Modifier.padding(bottom = 6.dp)) {
                for (option in NetworkPreference.entries) {
                    val chosen = state.networkPreference == option
                    Text(
                        when (option) {
                            NetworkPreference.AUTO -> "AUTO"
                            NetworkPreference.WIFI -> "TREAT AS WI-FI"
                            NetworkPreference.CELLULAR -> "TREAT AS MOBILE"
                        },
                        style = DepotType.Label,
                        color = if (chosen) DepotColors.Amber else DepotColors.Ink3,
                        modifier = Modifier
                            .clickable { onNetworkPreference(option) }
                            .padding(end = 16.dp, top = 6.dp, bottom = 10.dp),
                    )
                }
            }

            SectionLabel("RELAY (OPTIONAL)")
            Text(
                "Only needed when a direct or STUN-assisted connection fails — usually " +
                    "because this phone is on mobile data behind carrier NAT. Your own " +
                    "server, so relayed bytes still cross only machines you chose.",
                style = DepotType.Body.copy(fontSize = 13.sp),
                color = DepotColors.Ink3,
                modifier = Modifier.padding(bottom = 10.dp),
            )
            DepotTextField(
                value = state.turn.url,
                onValueChange = { onTurnChange(state.turn.copy(url = it)) },
                placeholder = "turn:turn.example.com:3478",
                enabled = !listening,
                textStyle = DepotType.FactSmall,
            )
            Spacer(Modifier.height(9.dp))
            DepotTextField(
                value = state.turn.username,
                onValueChange = { onTurnChange(state.turn.copy(username = it)) },
                placeholder = "username",
                enabled = !listening,
                textStyle = DepotType.FactSmall,
            )
            Spacer(Modifier.height(9.dp))
            DepotTextField(
                value = state.turn.credential,
                onValueChange = { onTurnChange(state.turn.copy(credential = it)) },
                placeholder = "credential",
                enabled = !listening,
                textStyle = DepotType.FactSmall,
            )

            SectionLabel("THIS DEPOT")
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(DepotColors.Surface)
                    .border(1.dp, DepotColors.Line, RoundedCornerShape(12.dp))
                    .padding(16.dp),
            ) {
                Text("IDENTITY", style = DepotType.Label, color = DepotColors.Ink3)
                Text(
                    state.listeningAs?.let { fingerprint(it, groups = 6) }
                        ?: "NOT REGISTERED YET",
                    style = DepotType.Fact,
                    color = if (listening) DepotColors.Ink else DepotColors.Ink3,
                    modifier = Modifier.padding(top = 6.dp),
                )
                Text(
                    "The key a Client proves it is talking to. It is wrapped by " +
                        "the phone's hardware keystore and never leaves the device.",
                    style = DepotType.Body.copy(fontSize = 13.sp),
                    color = DepotColors.Ink3,
                    modifier = Modifier.padding(top = 10.dp),
                )
            }

            SectionLabel("ACTIVITY")
            if (state.log.isEmpty()) {
                Text(
                    "Nothing yet.",
                    style = DepotType.FactSmall,
                    color = DepotColors.Ink3,
                )
            } else {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(DepotColors.Bg2)
                        .border(1.dp, DepotColors.Line, RoundedCornerShape(12.dp))
                        .padding(14.dp),
                ) {
                    for (line in state.log.takeLast(200)) {
                        Row(Modifier.padding(vertical = 2.dp)) {
                            Box(
                                Modifier
                                    .padding(top = 7.dp)
                                    .height(1.dp)
                                    .width(8.dp)
                                    .background(DepotColors.Line2),
                            )
                            Text(
                                line,
                                style = DepotType.FactSmall,
                                color = DepotColors.Ink2,
                                modifier = Modifier.padding(start = 9.dp),
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(24.dp))
        }

        Box(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 20.dp, vertical = 16.dp),
        ) {
            Cta(
                text = if (listening) "Stop the terminal" else "Start the terminal",
                onClick = onToggleListening,
                enabled = listening || state.signalUrl.isNotBlank(),
            )
        }
    }
}
