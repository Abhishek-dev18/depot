package com.depot.app.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.depot.app.pairing.DepotPairingCallbacks
import com.depot.app.pairing.runDepotPairing
import com.depot.app.storage.DeviceRecord
import com.depot.app.storage.DeviceStore
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
)

class PairingViewModel(app: Application) : AndroidViewModel(app) {

    private val _state = MutableStateFlow(PairingUiState())
    val state: StateFlow<PairingUiState> = _state.asStateFlow()

    /** Set when the SAS is on screen; invoking it releases the pairing flow. */
    private var approve: (() -> Unit)? = null

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

    fun dismissResult() = _state.update { it.copy(justPaired = null, error = null) }

    fun join() {
        if (_state.value.busy) return
        _state.update {
            it.copy(busy = true, error = null, sas = null, justPaired = null, log = emptyList())
        }

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
