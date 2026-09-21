package com.depot.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.depot.app.storage.DeviceRecord
import com.depot.app.transport.ConnectionType
import com.depot.app.ui.components.AppBar
import com.depot.app.ui.components.BrandMark
import com.depot.app.ui.components.ConnectionBadge
import com.depot.app.ui.components.Cta
import com.depot.app.ui.components.GrantSwitch
import com.depot.app.ui.components.HeroStat
import com.depot.app.ui.components.IconBlock
import com.depot.app.ui.components.IconFile
import com.depot.app.ui.components.IconGrant
import com.depot.app.ui.components.IconSettings
import com.depot.app.ui.components.IcoButton
import com.depot.app.ui.components.ListRow
import com.depot.app.ui.components.PulseRow
import com.depot.app.ui.components.RowTile
import com.depot.app.ui.components.SectionLabel
import com.depot.app.ui.components.StateDot
import com.depot.app.ui.components.StatusHero
import com.depot.app.ui.components.formatBytes
import com.depot.app.ui.components.formatDuration
import com.depot.app.ui.components.formatEta
import com.depot.app.ui.components.formatLastSeen
import com.depot.app.ui.components.formatRate
import com.depot.app.ui.theme.DepotColors
import com.depot.app.ui.theme.DepotType
import kotlinx.coroutines.delay

/**
 * HOME · DEPOT STATUS, as the interface artifact draws it: a status hero
 * with an accent bar carrying the live state, a strip of machine facts
 * under it, the grants, the linked devices, and one amber commitment
 * pinned to the bottom.
 */
@Composable
fun HomeScreen(
    state: DepotUiState,
    onToggleListening: () -> Unit,
    onOpenGrants: () -> Unit,
    onPickFile: () -> Unit,
    onOpenSettings: () -> Unit,
    onDeviceClick: (DeviceRecord) -> Unit,
    onLinkDevice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val listening = state.listeningAs != null

    Column(modifier.fillMaxSize().background(DepotColors.Bg).statusBarsPadding()) {
        AppBar(
            title = "Depot",
            sub = if (listening) "TERMINAL ONLINE" else "TERMINAL OFFLINE",
            subColor = if (listening) DepotColors.Green else DepotColors.Ink3,
            leading = { BrandMark(size = 32.dp) },
            action = {
                IcoButton(onClick = onOpenSettings) {
                    IconSettings(DepotColors.Ink2, 18.dp)
                }
            },
        )

        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            StatusHeroCard(state = state, onClick = onToggleListening)

            if (state.progressTotal > 0) {
                Spacer(Modifier.height(12.dp))
                TransferCard(state)
            }

            SectionLabel("SHARED")
            SharedSummaryRow(state = state, onOpen = onOpenGrants)
            SingleFileRow(state = state, onPickFile = onPickFile)

            SectionLabel("LINKED DEVICES")
            if (state.devices.isEmpty()) {
                EmptyDevices()
            } else {
                for (device in state.devices) {
                    LinkedDeviceRow(
                        device = device,
                        connection = state.connected[device.clientIdentityPub],
                        onClick = { onDeviceClick(device) },
                    )
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
            Cta(text = "Link a device", onClick = onLinkDevice)
        }
    }
}

@Composable
private fun StatusHeroCard(state: DepotUiState, onClick: () -> Unit) {
    val listening = state.listeningAs != null

    // Only ticks while there is an uptime to tick; an idle Depot should not
    // be recomposing this screen once a second for nothing.
    val now by produceState(System.currentTimeMillis(), state.listeningSince) {
        if (state.listeningSince == null) return@produceState
        while (true) {
            value = System.currentTimeMillis()
            delay(1000)
        }
    }

    StatusHero(
        accent = if (listening) DepotColors.Green else DepotColors.Line2,
        onClick = onClick,
    ) {
        PulseRow(
            text = if (listening) "ACCEPTING CONNECTIONS" else "OFFLINE · TAP TO START",
            color = if (listening) DepotColors.Green else DepotColors.Ink3,
            glow = if (listening) DepotColors.GreenGlow else Color.Transparent,
        )

        Row(
            Modifier.padding(top = 12.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Text("${state.devices.size}", style = DepotType.BigNum, color = DepotColors.Ink)
            Text(
                if (state.devices.size == 1) " device linked" else " devices linked",
                style = DepotType.Body.copy(fontSize = 16.sp),
                color = DepotColors.Ink3,
                modifier = Modifier.padding(bottom = 5.dp),
            )
        }

        Box(
            Modifier
                .fillMaxWidth()
                .padding(top = 16.dp)
                .height(1.dp)
                .background(DepotColors.Line),
        )
        Row(
            Modifier.fillMaxWidth().padding(top = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            HeroStat(
                label = "SHARED",
                value = if (state.offeredFiles.isEmpty()) {
                    "—"
                } else {
                    formatBytes(state.offeredFiles.sumOf { it.size.toLong() })
                },
                modifier = Modifier.weight(1f),
            )
            HeroStat(
                label = "MOVED TODAY",
                value = if (state.movedToday == 0L) "—" else formatBytes(state.movedToday),
                modifier = Modifier.weight(1f),
            )
            HeroStat(
                label = "UPTIME",
                value = state.listeningSince?.let { formatDuration(now - it) } ?: "—",
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/**
 * `.xfer` — the artifact's transfer readout, with the connection badge
 * sitting in it. Throughput and route are shown together deliberately: a
 * slow transfer over a relay is a different fact from a slow transfer
 * direct, and the user can only tell them apart if both are on screen.
 */
@Composable
private fun TransferCard(state: DepotUiState) {
    // The clock advances with each progress report rather than on a timer:
    // progress is the only thing that changes the numbers anyway.
    val startedAt = remember(state.bytesTotal, state.offeredFiles.size) { System.currentTimeMillis() }
    val now = remember(state.bytesSent) { System.currentTimeMillis() }
    val elapsed = (now - startedAt).coerceAtLeast(1L)
    val rate = state.bytesSent * 1000.0 / elapsed
    val fraction =
        if (state.bytesTotal > 0) (state.bytesSent.toFloat() / state.bytesTotal).coerceIn(0f, 1f) else 0f

    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(DepotColors.Surface)
            .border(1.dp, DepotColors.Line2, shape)
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                state.offeredFiles.firstOrNull()?.name ?: "Transferring",
                style = DepotType.RowName.copy(fontSize = 15.sp),
                color = DepotColors.Ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                "${(fraction * 100).toInt()}%",
                style = DepotType.Fact,
                color = DepotColors.Amber,
                modifier = Modifier.padding(start = 10.dp),
            )
        }

        Box(
            Modifier
                .fillMaxWidth()
                .padding(top = 13.dp)
                .height(4.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(DepotColors.Line),
        ) {
            Box(
                Modifier
                    .fillMaxWidth(fraction)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(2.dp))
                    .background(DepotColors.Amber),
            )
        }

        Row(
            Modifier.fillMaxWidth().padding(top = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Metric(formatRate(rate), "")
            Spacer(Modifier.width(16.dp))
            Metric(formatBytes(state.bytesTotal - state.bytesSent), "left")
            Spacer(Modifier.width(16.dp))
            Metric(formatEta(state.bytesTotal - state.bytesSent, rate), "eta")
            Spacer(Modifier.weight(1f))
            state.connectionType?.let { RouteBadge(it) }
        }
    }
}

@Composable
private fun Metric(value: String, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(value, style = DepotType.FactSmall, color = DepotColors.Ink2)
        if (label.isNotEmpty()) {
            Text(
                " $label",
                style = DepotType.FactSmall,
                color = DepotColors.Ink3,
            )
        }
    }
}

/**
 * DIRECT or RELAYED. Amber for relayed is not decoration — it is the one
 * case where bytes cross a machine that is not one of the two endpoints,
 * and the artifact insists that fact is never hidden.
 */
@Composable
fun RouteBadge(type: ConnectionType, modifier: Modifier = Modifier) {
    val relayed = type == ConnectionType.RELAYED
    ConnectionBadge(
        label = if (relayed) "RELAYED" else "DIRECT",
        color = if (relayed) DepotColors.Amber else DepotColors.Green,
        borderColor = if (relayed) DepotColors.AmberDim else DepotColors.GreenLine,
        modifier = modifier,
    )
}

/**
 * What a Client would see if it connected now, in one line. The list
 * itself, and the argument about what is *not* shared, live on the ACCESS
 * screen where the interface spec puts them.
 */
@Composable
private fun SharedSummaryRow(state: DepotUiState, onOpen: () -> Unit) {
    val folders = state.grants.count { it.grant.enabled }
    val files = state.offeredFiles
    val fileBytes = files.sumOf { it.size.toLong() }
    val sharing = folders > 0 || files.isNotEmpty()

    val meta = when {
        !sharing -> "A CLIENT WOULD SEE AN EMPTY DEPOT"
        folders == 0 -> {
            val count = if (files.size == 1) "ONE FILE" else "${files.size} FILES"
            "$count · ${formatBytes(fileBytes)}"
        }
        else -> {
            val bytes = state.grants.filter { it.grant.enabled }.sumOf { it.bytes ?: 0L }
            val folderText = if (folders == 1) "1 FOLDER" else "$folders FOLDERS"
            val fileText = when (files.size) {
                0 -> ""
                1 -> " + 1 FILE"
                else -> " + ${files.size} FILES"
            }
            "$folderText$fileText · ${formatBytes(bytes + fileBytes)}"
        }
    }

    ListRow(
        name = if (sharing) "Shared folders" else "Nothing is shared yet",
        meta = meta,
        nameColor = if (sharing) DepotColors.Ink else DepotColors.Ink2,
        onClick = onOpen,
        leading = {
            RowTile { IconGrant(if (sharing) DepotColors.Amber else DepotColors.Ink3, 18.dp) }
        },
        trailing = { GrantSwitch(on = sharing) },
    )
}

/**
 * One file, shared on its own, without granting a folder around it.
 *
 * Kept beside the folder summary rather than inside the ACCESS screen
 * because it is the quickest thing anyone wants to do — the same reason
 * Depot also accepts a share from another app's share sheet.
 */
@Composable
private fun SingleFileRow(state: DepotUiState, onPickFile: () -> Unit) {
    val files = state.offeredFiles
    val total = files.sumOf { it.size.toLong() }
    ListRow(
        name = when (files.size) {
            0 -> "Share files"
            1 -> files[0].name
            else -> "${files.size} files shared"
        },
        meta = if (files.isEmpty()) {
            "WITHOUT GRANTING A WHOLE FOLDER"
        } else {
            "${formatBytes(total)} · TAP TO ADD MORE"
        },
        nameColor = if (files.isEmpty()) DepotColors.Ink2 else DepotColors.Ink,
        onClick = onPickFile,
        leading = {
            RowTile { IconFile(if (files.isEmpty()) DepotColors.Ink3 else DepotColors.Amber, 18.dp) }
        },
        trailing = { GrantSwitch(on = files.isNotEmpty()) },
    )
}

@Composable
private fun LinkedDeviceRow(
    device: DeviceRecord,
    connection: ConnectionType?,
    onClick: () -> Unit,
) {
    val meta = when {
        device.revoked -> "REVOKED"
        connection == ConnectionType.RELAYED -> "RELAYED · ACTIVE NOW"
        connection != null -> "DIRECT · ACTIVE NOW"
        else -> "IDLE · ${formatLastSeen(device.lastSeenAt)}"
    }
    ListRow(
        name = device.label,
        meta = meta,
        nameColor = if (device.revoked) DepotColors.Ink3 else DepotColors.Ink,
        metaColor = if (device.revoked) DepotColors.Red else DepotColors.Ink3,
        onClick = onClick,
        leading = {
            RowTile {
                IconBlock(
                    when {
                        device.revoked -> DepotColors.Ink3
                        connection != null -> DepotColors.Green
                        else -> DepotColors.Ink2
                    },
                    18.dp,
                )
            }
        },
        trailing = {
            StateDot(
                when {
                    device.revoked -> DepotColors.Red
                    connection != null -> DepotColors.Green
                    else -> DepotColors.Line2
                },
            )
        },
    )
}

@Composable
private fun EmptyDevices() {
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .border(1.dp, DepotColors.Line, shape)
            .padding(horizontal = 16.dp, vertical = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            "NO DEVICES LINKED",
            style = DepotType.Label,
            color = DepotColors.Ink3,
        )
        Text(
            "Open the Depot page in a browser and scan its code to link it.",
            style = DepotType.Body.copy(fontSize = 13.sp),
            color = DepotColors.Ink3,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}
