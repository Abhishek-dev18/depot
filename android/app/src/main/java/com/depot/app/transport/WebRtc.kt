package com.depot.app.transport

import android.content.Context
import com.depot.app.signal.SignalClient
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStatsCollectorCallback
import org.webrtc.RTCStatsReport
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

class TransportException(message: String) : Exception(message)

/**
 * protocol.md §5.1: the project operates no TURN server — public STUN by
 * default. A user who self-hosts one can supply it here.
 */
private const val DEFAULT_STUN = "stun:stun.l.google.com:19302"

data class TurnConfig(val url: String, val username: String, val credential: String)

enum class ConnectionType { DIRECT, RELAYED, UNKNOWN }

class DataChannels(
    val pc: PeerConnection,
    val ctl: DataChannel,
    val data: DataChannel,
    val connectionType: ConnectionType,
) {
    fun close() {
        // Order matters: the channels reference the connection.
        runCatching { ctl.close() }
        runCatching { data.close() }
        runCatching { pc.close() }
    }
}

object WebRtc {
    private val initialized = AtomicBoolean(false)
    private lateinit var factory: PeerConnectionFactory

    /** Loads the native library once per process. */
    fun ensureInitialized(context: Context) {
        if (!initialized.compareAndSet(false, true)) return
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions
                .builder(context.applicationContext)
                .createInitializationOptions(),
        )
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
    }

    private fun iceServers(turn: TurnConfig?): List<PeerConnection.IceServer> = buildList {
        add(PeerConnection.IceServer.builder(DEFAULT_STUN).createIceServer())
        if (turn != null && turn.url.isNotBlank()) {
            add(
                PeerConnection.IceServer.builder(turn.url)
                    .setUsername(turn.username)
                    .setPassword(turn.credential)
                    .createIceServer(),
            )
        }
    }

    /**
     * Depot side of §5.2. Per §5.8 the Client is always the offerer and
     * creates both channels, so this waits for an offer and answers it.
     */
    suspend fun negotiateAsAnswerer(
        context: Context,
        signal: SignalClient,
        clientId: String,
        turn: TurnConfig?,
        timeoutMs: Long = 30_000,
    ): DataChannels {
        ensureInitialized(context)

        val ctlReady = CompletableDeferred<DataChannel>()
        val dataReady = CompletableDeferred<DataChannel>()

        // Remote candidates can arrive before setRemoteDescription resolves;
        // WebRTC rejects those, so they are queued until it has.
        val pending = mutableListOf<IceCandidate>()
        var remoteDescriptionSet = false
        val iceLock = Any()

        lateinit var pc: PeerConnection
        val observer = object : PeerConnectionObserverAdapter() {
            override fun onIceCandidate(candidate: IceCandidate) {
                signal.relay(
                    "RTC_ICE",
                    JSONObject().put(
                        "candidate",
                        JSONObject()
                            .put("candidate", candidate.sdp)
                            .put("sdpMid", candidate.sdpMid)
                            .put("sdpMLineIndex", candidate.sdpMLineIndex),
                    ),
                    clientId,
                )
            }

            override fun onDataChannel(channel: DataChannel) {
                when (channel.label()) {
                    "ctl" -> ctlReady.complete(channel)
                    "data" -> dataReady.complete(channel)
                }
            }
        }

        pc = factory.createPeerConnection(
            PeerConnection.RTCConfiguration(iceServers(turn)).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            },
            observer,
        ) ?: throw TransportException("could not create a peer connection")

        val unsubscribe = signal.onMessage { e ->
            if (e.type == "RTC_ICE" && e.clientId == clientId) {
                val c = e.payload?.optJSONObject("candidate") ?: return@onMessage
                val candidate = IceCandidate(
                    c.optString("sdpMid"),
                    c.optInt("sdpMLineIndex"),
                    c.optString("candidate"),
                )
                synchronized(iceLock) {
                    if (remoteDescriptionSet) pc.addIceCandidate(candidate) else pending.add(candidate)
                }
            }
        }

        try {
            return withTimeout(timeoutMs) {
                val offerEnvelope = signal.waitFor(timeoutMs) { it.type == "RTC_OFFER" && it.clientId == clientId }
                val offerSdp = offerEnvelope.payload?.getString("sdp")
                    ?: throw TransportException("RTC_OFFER carried no sdp")

                pc.setRemoteDescriptionAsync(SessionDescription(SessionDescription.Type.OFFER, offerSdp))
                synchronized(iceLock) {
                    remoteDescriptionSet = true
                    for (c in pending) pc.addIceCandidate(c)
                    pending.clear()
                }

                val answer = pc.createAnswerAsync()
                pc.setLocalDescriptionAsync(answer)
                signal.relay(
                    "RTC_ANSWER",
                    JSONObject().put("sdp", answer.description).put("type", "answer"),
                    clientId,
                )

                val ctl = ctlReady.await()
                val data = dataReady.await()
                ctl.awaitOpen()
                data.awaitOpen()

                DataChannels(pc, ctl, data, pc.resolveConnectionType())
            }
        } catch (e: Exception) {
            pc.close()
            throw e
        } finally {
            unsubscribe()
        }
    }
}

/**
 * "Connection state is never hidden" (the interface design artifact): a
 * user of a privacy tool deserves to know whether their bytes are passing
 * through a third machine.
 */
private suspend fun PeerConnection.resolveConnectionType(): ConnectionType {
    val report: RTCStatsReport = suspendCancellableCoroutine { cont ->
        getStats(RTCStatsCollectorCallback { cont.resume(it) })
    }
    val stats = report.statsMap
    val pair = stats.values.firstOrNull { s ->
        s.type == "candidate-pair" && s.members["state"] == "succeeded"
    } ?: return ConnectionType.UNKNOWN
    val localId = pair.members["localCandidateId"] as? String ?: return ConnectionType.UNKNOWN
    val candidateType = stats[localId]?.members?.get("candidateType") as? String
        ?: return ConnectionType.UNKNOWN
    // host / srflx / prflx are all some flavour of direct; only relay means TURN.
    return if (candidateType == "relay") ConnectionType.RELAYED else ConnectionType.DIRECT
}

private suspend fun DataChannel.awaitOpen(timeoutMs: Long = 20_000) {
    if (state() == DataChannel.State.OPEN) return
    withTimeout(timeoutMs) {
        suspendCancellableCoroutine { cont ->
            registerObserver(object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) = Unit
                override fun onMessage(buffer: DataChannel.Buffer) = Unit
                override fun onStateChange() {
                    if (state() == DataChannel.State.OPEN && cont.isActive) cont.resume(Unit)
                }
            })
            if (state() == DataChannel.State.OPEN && cont.isActive) cont.resume(Unit)
        }
    }
    // The transfer session installs its own observer.
    unregisterObserver()
}

private suspend fun PeerConnection.createAnswerAsync(): SessionDescription =
    suspendCancellableCoroutine { cont ->
        createAnswer(
            object : SdpObserverAdapter() {
                override fun onCreateSuccess(sdp: SessionDescription) = cont.resume(sdp)
                override fun onCreateFailure(error: String) =
                    cont.resumeWithException(TransportException("createAnswer failed: $error"))
            },
            MediaConstraints(),
        )
    }

private suspend fun PeerConnection.setLocalDescriptionAsync(sdp: SessionDescription) =
    suspendCancellableCoroutine { cont ->
        setLocalDescription(
            object : SdpObserverAdapter() {
                override fun onSetSuccess() = cont.resume(Unit)
                override fun onSetFailure(error: String) =
                    cont.resumeWithException(TransportException("setLocalDescription failed: $error"))
            },
            sdp,
        )
    }

private suspend fun PeerConnection.setRemoteDescriptionAsync(sdp: SessionDescription) =
    suspendCancellableCoroutine { cont ->
        setRemoteDescription(
            object : SdpObserverAdapter() {
                override fun onSetSuccess() = cont.resume(Unit)
                override fun onSetFailure(error: String) =
                    cont.resumeWithException(TransportException("setRemoteDescription failed: $error"))
            },
            sdp,
        )
    }

/** SdpObserver has four methods and any given call only cares about two. */
private abstract class SdpObserverAdapter : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription) = Unit
    override fun onSetSuccess() = Unit
    override fun onCreateFailure(error: String) = Unit
    override fun onSetFailure(error: String) = Unit
}

/** PeerConnection.Observer declares ten abstract methods; this app needs two. */
private abstract class PeerConnectionObserverAdapter : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
    override fun onIceCandidate(candidate: IceCandidate) = Unit
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
    override fun onAddStream(stream: MediaStream) = Unit
    override fun onRemoveStream(stream: MediaStream) = Unit
    override fun onDataChannel(channel: DataChannel) = Unit
    override fun onRenegotiationNeeded() = Unit
    override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = Unit
}
