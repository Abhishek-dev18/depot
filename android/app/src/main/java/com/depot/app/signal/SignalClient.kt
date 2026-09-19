package com.depot.app.signal

import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class SignalException(message: String) : Exception(message)

/**
 * Thin wrapper over the WebSocket connection to Signal (protocol.md §7).
 *
 * Signal is untrusted: nothing here authenticates it, and nothing it says
 * is believed on its own. It only ever routes opaque envelopes between two
 * peers who authenticate each other directly.
 */
class SignalClient(private val url: String) {

    private val listeners = CopyOnWriteArraySet<(Envelope) -> Unit>()
    private val disconnectListeners = CopyOnWriteArraySet<(String) -> Unit>()
    private val opened = CompletableDeferred<Unit>()
    private var webSocket: WebSocket? = null

    /** Fires once, whichever way the socket ends. */
    private val announced = java.util.concurrent.atomic.AtomicBoolean(false)

    private val http = OkHttpClient.Builder()
        // The server pings every 25s and drops a peer silent for 60s, so
        // keep the socket demonstrably alive from this end too.
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    fun connect() {
        val request = Request.Builder().url(url).build()
        webSocket = http.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    opened.complete(Unit)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val envelope = try {
                        Envelope.fromJson(text)
                    } catch (_: Exception) {
                        return // malformed frames are dropped, as on the web side
                    }
                    for (listener in listeners) listener(envelope)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    opened.completeExceptionally(SignalException("could not connect to signal at $url: ${t.message}"))
                    announce(t.message ?: "connection failed")
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    opened.completeExceptionally(SignalException("signal connection closed: $reason"))
                    announce(reason.ifBlank { "closed ($code)" })
                }
            },
        )
    }

    /**
     * Called when this socket ends for any reason.
     *
     * A Depot whose socket drops is no longer registered with Signal, and
     * every Client asking for it is told it is offline — while the phone
     * goes on saying it is listening. Something has to notice, or the only
     * cure is the user toggling it off and on again.
     */
    fun onDisconnected(fn: (String) -> Unit) {
        disconnectListeners.add(fn)
    }

    private fun announce(reason: String) {
        if (announced.compareAndSet(false, true)) {
            for (listener in disconnectListeners) runCatching { listener(reason) }
        }
    }

    /** Suspends until the socket is open, or throws if it failed to connect. */
    suspend fun ready() {
        opened.await()
    }

    fun send(e: Envelope) {
        val ws = webSocket ?: throw SignalException("not connected")
        ws.send(e.toJson())
    }

    fun onMessage(fn: (Envelope) -> Unit): () -> Unit {
        listeners.add(fn)
        return { listeners.remove(fn) }
    }

    /** Returns the first message matching [predicate], or throws on timeout. */
    suspend fun waitFor(timeoutMs: Long = 15_000, predicate: (Envelope) -> Boolean): Envelope = try {
        withTimeout(timeoutMs) {
            suspendCancellableCoroutine { cont ->
                lateinit var unsubscribe: () -> Unit
                unsubscribe = onMessage { e ->
                    if (predicate(e) && cont.isActive) {
                        unsubscribe()
                        cont.resume(e)
                    }
                }
                cont.invokeOnCancellation { unsubscribe() }
            }
        }
    } catch (_: TimeoutCancellationException) {
        throw SignalException("timed out waiting for signal message")
    }

    fun close() {
        // Deliberate closes are not disconnections to recover from, so the
        // announcement is suppressed before tearing the socket down.
        announced.set(true)
        webSocket?.close(1000, null)
        webSocket = null
    }

    // --- Convenience senders, one per type Signal owns ---

    fun hello(sessionId: String) = send(Envelope(type = TYPE_HELLO, sessionId = sessionId))

    fun join(sessionId: String) = send(Envelope(type = TYPE_JOIN, sessionId = sessionId))

    fun register(depotId: String) = send(Envelope(type = TYPE_REGISTER, depotId = depotId))

    fun connectTo(depotId: String, clientId: String, payload: JSONObject) =
        send(Envelope(type = TYPE_CONNECT, depotId = depotId, clientId = clientId, payload = payload))

    fun revoke(clientId: String) = send(Envelope(type = TYPE_REVOKE, clientId = clientId))

    /**
     * Opaque relay — everything Signal does not own: PAIR_RESPONSE,
     * PAIR_CONFIRM, CHALLENGE, RESPONSE, SESSION_OK, and the WebRTC
     * SDP/ICE exchange.
     */
    fun relay(type: String, payload: JSONObject, clientId: String? = null) =
        send(Envelope(type = type, clientId = clientId, payload = payload))
}

/** Throws if the envelope is an error; otherwise returns it unchanged. */
fun rejectOnError(e: Envelope): Envelope {
    if (e.type == TYPE_ERROR) throw SignalException("signal error: ${e.reason ?: "unknown"}")
    return e
}
