package com.depot.app.service

import android.content.Context
import com.depot.app.pairing.DepotReconnectCallbacks
import com.depot.app.pairing.DepotReconnectListener
import com.depot.app.pairing.runDepotReconnectListener
import com.depot.app.transport.ConnectionType
import com.depot.app.transport.OfferedFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SessionState(
    val listeningAs: String? = null,
    val connectionType: ConnectionType? = null,
    val progressIndex: Int = 0,
    val progressTotal: Int = 0,
    val bytesSent: Long = 0,
    val bytesTotal: Long = 0,
    val offeredFileName: String? = null,
    val offeredFileSize: Int = 0,
    val log: List<String> = emptyList(),
    val error: String? = null,
)

/**
 * The listening session, owned at process scope rather than by the
 * Activity or its ViewModel.
 *
 * A Depot that stops being reachable the moment its screen rotates or the
 * user switches apps is not a file server. Both of those destroy the
 * Activity, so the WebSocket registration and any in-flight transfer have
 * to live somewhere that outlives them. DepotService then keeps the
 * process itself from being reclaimed.
 */
object DepotSession {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state.asStateFlow()

    private var listener: DepotReconnectListener? = null
    private var offered: OfferedFile? = null

    val isListening: Boolean get() = listener != null

    fun setOfferedFile(file: OfferedFile) {
        offered = file
        _state.update {
            it.copy(
                offeredFileName = file.name,
                offeredFileSize = file.bytes.size,
                log = it.log + "offering ${file.name} (${file.bytes.size} bytes)",
            )
        }
    }

    fun reportError(message: String) = _state.update { it.copy(error = message) }

    fun dismissError() = _state.update { it.copy(error = null) }

    fun start(context: Context, signalUrl: String) {
        if (listener != null) return
        val app = context.applicationContext
        scope.launch {
            try {
                listener = runDepotReconnectListener(
                    context = app,
                    scope = scope,
                    signalUrl = signalUrl,
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

    fun stop() {
        listener?.stop()
        listener = null
        _state.update {
            it.copy(
                listeningAs = null,
                connectionType = null,
                progressIndex = 0,
                progressTotal = 0,
                log = it.log + "stopped listening",
            )
        }
    }
}
