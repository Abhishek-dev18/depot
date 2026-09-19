package com.depot.app.ui

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.depot.app.pairing.DepotPairingCallbacks
import com.depot.app.pairing.QrPayload
import com.depot.app.pairing.runDepotPairing
import com.depot.app.service.DepotService
import com.depot.app.service.DepotSession
import com.depot.app.storage.DeviceRecord
import com.depot.app.storage.DeviceStore
import com.depot.app.storage.Grant
import com.depot.app.storage.GrantStore
import com.depot.app.storage.Settings
import com.depot.app.storage.TurnSettings
import com.depot.app.transport.ConnectionType
import com.depot.app.transport.OfferedFile
import com.depot.app.transport.grantStats
import com.depot.app.ui.components.formatBytes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * One granted folder, with the figures the ACCESS screen puts under its
 * name. The counts are absent until they have been read off the provider,
 * which is a disk query and does not belong on the main thread.
 */
data class GrantView(val grant: Grant, val files: Int? = null, val bytes: Long? = null) {
    fun summary(): String = when {
        !grant.enabled -> "NOT SHARED"
        files == null -> "READING…"
        else -> "$files FILES · ${formatBytes(bytes ?: 0L)}"
    }
}

/** Everything the interface draws, in one place. */
data class DepotUiState(
    // The link flow.
    val payload: String = "",
    val linking: Boolean = false,
    val sas: String? = null,
    val justPaired: DeviceRecord? = null,
    val linkStatus: String? = null,
    val error: String? = null,

    // What is linked.
    val devices: List<DeviceRecord> = emptyList(),

    // What is shared.
    val grants: List<GrantView> = emptyList(),

    // The terminal.
    val signalUrl: String = "",
    val turn: TurnSettings = TurnSettings(),
    val listeningAs: String? = null,
    val listeningSince: Long? = null,
    val connected: Map<String, ConnectionType> = emptyMap(),
    val connectionType: ConnectionType? = null,
    val progressIndex: Int = 0,
    val progressTotal: Int = 0,
    val bytesSent: Long = 0,
    val bytesTotal: Long = 0,
    val movedToday: Long = 0,
    val offeredFileName: String? = null,
    val offeredFileSize: Int = 0,
    val log: List<String> = emptyList(),
)

class DepotViewModel(app: Application) : AndroidViewModel(app) {

    private val _state = MutableStateFlow(
        DepotUiState(signalUrl = Settings.signalUrl(app), turn = Settings.turn(app)),
    )
    val state: StateFlow<DepotUiState> = _state.asStateFlow()

    /** Set while the SAS is on screen; one of these releases the flow. */
    private var approve: (() -> Unit)? = null
    private var reject: (() -> Unit)? = null

    /**
     * Bumped whenever a link attempt is abandoned. A pairing coroutine
     * that finishes after the user walked away belongs to an older
     * generation, and its callbacks are dropped rather than reopening a
     * sheet on a screen that has moved on.
     */
    private var linkGeneration = 0

    /** The link flow writes its own log; the listening session owns the rest. */
    private var linkLog: List<String> = emptyList()

    init {
        refreshDevices()
        refreshGrants()
        observeSession()
    }

    /**
     * Mirrors DepotSession's process-scoped state into this screen's, so
     * the UI picks up a session that started before this Activity existed
     * — after a rotation, or after the user came back from elsewhere.
     */
    private fun observeSession() {
        viewModelScope.launch {
            DepotSession.state.collect { session ->
                _state.update {
                    it.copy(
                        listeningAs = session.listeningAs,
                        listeningSince = session.listeningSince,
                        connected = session.connected,
                        connectionType = session.connectionType,
                        progressIndex = session.progressIndex,
                        progressTotal = session.progressTotal,
                        bytesSent = session.bytesSent,
                        bytesTotal = session.bytesTotal,
                        movedToday = session.movedToday,
                        offeredFileName = session.offeredFileName,
                        offeredFileSize = session.offeredFileSize,
                        log = linkLog + session.log,
                        error = it.error ?: session.error,
                    )
                }
            }
        }
    }

    /** Devices outlive the process, so the list comes from storage. */
    private fun refreshDevices() {
        viewModelScope.launch(Dispatchers.IO) {
            val devices = DeviceStore.list(getApplication())
            _state.update { it.copy(devices = devices) }
        }
    }

    /**
     * The grants, then their figures. Two passes deliberately: the list is
     * a preference read and returns at once, while counting a photo
     * library's contents is a content-provider query that can take a
     * noticeable moment, and the screen should not be blank until it
     * finishes.
     */
    private fun refreshGrants() {
        viewModelScope.launch(Dispatchers.IO) {
            val grants = GrantStore.list(getApplication())
            _state.update { it.copy(grants = grants.map { g -> GrantView(g) }) }

            val measured = grants.map { g ->
                val stats = runCatching { grantStats(getApplication(), Uri.parse(g.treeUri)) }.getOrNull()
                GrantView(g, stats?.files, stats?.bytes)
            }
            _state.update { it.copy(grants = measured) }
        }
    }

    /**
     * Takes a persistable read permission on the folder the user picked.
     * Without it the grant would survive in preferences but stop working
     * at the next reboot, which is the worst of both: a list that says a
     * folder is shared and a Client that cannot see it.
     */
    fun onFolderGranted(uri: Uri) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                getApplication<Application>().contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
                GrantStore.add(
                    getApplication(),
                    Grant(
                        treeUri = uri.toString(),
                        label = folderLabel(uri),
                        enabled = true,
                        addedAt = System.currentTimeMillis(),
                    ),
                )
                refreshGrants()
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: e.toString()) }
            }
        }
    }

    /** The trailing path segment of a tree URI is the folder's own name. */
    private fun folderLabel(uri: Uri): String {
        val id = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull()
            ?: return uri.lastPathSegment ?: "Folder"
        return id.substringAfterLast(':').substringAfterLast('/').ifBlank { id }
    }

    fun onToggleGrant(view: GrantView, enabled: Boolean) {
        viewModelScope.launch(Dispatchers.IO) {
            GrantStore.setEnabled(getApplication(), view.grant.treeUri, enabled)
            refreshGrants()
        }
    }

    fun onForgetGrant(view: GrantView) {
        viewModelScope.launch(Dispatchers.IO) {
            GrantStore.remove(getApplication(), view.grant.treeUri)
            // Hand the permission back too. Leaving it held would keep the
            // app able to read a folder the user has just said it should
            // not, which is exactly the thing the ACCESS screen promises.
            runCatching {
                getApplication<Application>().contentResolver.releasePersistableUriPermission(
                    Uri.parse(view.grant.treeUri),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
            }
            refreshGrants()
        }
    }

    fun onPayloadChange(value: String) = _state.update { it.copy(payload = value) }

    /**
     * A scan goes straight into linking. Dropping the payload into a text
     * field and waiting for a second tap would just be an extra step on
     * the path §3.1 actually intends people to use.
     */
    fun onQrScanned(payload: String) {
        _state.update { it.copy(payload = payload) }
        link()
    }

    fun onSignalUrlChange(value: String) {
        _state.update { it.copy(signalUrl = value) }
        Settings.setSignalUrl(getApplication(), value)
    }

    fun onTurnChange(turn: TurnSettings) {
        _state.update { it.copy(turn = turn) }
        Settings.setTurn(getApplication(), turn)
    }

    fun onFileSelected(uri: Uri) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val resolver = getApplication<Application>().contentResolver
                val name = resolver.query(uri, null, null, null, null)?.use { cursor ->
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
                } ?: "file"
                // Unlike a granted folder, which is streamed, a single
                // offered file is held in memory so it survives the picker's
                // permission grant expiring. That puts a ceiling on it: a
                // whole video would take the process down, and a Depot that
                // dies is worse than one that says no.
                val ceiling = Runtime.getRuntime().maxMemory() / 4
                val size = resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                    val index = c.getColumnIndex(OpenableColumns.SIZE)
                    if (index >= 0 && c.moveToFirst() && !c.isNull(index)) c.getLong(index) else -1L
                } ?: -1L
                if (size > ceiling) {
                    throw IllegalStateException(
                        "$name is ${size / (1024 * 1024)} MB — too large to offer on its own. " +
                            "Share the folder it is in instead; folders are streamed.",
                    )
                }

                val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: throw IllegalStateException("could not open the selected file")
                DepotSession.setOfferedFile(OfferedFile(name, bytes))
            } catch (e: Exception) {
                DepotSession.reportError(e.message ?: e.toString())
            }
        }
    }

    /**
     * protocol.md §4. Runs inside a foreground service rather than here:
     * a Depot that stops being reachable when the user switches apps is
     * not a file server.
     */
    fun toggleListening() {
        val app = getApplication<Application>()
        if (DepotSession.isListening) {
            DepotService.stop(app)
            return
        }
        val url = _state.value.signalUrl.ifBlank { null } ?: run {
            _state.update { it.copy(error = "set the Signal server address first") }
            return
        }
        DepotService.start(app, url)
    }

    fun onApprove() {
        approve?.invoke()
        clearSasHandlers()
    }

    /**
     * The user says the digits do not match. Nothing is written and no
     * credential is issued; the Client stays exactly as unknown as it was.
     */
    fun onReject() {
        reject?.invoke()
        clearSasHandlers()
    }

    private fun clearSasHandlers() {
        approve = null
        reject = null
        _state.update { it.copy(sas = null) }
    }

    /** Walk away from a link attempt that has not settled. */
    fun cancelLink() {
        linkGeneration++
        reject?.invoke()
        approve = null
        reject = null
        linkLog = emptyList()
        _state.update {
            it.copy(linking = false, sas = null, payload = "", linkStatus = null, error = null)
        }
    }

    fun onRename(device: DeviceRecord, label: String) {
        viewModelScope.launch(Dispatchers.IO) {
            DeviceStore.rename(getApplication(), device.clientIdentityPub, label)
            refreshDevices()
        }
    }

    fun onRevoke(device: DeviceRecord) {
        viewModelScope.launch(Dispatchers.IO) {
            DeviceStore.revoke(getApplication(), device.clientIdentityPub)
            // The store is what enforces §6 at the next handshake; telling
            // Signal is what stops routing to a device that is connected
            // right now. Both, or a revoked laptop keeps its channel.
            DepotSession.revoke(device.clientIdentityPub)
            refreshDevices()
        }
    }

    /**
     * Removes the record altogether. Offered only once a device is already
     * revoked, so losing it from the list is a second, deliberate step
     * rather than a mis-tap on a device that still works.
     */
    fun onForgetDevice(device: DeviceRecord) {
        viewModelScope.launch(Dispatchers.IO) {
            DeviceStore.forget(getApplication(), device.clientIdentityPub)
            refreshDevices()
        }
    }

    fun dismissResult() {
        DepotSession.dismissError()
        _state.update { it.copy(justPaired = null, error = null, linkStatus = null) }
    }

    fun link() {
        if (_state.value.linking) return
        val generation = ++linkGeneration
        linkLog = emptyList()
        _state.update {
            it.copy(linking = true, error = null, sas = null, justPaired = null, linkStatus = null)
        }

        // The QR names the Signal server, so listening later does not need
        // it typed in by hand.
        runCatching { QrPayload.parse(_state.value.payload) }
            .onSuccess { qr -> onSignalUrlChange(qr.signalUrl) }

        viewModelScope.launch(Dispatchers.IO) {
            runDepotPairing(
                context = getApplication(),
                qrPayloadRaw = _state.value.payload,
                cb = object : DepotPairingCallbacks {
                    private fun current() = generation == linkGeneration

                    override fun onStatus(status: String) {
                        linkLog = linkLog + status
                        _state.update {
                            it.copy(
                                linkStatus = if (current()) status else it.linkStatus,
                                log = linkLog + DepotSession.state.value.log,
                            )
                        }
                    }

                    override fun onSas(sas: String, approve: () -> Unit, reject: () -> Unit) {
                        if (!current()) {
                            reject()
                            return
                        }
                        this@DepotViewModel.approve = approve
                        this@DepotViewModel.reject = reject
                        _state.update { it.copy(sas = sas) }
                    }

                    override fun onPaired(device: DeviceRecord) {
                        refreshDevices()
                        if (!current()) return
                        // The payload is single-use; leaving it on screen
                        // only invites a retry that fails as expired.
                        _state.update {
                            it.copy(linking = false, sas = null, justPaired = device, payload = "")
                        }
                    }

                    override fun onError(message: String) {
                        if (!current()) return
                        _state.update { it.copy(linking = false, sas = null, error = message) }
                    }
                },
            )
        }
    }
}
