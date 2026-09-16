package com.depot.app.ui

import android.app.Application
import android.net.Uri
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
import com.depot.app.transport.ConnectionType
import com.depot.app.transport.OfferedFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class PairingUiState(
    val payload: String = "",
    val busy: Boolean = false,
    val sas: String? = null,
    val error: String? = null,
    val justPaired: DeviceRecord? = null,
    val log: List<String> = emptyList(),
    val devices: List<DeviceRecord> = emptyList(),
    val signalUrl: String = "",
    val listeningAs: String? = null,
    val offeredFileName: String? = null,
    val offeredFileSize: Int = 0,
    val connectionType: ConnectionType? = null,
    val progressIndex: Int = 0,
    val progressTotal: Int = 0,
    val bytesSent: Long = 0,
    val bytesTotal: Long = 0,
)

class PairingViewModel(app: Application) : AndroidViewModel(app) {

    private val _state = MutableStateFlow(PairingUiState())
    val state: StateFlow<PairingUiState> = _state.asStateFlow()

    /** Set while the SAS is on screen; invoking it releases the pairing flow. */
    private var approve: (() -> Unit)? = null

    /** Pairing writes its own log; the listening session owns the rest. */
    private var pairingLog: List<String> = emptyList()

    init {
        refreshDevices()
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
                        connectionType = session.connectionType,
                        progressIndex = session.progressIndex,
                        progressTotal = session.progressTotal,
                        bytesSent = session.bytesSent,
                        bytesTotal = session.bytesTotal,
                        offeredFileName = session.offeredFileName,
                        offeredFileSize = session.offeredFileSize,
                        log = pairingLog + session.log,
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

    fun onPayloadChange(value: String) = _state.update { it.copy(payload = value) }

    fun onSignalUrlChange(value: String) = _state.update { it.copy(signalUrl = value) }

    fun onFileSelected(uri: Uri) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val resolver = getApplication<Application>().contentResolver
                val name = resolver.query(uri, null, null, null, null)?.use { cursor ->
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
                } ?: "file"
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
            _state.update { it.copy(error = "set the signal URL first") }
            return
        }
        DepotService.start(app, url)
    }

    fun onApprove() {
        approve?.invoke()
        approve = null
        _state.update { it.copy(sas = null) }
    }

    fun onRevoke(device: DeviceRecord) {
        viewModelScope.launch(Dispatchers.IO) {
            DeviceStore.revoke(getApplication(), device.clientIdentityPub)
            refreshDevices()
        }
    }

    fun dismissResult() {
        DepotSession.dismissError()
        _state.update { it.copy(justPaired = null, error = null) }
    }

    fun join() {
        if (_state.value.busy) return
        pairingLog = emptyList()
        _state.update {
            it.copy(busy = true, error = null, sas = null, justPaired = null, log = emptyList())
        }

        // The QR already names the Signal server, so listening later does
        // not need it typed in by hand.
        runCatching { QrPayload.parse(_state.value.payload) }
            .onSuccess { qr -> _state.update { it.copy(signalUrl = qr.signalUrl) } }

        viewModelScope.launch(Dispatchers.IO) {
            runDepotPairing(
                context = getApplication(),
                qrPayloadRaw = _state.value.payload,
                cb = object : DepotPairingCallbacks {
                    override fun onStatus(status: String) {
                        pairingLog = pairingLog + status
                        _state.update { it.copy(log = pairingLog + DepotSession.state.value.log) }
                    }

                    override fun onSas(sas: String, approve: () -> Unit) {
                        this@PairingViewModel.approve = approve
                        _state.update { it.copy(sas = sas) }
                    }

                    override fun onPaired(device: DeviceRecord) {
                        // The payload is single-use; leaving it on screen
                        // only invites a retry that fails as expired.
                        _state.update {
                            it.copy(busy = false, sas = null, justPaired = device, payload = "")
                        }
                        refreshDevices()
                    }

                    override fun onError(message: String) {
                        _state.update { it.copy(busy = false, sas = null, error = message) }
                    }
                },
            )
        }
    }
}
