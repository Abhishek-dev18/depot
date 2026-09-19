package com.depot.app.service

import android.content.Context
import com.depot.app.pairing.DepotReconnectCallbacks
import com.depot.app.pairing.DepotReconnectListener
import com.depot.app.pairing.runDepotReconnectListener
import com.depot.app.storage.Settings
import com.depot.app.transport.AndroidDepotSource
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
    /** When registration succeeded, for the hero's UPTIME cell. */
    val listeningSince: Long? = null,
    val connectionType: ConnectionType? = null,
    /**
     * Identity key -> how that Client is currently reaching us. The
     * artifact is explicit that connection state is never hidden, and a
     * per-device map is what lets each row say DIRECT, RELAYED or idle
     * rather than the screen showing one global guess.
     */
    val connected: Map<String, ConnectionType> = emptyMap(),
    val progressIndex: Int = 0,
    val progressTotal: Int = 0,
    val bytesSent: Long = 0,
    val bytesTotal: Long = 0,
    /** Bytes this Depot has put on the wire today, across sessions. */
    val movedToday: Long = 0,
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

    /** Last progress figure seen per Client, for the running total below. */
    private val lastProgress = HashMap<String, Long>()
    private var movedToday = 0L
    private var movedDay = ""
    private var appContext: Context? = null

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

    /**
     * Progress is reported as a running count within one transfer, so the
     * day's total is the sum of the increments. A figure lower than the
     * last one means a new transfer started; the earlier one's bytes are
     * already counted, and the new count starts again from its own zero.
     */
    @Synchronized
    private fun accumulate(clientId: String, bytesSent: Long): Long {
        val today = Settings.today()
        if (today != movedDay) {
            movedDay = today
            movedToday = appContext?.let { Settings.movedOn(it, today) } ?: 0L
            lastProgress.clear()
        }
        val previous = lastProgress[clientId] ?: 0L
        movedToday += if (bytesSent >= previous) bytesSent - previous else bytesSent
        lastProgress[clientId] = bytesSent
        return movedToday
    }

    /**
     * Written when a transfer finishes and when the terminal stops, rather
     * than on every progress callback — a 600 MB file reports progress
     * thousands of times, and none of those writes would survive a crash
     * any better than the last one does.
     */
    @Synchronized
    private fun persistMoved() {
        val context = appContext ?: return
        if (movedDay.isNotEmpty()) Settings.setMovedOn(context, movedDay, movedToday)
    }

    fun start(context: Context, signalUrl: String) {
        if (listener != null) return
        val app = context.applicationContext
        synchronized(this) {
            appContext = app
            movedDay = Settings.today()
            movedToday = Settings.movedOn(app, movedDay)
        }
        _state.update { it.copy(movedToday = movedToday) }
        scope.launch {
            try {
                listener = runDepotReconnectListener(
                    context = app,
                    scope = scope,
                    signalUrl = signalUrl,
                    turn = null,
                    source = AndroidDepotSource(app) { offered },
                    cb = object : DepotReconnectCallbacks {
                        override fun onStatus(status: String) {
                            _state.update { it.copy(log = it.log + status) }
                        }

                        override fun onRegistered(depotId: String) {
                            _state.update {
                                it.copy(listeningAs = depotId, listeningSince = System.currentTimeMillis())
                            }
                        }

                        override fun onClientAuthenticated(clientId: String) {
                            _state.update { it.copy(log = it.log + "client authenticated: $clientId") }
                        }

                        override fun onClientConnected(clientId: String, connectionType: ConnectionType) {
                            _state.update {
                                it.copy(
                                    connectionType = connectionType,
                                    connected = it.connected + (clientId to connectionType),
                                    log = it.log + "data channel open ($connectionType)",
                                )
                            }
                        }

                        override fun onClientDisconnected(clientId: String) {
                            _state.update {
                                val remaining = it.connected - clientId
                                it.copy(
                                    connected = remaining,
                                    // The global badge follows whatever is
                                    // still connected, if anything is.
                                    connectionType = remaining.values.firstOrNull(),
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
                            val moved = accumulate(clientId, bytesSent)
                            if (index + 1 >= total) persistMoved()
                            _state.update {
                                it.copy(
                                    progressIndex = index + 1,
                                    progressTotal = total,
                                    bytesSent = bytesSent,
                                    bytesTotal = bytesTotal,
                                    movedToday = moved,
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
        // MOVED TODAY outlives the run, so it is flushed rather than
        // cleared; only the per-transfer bookkeeping resets.
        persistMoved()
        synchronized(this) { lastProgress.clear() }
        _state.update {
            it.copy(
                listeningAs = null,
                listeningSince = null,
                connectionType = null,
                connected = emptyMap(),
                progressIndex = 0,
                progressTotal = 0,
                log = it.log + "stopped listening",
            )
        }
    }
}
