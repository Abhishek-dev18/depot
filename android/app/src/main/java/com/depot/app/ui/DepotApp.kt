package com.depot.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.depot.app.storage.DeviceRecord
import com.depot.app.ui.components.BottomSheet
import com.depot.app.ui.components.FailState
import com.depot.app.ui.components.SheetButton
import com.depot.app.ui.theme.DepotColors

/**
 * The shell that holds the artifact's phone frames together.
 *
 * There is no tab bar, because the artifact has none: a Depot has one home
 * screen, and everything else — scanning, approving, a device, the
 * settings — arrives over it and then goes away again. That keeps the
 * status of the terminal itself continuously in view, which is the thing
 * the screen is actually for.
 */
@Composable
fun DepotApp(
    state: DepotUiState,
    onToggleListening: () -> Unit,
    onPickFile: () -> Unit,
    onAddFolder: () -> Unit,
    onToggleGrant: (GrantView, Boolean) -> Unit,
    onForgetGrant: (GrantView) -> Unit,
    onSignalUrlChange: (String) -> Unit,
    onPayloadChange: (String) -> Unit,
    onLink: () -> Unit,
    onQrScanned: (String) -> Unit,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    onCancelLink: () -> Unit,
    onDismissResult: () -> Unit,
    onRename: (DeviceRecord, String) -> Unit,
    onRevoke: (DeviceRecord) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Saveable rather than remembered: a rotation should not close the
    // viewfinder the user is holding over a QR code.
    var settingsOpen by rememberSaveable { mutableStateOf(false) }
    var grantsOpen by rememberSaveable { mutableStateOf(false) }
    var scanning by rememberSaveable { mutableStateOf(false) }
    var pasting by rememberSaveable { mutableStateOf(false) }
    var selectedDeviceId by rememberSaveable { mutableStateOf<String?>(null) }

    // Looked up each recomposition so a rename or a revoke is reflected in
    // the open sheet rather than in a stale copy of the record.
    val selectedDevice = selectedDeviceId?.let { id ->
        state.devices.find { it.clientIdentityPub == id }
    }

    val sheetOpen = state.sas != null ||
        state.justPaired != null ||
        state.error != null ||
        state.linking ||
        pasting ||
        selectedDevice != null

    BackHandler(enabled = scanning || sheetOpen || settingsOpen || grantsOpen) {
        when {
            state.sas != null -> onReject()
            state.justPaired != null -> onDismissResult()
            state.error != null -> onDismissResult()
            pasting -> { pasting = false; onCancelLink() }
            state.linking -> onCancelLink()
            selectedDevice != null -> selectedDeviceId = null
            scanning -> { scanning = false; onCancelLink() }
            grantsOpen -> grantsOpen = false
            settingsOpen -> settingsOpen = false
        }
    }

    Box(modifier.fillMaxSize().background(DepotColors.Bg)) {
        if (scanning) {
            QrScannerScreen(
                onScanned = { payload ->
                    scanning = false
                    onQrScanned(payload)
                },
                onCancel = {
                    scanning = false
                    onCancelLink()
                },
                onPaste = {
                    scanning = false
                    pasting = true
                },
            )
        } else if (grantsOpen) {
            GrantsScreen(
                grants = state.grants,
                offeredFileName = state.offeredFileName,
                offeredFileSize = state.offeredFileSize,
                onAddFolder = onAddFolder,
                onToggle = onToggleGrant,
                onForget = onForgetGrant,
                onPickFile = onPickFile,
                onBack = { grantsOpen = false },
            )
        } else if (settingsOpen) {
            SettingsScreen(
                state = state,
                onSignalUrlChange = onSignalUrlChange,
                onToggleListening = onToggleListening,
                onBack = { settingsOpen = false },
            )
        } else {
            HomeScreen(
                state = state,
                onToggleListening = {
                    // Nothing to register with yet: send the user where
                    // they can say so rather than raising an error at them.
                    if (state.listeningAs == null && state.signalUrl.isBlank()) {
                        settingsOpen = true
                    } else {
                        onToggleListening()
                    }
                },
                onOpenGrants = { grantsOpen = true },
                onOpenSettings = { settingsOpen = true },
                onDeviceClick = { selectedDeviceId = it.clientIdentityPub },
                onLinkDevice = { scanning = true },
            )
        }

        // One question at a time. The order is the order they can occur in.
        when {
            state.sas != null -> ApproveSheet(
                sas = state.sas,
                via = state.signalUrl,
                onApprove = onApprove,
                onReject = onReject,
            )

            state.justPaired != null -> PairedSheet(
                device = state.justPaired,
                onSave = { name ->
                    onRename(state.justPaired, name)
                    onDismissResult()
                },
            )

            // A failure with a link status behind it belongs to the link
            // flow, and gets that flow's options; anything else is the
            // terminal's own problem.
            state.error != null && state.linkStatus != null -> LinkFailSheet(
                message = state.error,
                onRetry = {
                    onDismissResult()
                    scanning = true
                },
                onClose = onDismissResult,
            )

            state.error != null -> ErrorSheet(
                message = state.error,
                onClose = onDismissResult,
            )

            pasting -> PasteSheet(
                payload = state.payload,
                onPayloadChange = onPayloadChange,
                onJoin = {
                    pasting = false
                    onLink()
                },
                onCancel = {
                    pasting = false
                    onCancelLink()
                },
            )

            state.linking -> LinkingSheet(
                status = state.linkStatus,
                onCancel = onCancelLink,
            )

            selectedDevice != null -> DeviceSheet(
                device = selectedDevice,
                connection = state.connected[selectedDevice.clientIdentityPub],
                onRename = { name ->
                    onRename(selectedDevice, name)
                    selectedDeviceId = null
                },
                onRevoke = {
                    onRevoke(selectedDevice)
                    selectedDeviceId = null
                },
                onClose = { selectedDeviceId = null },
            )
        }
    }
}

/** Anything that went wrong outside the link flow. */
@Composable
private fun ErrorSheet(message: String, onClose: () -> Unit) {
    BottomSheet(onDismiss = onClose) {
        FailState(title = "Something went wrong", body = message)
        Spacer(Modifier.height(20.dp))
        SheetButton("Close", primary = false, onClick = onClose, modifier = Modifier.fillMaxWidth())
    }
}
