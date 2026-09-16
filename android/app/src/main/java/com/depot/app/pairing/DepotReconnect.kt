package com.depot.app.pairing

import android.content.Context
import com.depot.app.crypto.Credential
import com.depot.app.crypto.DerivedKeys
import com.depot.app.crypto.deriveKeys
import com.depot.app.crypto.ecdh
import com.depot.app.crypto.fromBase64
import com.depot.app.crypto.generateEphemeralKeyPair
import com.depot.app.crypto.issueCredential
import com.depot.app.crypto.randomBytes
import com.depot.app.crypto.reconnectTranscript
import com.depot.app.crypto.toBase64
import com.depot.app.crypto.verifyCredential
import com.depot.app.crypto.verifyReconnectResponse
import com.depot.app.signal.Envelope
import com.depot.app.signal.SignalClient
import com.depot.app.signal.TYPE_ERROR
import com.depot.app.signal.TYPE_INCOMING
import com.depot.app.signal.TYPE_PEER_LEFT
import com.depot.app.storage.DeviceStore
import com.depot.app.storage.IdentityStore
import com.depot.app.transport.ConnectionType
import com.depot.app.transport.FileSender
import com.depot.app.transport.OfferedFile
import com.depot.app.transport.SessionKeys
import com.depot.app.transport.TransferCallbacks
import com.depot.app.transport.TurnConfig
import com.depot.app.transport.WebRtc
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * protocol.md §4.1 / §8.2: renewal is silent rather than forced
 * re-approval. A device that keeps reconnecting never has to redo the §3
 * QR flow; one that stops simply lets its credential expire on schedule.
 */
private const val RENEW_WITHIN_MS = 30L * 24 * 60 * 60 * 1000

/**
 * protocol.md §4.2. The reason travels in the payload rather than the
 * envelope's `reason` field: Signal populates that only on errors it
 * generates itself and drops it when relaying between peers.
 */
private const val TYPE_REJECTED = "REJECTED"

interface DepotReconnectCallbacks {
    fun onStatus(status: String)
    fun onRegistered(depotId: String)
    fun onClientAuthenticated(clientId: String)
    fun onClientConnected(clientId: String, connectionType: ConnectionType)
    fun onProgress(clientId: String, index: Int, total: Int, bytesSent: Long, bytesTotal: Long)
    fun onClientRejected(clientId: String, reason: String)
}

class DepotReconnectListener(
    val depotId: String,
    private val signal: SignalClient,
    private val connections: ConcurrentHashMap<String, () -> Unit>,
) {
    fun stop() {
        // Closing only the WebSocket would leave every PeerConnection from
        // this session alive, still holding ICE sockets and running
        // keepalives, and the next session would negotiate alongside them.
        for (close in connections.values) runCatching { close() }
        connections.clear()
        signal.close()
    }

    /**
     * protocol.md §6 steps 4-5. Telling Signal is only a routing
     * optimisation — what actually revokes a device is this Depot refusing
     * its §4 handshake, which DeviceStore already records.
     */
    fun revoke(clientId: String) = signal.revoke(clientId)
}

/**
 * Depot side of protocol.md §4, run as a background listener: register
 * presence once, then handle each reconnecting Client independently.
 */
suspend fun runDepotReconnectListener(
    context: Context,
    scope: CoroutineScope,
    signalUrl: String,
    turn: TurnConfig?,
    getFile: () -> OfferedFile?,
    cb: DepotReconnectCallbacks,
): DepotReconnectListener {
    val depotIdentity = IdentityStore.loadOrCreate(context)
    val depotId = depotIdentity.publicKey.toBase64()

    cb.onStatus("connecting to signal")
    val signal = SignalClient(signalUrl)
    signal.connect()
    signal.ready()

    signal.register(depotId)
    cb.onStatus("registered, listening for reconnections")
    cb.onRegistered(depotId)

    val connections = ConcurrentHashMap<String, () -> Unit>()

    signal.onMessage { e ->
        val clientId = e.clientId
        when {
            e.type == TYPE_INCOMING && clientId != null -> scope.launch {
                handleIncoming(
                    context, scope, signal, depotIdentity.privateKey, depotId,
                    e, turn, getFile, connections, cb,
                )
            }
            // A Client that goes away releases its transport immediately
            // rather than at the next stop().
            e.type == TYPE_PEER_LEFT && clientId != null -> {
                connections.remove(clientId)?.let { runCatching { it() } }
            }
        }
    }

    return DepotReconnectListener(depotId, signal, connections)
}

private suspend fun handleIncoming(
    context: Context,
    scope: CoroutineScope,
    signal: SignalClient,
    depotPrivateKey: ByteArray,
    depotId: String,
    incoming: Envelope,
    turn: TurnConfig?,
    getFile: () -> OfferedFile?,
    connections: ConcurrentHashMap<String, () -> Unit>,
    cb: DepotReconnectCallbacks,
) {
    val clientId = incoming.clientId ?: return
    try {
        val payload = incoming.payload ?: throw PairingException("reconnect request carried no payload")
        val credentialJson = payload.getJSONObject("credential")
        val credential = Credential(
            depotId = credentialJson.getString("depotId"),
            clientId = credentialJson.getString("clientId"),
            issuedAt = credentialJson.getLong("issuedAt"),
            expiresAt = credentialJson.getLong("expiresAt"),
            sig = credentialJson.getString("sig"),
        )

        // A credential is a public claim, so every field is checked against
        // who is actually speaking rather than taken at face value.
        if (credential.depotId != depotId) throw PairingException("credential is for a different Depot")
        if (credential.clientId != clientId) throw PairingException("credential clientId does not match sender")
        if (!verifyCredential(credential, depotId.fromBase64())) {
            throw PairingException("invalid or expired credential")
        }

        val device = DeviceStore.get(context, clientId)
        if (device == null || device.revoked) {
            throw PairingException("not a known, un-revoked device — pair first")
        }

        val clientEk = payload.getString("clientEk").fromBase64()
        val depotEphemeral = generateEphemeralKeyPair()
        val challengeNonce = randomBytes(16)

        signal.relay(
            "CHALLENGE",
            JSONObject()
                .put("depotEk", depotEphemeral.publicKey.toBase64())
                .put("challengeNonce", challengeNonce.toBase64()),
            clientId,
        )

        val response = signal.waitFor { e ->
            e.clientId == clientId && (e.type == "RESPONSE" || e.type == TYPE_PEER_LEFT || e.type == TYPE_ERROR)
        }
        if (response.type != "RESPONSE") throw PairingException("client disconnected before responding")

        val sig = response.payload?.getString("sig")
            ?: throw PairingException("RESPONSE carried no signature")
        val transcript = reconnectTranscript(clientEk, depotEphemeral.publicKey, challengeNonce)

        // This is the step that matters: holding the credential proves
        // nothing, because it is public. Only the ClientIdentity private
        // key can sign this fresh challenge.
        if (!verifyReconnectResponse(sig, transcript, clientId.fromBase64())) {
            throw PairingException("signature does not match the stored ClientIdentity")
        }

        DeviceStore.touch(context, clientId)

        val renewed: Credential? =
            if (credential.expiresAt - System.currentTimeMillis() < RENEW_WITHIN_MS) {
                issueCredential(depotPrivateKey, depotId, clientId)
            } else {
                null
            }

        val sessionOk = JSONObject()
        renewed?.let {
            sessionOk.put(
                "credential",
                JSONObject()
                    .put("depotId", it.depotId)
                    .put("clientId", it.clientId)
                    .put("issuedAt", it.issuedAt)
                    .put("expiresAt", it.expiresAt)
                    .put("sig", it.sig),
            )
        }
        signal.relay("SESSION_OK", sessionOk, clientId)

        val keys: DerivedKeys = deriveKeys(ecdh(depotEphemeral.privateKey, clientEk), transcript)
        cb.onClientAuthenticated(clientId)

        // §5: the Client is the offerer, so it opens the data channels as
        // soon as it sees SESSION_OK. This side answers.
        // A reconnecting Client replaces whatever it had before; without
        // this, repeated reconnects stack live PeerConnections.
        connections.remove(clientId)?.let { runCatching { it() } }

        val channels = WebRtc.negotiateAsAnswerer(context, signal, clientId, turn)
        cb.onClientConnected(clientId, channels.connectionType)

        val sender = FileSender(
            channels = channels,
            keys = SessionKeys(keys.kC2D, keys.kD2C),
            getFile = getFile,
            cb = object : TransferCallbacks {
                override fun onManifestSent(transferId: Int, chunkCount: Int) {
                    cb.onStatus("offering $chunkCount chunk(s)")
                }

                override fun onChunkSent(index: Int, total: Int, bytesSent: Long, bytesTotal: Long) {
                    cb.onProgress(clientId, index, total, bytesSent, bytesTotal)
                }

                override fun onError(message: String) {
                    cb.onClientRejected(clientId, message)
                }
            },
        )
        // The ctl observer fires on a WebRTC thread, so each message is
        // handed to the scope rather than handled inline.
        sender.start { msg -> scope.launch { sender.handle(msg) } }

        connections[clientId] = {
            sender.stop()
            channels.close()
        }
    } catch (e: Exception) {
        val reason = e.message ?: e.toString()
        // protocol.md §4.2 — say so rather than leaving the Client to sit
        // until its timeout. These reasons say only whether a credential
        // is still honoured, which the outcome reveals anyway.
        runCatching {
            signal.relay(TYPE_REJECTED, JSONObject().put("reason", reason), clientId)
        }
        cb.onClientRejected(clientId, reason)
    }
}
