package com.depot.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.depot.app.pairing.DepotPairingCallbacks
import com.depot.app.pairing.QrPayload
import com.depot.app.pairing.DepotReconnectCallbacks
import com.depot.app.pairing.DepotReconnectListener
import com.depot.app.pairing.runDepotPairing
import com.depot.app.pairing.runDepotReconnectListener
import android.net.Uri
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

    /** Set when the SAS is on screen; invoking it releases the pairing flow. */
    private var approve: (() -> Unit)? = null

    private var listener: DepotReconnectListener? = null

    /**
     * Held in memory, which is fine for the sizes this is being tested
     * with but will not do for a real Depot serving photos and video —
     * §5.7 streams by chunk, so this should become a ranged read from the
     * content URI rather than a whole-file load.
     */
    private var offered: OfferedFile? = null

    fun onFileSelected(uri: Uri) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val resolver = getApplication<Application>().contentResolver
                val name = resolver.query(uri, null, null, null, null)?.use { cursor ->
                    val index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                    if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
                } ?: "file"
                val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: throw IllegalStateException("could not open the selected file")
                offered = OfferedFile(name, bytes)
                _state.update {
                    it.copy(
                        offeredFileName = name,
                        offeredFileSize = bytes.size,
                        log = it.log + "offering ${'$'}name (${'$'}{bytes.size} bytes)",
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: e.toString()) }
            }
        }
    }

    init {
        refreshDevices()
    }

    /**
     * Devices outlive the process, so the list has to come from storage
     * rather than from whatever happened to be paired this session.
     */
    private fun refreshDevices() {
        viewModelScope.launch(Dispatchers.IO) {
            val devices = DeviceStore.list(getApplication())
            _state.update { it.copy(devices = devices) }
        }
    }

    fun onPayloadChange(value: String) = _state.update { it.copy(payload = value) }

    fun onSignalUrlChange(value: String) = _state.update { it.copy(signalUrl = value) }

    /**
     * protocol.md §4. Registering presence is what lets a paired Client
     * reach this Depot again without the QR flow, so it stays running
     * until explicitly stopped.
     */
    fun toggleListening() {
        listener?.let {
            it.stop()
            listener = null
            _state.update { s -> s.copy(listeningAs = null, log = s.log + "stopped listening") }
            return
        }

        val url = _state.value.signalUrl.ifBlank { null } ?: run {
            _state.update { it.copy(error = "set the signal URL first") }
            return
        }

        viewModelScope.launch(Dispatchers.IO) {
            try {
                listener = runDepotReconnectListener(
                    context = getApplication(),
                    scope = viewModelScope,
                    signalUrl = url,
                    turn = null,
                    getFile = { offered },
                    cb = object : DepotReconnectCallbacks {
                        override fun onStatus(status: String) {
                            _state.update { it.copy(log = it.log + status) }
                        }

                        override fun onRegistered(depotId: String) {
                            _state.update { it.copy(listeningAs = depotId) }
                        }

                        override fun onClientAuthenticated(clientId: String) {
                            _state.update { it.copy(log = it.log + "client authenticated: $clientId") }
                            refreshDevices()
                        }

                        override fun onClientConnected(clientId: String, connectionType: ConnectionType) {
                            _state.update {
                                it.copy(
                                    connectionType = connectionType,
                                    log = it.log + "data channel open ($connectionType)",
                                )
                            }
                        }

                        override fun onProgress(
                            clientId: String,
                            index: Int,
                            total: Int,
                            bytesSent: Long,
                            bytesTotal: Long,
                        ) {
                            _state.update {
                                it.copy(
                                    progressIndex = index + 1,
                                    progressTotal = total,
                                    bytesSent = bytesSent,
                                    bytesTotal = bytesTotal,
                                )
                            }
                        }

                        override fun onClientRejected(clientId: String, reason: String) {
                            _state.update { it.copy(log = it.log + "rejected $clientId: $reason") }
                        }
                    },
                )
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: e.toString()) }
            }
        }
    }

    override fun onCleared() {
        listener?.stop()
        listener = null
        super.onCleared()
    }

    fun onApprove() {
        approve?.invoke()
        approve = null
        _state.update { it.copy(sas = null) }
    }

    fun onRevoke(device: DeviceRecord) {
        viewModelScope.launch(Dispatchers.IO) {
            DeviceStore.revoke(getApplication(), device.clientIdentityPub)
            // Best-effort routing hint; the refusal above is the real thing.
            listener?.revoke(device.clientIdentityPub)
            refreshDevices()
        }
    }

    fun dismissResult() = _state.update { it.copy(justPaired = null, error = null) }

    fun join() {
        if (_state.value.busy) return
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
                        _state.update { it.copy(log = it.log + status) }
                    }

                    override fun onSas(sas: String, approve: () -> Unit) {
                        this@PairingViewModel.approve = approve
                        _state.update { it.copy(sas = sas) }
                    }

                    override fun onPaired(device: DeviceRecord) {
                        // Clear the pasted payload: it is single-use, and
                        // leaving it filling the screen invites a retry
                        // that can only fail with session_not_found.
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
