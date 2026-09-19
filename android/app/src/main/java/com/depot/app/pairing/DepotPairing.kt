package com.depot.app.pairing

import android.content.Context
import com.depot.app.crypto.computeSAS
import com.depot.app.crypto.deriveKeys
import com.depot.app.crypto.ecdh
import com.depot.app.crypto.fromBase64
import com.depot.app.crypto.generateEphemeralKeyPair
import com.depot.app.crypto.issueCredential
import com.depot.app.crypto.pairingTranscript
import com.depot.app.crypto.PairingTranscriptInput
import com.depot.app.crypto.signPairResponse
import com.depot.app.crypto.toBase64
import com.depot.app.signal.SignalClient
import com.depot.app.signal.TYPE_ERROR
import com.depot.app.signal.TYPE_PEER_JOINED
import com.depot.app.signal.TYPE_PEER_LEFT
import com.depot.app.storage.DeviceRecord
import com.depot.app.storage.DeviceStore
import com.depot.app.storage.IdentityStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.selects.select
import org.json.JSONObject

class PairingException(message: String) : Exception(message)

private enum class SasOutcome { APPROVED, REJECTED, GONE }

interface DepotPairingCallbacks {
    fun onStatus(status: String)

    /**
     * The SAS is ready. Nothing proceeds until the human compares it with
     * the Client's screen and calls [approve] — this comparison, not any
     * signature, is what actually defeats a Signal-in-the-middle (§3.4).
     *
     * [reject] is the other half of that comparison, and it has to exist:
     * telling someone the digits might not match and then offering them
     * no way to say so turns the check into theatre. Rejecting tears the
     * session down without issuing a credential.
     */
    fun onSas(sas: String, approve: () -> Unit, reject: () -> Unit)

    fun onPaired(device: DeviceRecord)
    fun onError(message: String)
}

/**
 * Depot side of protocol.md §3.2, as the phone runs it. The web Depot
 * simulator does the same thing in a browser tab; this is the real one.
 */
suspend fun runDepotPairing(
    context: Context,
    qrPayloadRaw: String,
    cb: DepotPairingCallbacks,
) {
    var client: SignalClient? = null
    try {
        val qr = QrPayload.parse(qrPayloadRaw)

        cb.onStatus("loading Depot identity")
        val depotIdentity = IdentityStore.loadOrCreate(context)
        val depotEphemeral = generateEphemeralKeyPair()

        cb.onStatus("connecting to signal")
        val signal = SignalClient(qr.signalUrl)
        client = signal
        signal.connect()
        signal.ready()

        signal.join(qr.sessionId)
        val joined = signal.waitFor { it.type == TYPE_PEER_JOINED || it.type == TYPE_ERROR }
        if (joined.type == TYPE_ERROR) {
            throw PairingException("could not join pairing session: ${joined.reason}")
        }

        val sessionId = qr.sessionId.fromBase64()
        val nonce = qr.nonce.fromBase64()
        val clientEk = qr.clientEk.fromBase64()
        val clientIk = qr.clientIk.fromBase64()

        cb.onStatus("sending pairing response")
        val sig = signPairResponse(depotIdentity.privateKey, depotEphemeral.publicKey, sessionId, nonce)
        signal.relay(
            "PAIR_RESPONSE",
            JSONObject()
                .put("depotEk", depotEphemeral.publicKey.toBase64())
                .put("depotIk", depotIdentity.publicKey.toBase64())
                .put("sig", sig),
        )

        val shared = ecdh(depotEphemeral.privateKey, clientEk)
        val transcript = pairingTranscript(
            PairingTranscriptInput(
                version = qr.v,
                sessionId = sessionId,
                clientEk = clientEk,
                clientIk = clientIk,
                depotEk = depotEphemeral.publicKey,
                depotIk = depotIdentity.publicKey,
                nonce = nonce,
            ),
        )
        val keys = deriveKeys(shared, transcript)
        val sas = computeSAS(keys.sasSeed)

        cb.onStatus("compare this code with the Client, then approve")
        val approved = CompletableDeferred<Unit>()
        val rejected = CompletableDeferred<Unit>()
        cb.onSas(sas, { approved.complete(Unit) }, { rejected.complete(Unit) })

        // Whichever happens first: the human approves, the human rejects,
        // or the Client gives up and disconnects. Waiting only on approval
        // would leave the screen showing a code for a peer already gone.
        val peerLeft = CompletableDeferred<Unit>()
        val unsubscribe = signal.onMessage { e ->
            if (e.type == TYPE_PEER_LEFT || e.type == TYPE_ERROR) peerLeft.complete(Unit)
        }
        val outcome = try {
            select {
                approved.onAwait { SasOutcome.APPROVED }
                rejected.onAwait { SasOutcome.REJECTED }
                peerLeft.onAwait { SasOutcome.GONE }
            }
        } finally {
            unsubscribe()
        }
        when (outcome) {
            // No credential is issued and no device record is written, so
            // the Client is left exactly as unknown as it started. The
            // `finally` below closes the socket, which is what the Client
            // sees.
            SasOutcome.REJECTED ->
                throw PairingException("codes did not match — pairing refused")
            SasOutcome.GONE ->
                throw PairingException("Client disconnected before pairing was approved")
            SasOutcome.APPROVED -> Unit
        }

        val clientIdB64 = clientIk.toBase64()
        val depotIdB64 = depotIdentity.publicKey.toBase64()

        cb.onStatus("issuing credential")
        val credential = issueCredential(depotIdentity.privateKey, depotIdB64, clientIdB64)

        val now = System.currentTimeMillis()
        val device = DeviceRecord(
            clientIdentityPub = clientIdB64,
            label = "Paired client",
            createdAt = now,
            lastSeenAt = now,
            revoked = false,
        )
        DeviceStore.save(context, device)

        signal.relay(
            "PAIR_CONFIRM",
            JSONObject().put(
                "credential",
                JSONObject()
                    .put("depotId", credential.depotId)
                    .put("clientId", credential.clientId)
                    .put("issuedAt", credential.issuedAt)
                    .put("expiresAt", credential.expiresAt)
                    .put("sig", credential.sig),
            ),
        )

        cb.onStatus("paired")
        cb.onPaired(device)
    } catch (e: Exception) {
        cb.onError(e.message ?: e.toString())
    } finally {
        client?.close()
    }
}
