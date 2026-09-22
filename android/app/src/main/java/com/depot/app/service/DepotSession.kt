package com.depot.app.service

import android.content.Context
import com.depot.app.pairing.DepotReconnectCallbacks
import com.depot.app.pairing.DepotReconnectListener
import com.depot.app.pairing.runDepotReconnectListener
import com.depot.app.storage.Settings
import com.depot.app.transport.AndroidDepotSource
import com.depot.app.transport.AppInbox
import com.depot.app.transport.ConnectionType
import com.depot.app.transport.TurnConfig
import com.depot.app.transport.OfferedFile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** One file on offer, as the screens need to show it. */
data class OfferedSummary(val name: String, val size: Int)

/**
 * One file a Client sent up (§5.10), as the home screen shows it.
 *
 * [where] is a content URI string or null; null only means this phone
 * has nothing to open it with, never that the file is missing.
 */
data class ReceivedFile(
    val name: String,
    val size: Long,
    val folder: String,
    val where: String?,
    val at: Long,
    /** What it was called in Downloads, once KEEP has been used. */
    val savedAs: String? = null,
)

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
    /** The files picked directly, in the order they were added. */
    val offeredFiles: List<OfferedSummary> = emptyList(),
    /** What Clients have sent up this session, newest first. */
    val receivedFiles: List<ReceivedFile> = emptyList(),
    /** The name of one arriving right now, between PUT_OK and PUT_DONE. */
    val receiving: String? = null,
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
    private var supervisor: Job? = null

    /** What the user asked for, as distinct from what is currently true. */
    @Volatile
    private var wantListening = false
    /**
     * CopyOnWrite because the listing is read on a WebRTC thread while
     * the picker adds to it on the main one.
     */
    private val offered = java.util.concurrent.CopyOnWriteArrayList<OfferedFile>()

    /** Last progress figure seen per Client, for the running total below. */
    private val lastProgress = HashMap<String, Long>()
    private var movedToday = 0L
    private var movedDay = ""
    private var appContext: Context? = null

    val isListening: Boolean get() = wantListening

    /**
     * Adds to what is on offer rather than replacing it.
     *
     * Picking a second file used to un-share the first, which is not
     * what anyone means by picking a second file — and a Client that had
     * fetched the first then found it gone from the listing.
     *
     * Already-offered files are skipped rather than duplicated: the same
     * name and length is the same file as far as anything here can tell,
     * and two identical rows are a worse answer than one.
     */
    fun addOfferedFiles(files: List<OfferedFile>) {
        if (files.isEmpty()) return
        val added = files.filterNot { candidate ->
            offered.any { it.name == candidate.name && it.bytes.size == candidate.bytes.size }
        }
        if (added.isEmpty()) return
        offered.addAll(added)
        _state.update {
            it.copy(
                offeredFiles = offered.map { f -> OfferedSummary(f.name, f.bytes.size) },
                log = it.log + added.map { f -> "offering ${f.name} (${f.bytes.size} bytes)" },
            )
        }
        notifySharedChanged()
    }

    /**
     * Drops one received file, from the screen and from storage.
     *
     * Both, because a row that goes away while the bytes stay is a lie
     * about what this phone is holding — and the inbox is the one place
     * a Client can write to, so what is in it is worth being exact about.
     */
    fun removeReceived(context: Context, file: ReceivedFile) {
        val where = file.where
        if (where != null && where.startsWith("/")) {
            runCatching { java.io.File(where).delete() }
        }
        _state.update {
            it.copy(
                receivedFiles = it.receivedFiles.filterNot { held -> held.name == file.name },
                log = it.log + "cleared ${file.name}",
            )
        }
    }

    /** Records that a received file was copied out to Downloads. */
    fun noteSaved(name: String, savedAs: String?) {
        _state.update {
            it.copy(
                log = it.log + if (savedAs == null) {
                    "could not save $name"
                } else if (savedAs == name) {
                    "saved $name to Downloads"
                } else {
                    "saved $name to Downloads as $savedAs — that name was taken"
                },
                receivedFiles = it.receivedFiles.map { held ->
                    if (held.name == name) held.copy(savedAs = savedAs) else held
                },
            )
        }
    }

    /** Drops everything received. The "clear all" above the list. */
    fun clearReceived(context: Context) {
        val gone = AppInbox(context).clear()
        _state.update {
            it.copy(
                receivedFiles = emptyList(),
                log = it.log + "cleared $gone received file(s)",
            )
        }
    }

    /** How much memory the files on offer are already holding. */
    fun offeredBytes(): Long = offered.sumOf { it.bytes.size.toLong() }

    /**
     * Puts what is already in the app's inbox back on screen.
     *
     * The files outlive the process — they are on disk — so a RECEIVED
     * list rebuilt only from this run's arrivals would tell the user
     * their files had gone when they had not. Called when the screen
     * appears, and additive, so an arrival that beat it is not lost.
     */
    fun loadInbox(context: Context) {
        val known = AppInbox(context).files().map { file ->
            ReceivedFile(
                name = file.name,
                size = file.length(),
                folder = AppInbox.INBOX_LABEL,
                where = file.absolutePath,
                at = file.lastModified(),
            )
        }
        if (known.isEmpty()) return
        _state.update { state ->
            val already = state.receivedFiles.map { it.name }.toSet()
            state.copy(
                receivedFiles = (state.receivedFiles + known.filterNot { it.name in already })
                    .sortedByDescending { it.at },
            )
        }
    }

    /** Stops offering one of them, without touching the rest. */
    fun removeOfferedFile(name: String, size: Int) {
        val doomed = offered.filter { it.name == name && it.bytes.size == size }
        if (doomed.isEmpty()) return
        offered.removeAll(doomed)
        _state.update {
            it.copy(
                offeredFiles = offered.map { f -> OfferedSummary(f.name, f.bytes.size) },
                log = it.log + "stopped offering $name",
            )
        }
        notifySharedChanged()
    }

    /**
     * protocol.md §5.9 — anyone connected is now looking at a listing
     * that is out of date. Called when a file is offered or a grant
     * changes; a Client that misses it is stale rather than broken.
     */
    fun notifySharedChanged() {
        listener?.notifySharedChanged()
    }

    /**
     * protocol.md §6 steps 4-5. What actually revokes a device is this
     * Depot refusing its §4 handshake, which DeviceStore already records —
     * but telling Signal drops the route now instead of at the next
     * attempt, which matters when the device is connected as you revoke it.
     */
    fun revoke(clientId: String) {
        listener?.revoke(clientId)
        _state.update {
            it.copy(
                connected = it.connected - clientId,
                log = it.log + "revoked $clientId",
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
        if (supervisor != null) return
        val app = context.applicationContext
        synchronized(this) {
            appContext = app
            movedDay = Settings.today()
            movedToday = Settings.movedOn(app, movedDay)
        }
        _state.update { it.copy(movedToday = movedToday) }

        wantListening = true
        supervisor = scope.launch { supervise(app, signalUrl) }
    }

    /**
     * Keeps this Depot registered for as long as the user wants it to be.
     *
     * A WebSocket does not survive a phone going to sleep, changing
     * network, or simply being idle behind a NAT that gives up on it. When
     * one dies the Depot stops being registered with Signal, so every
     * Client asking for it is told it is offline — while the phone happily
     * goes on claiming to listen. Nothing noticed, and the only cure was
     * toggling the terminal off and on by hand.
     *
     * So the connection is supervised rather than made once: when it
     * drops, register again, backing off so a Signal server that is down
     * is not hammered.
     */
    private suspend fun supervise(app: Context, signalUrl: String) {
        var backoffMs = 1_000L
        while (currentCoroutineContext().isActive && wantListening) {
            val dropped = CompletableDeferred<String>()
            try {
                listener = runDepotReconnectListener(
                    context = app,
                    scope = scope,
                    signalUrl = signalUrl,
                    turn = Settings.turn(app).let { t ->
                        // A blank URL is "no relay at all" rather than a
                        // TURN server with an empty address.
                        if (t.url.isBlank()) null else TurnConfig(t.url, t.username, t.credential)
                    },
                    source = AndroidDepotSource(app) { offered.toList() },
                    cb = callbacks { reason -> dropped.complete(reason) },
                )
                // Registered, so whatever was wrong before has cleared.
                backoffMs = 1_000L
                val reason = dropped.await()
                _state.update {
                    it.copy(
                        listeningAs = null,
                        listeningSince = null,
                        connected = emptyMap(),
                        connectionType = null,
                        log = it.log + "signal connection lost ($reason), reconnecting",
                    )
                }
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        listeningAs = null,
                        listeningSince = null,
                        log = it.log + "could not reach signal: ${e.message}",
                    )
                }
            } finally {
                runCatching { listener?.stop() }
                listener = null
            }

            if (!wantListening) break
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(30_000)
        }
    }

    private fun callbacks(onDropped: (String) -> Unit) = object : DepotReconnectCallbacks {
        override fun onStatus(status: String) {
            _state.update { it.copy(log = it.log + status) }
        }

        override fun onRegistered(depotId: String) {
            _state.update {
                it.copy(listeningAs = depotId, listeningSince = System.currentTimeMillis())
            }
        }

        override fun onDisconnected(reason: String) = onDropped(reason)

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
                    // The global badge follows whatever is still
                    // connected, if anything is.
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

        override fun onIncomingStarted(clientId: String, name: String) {
            _state.update { it.copy(receiving = name, log = it.log + "receiving $name") }
        }

        override fun onIncomingStored(
            clientId: String,
            name: String,
            size: Long,
            folder: String,
            where: String?,
        ) {
            val file = ReceivedFile(name, size, folder, where, System.currentTimeMillis())
            _state.update {
                it.copy(
                    receiving = if (it.receiving == name) null else it.receiving,
                    // Newest first: the one that just arrived is the one
                    // being looked for.
                    receivedFiles = listOf(file) + it.receivedFiles,
                    log = it.log + "received $name into $folder",
                )
            }
        }
    }

    fun stop() {
        wantListening = false
        supervisor?.cancel()
        supervisor = null
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
