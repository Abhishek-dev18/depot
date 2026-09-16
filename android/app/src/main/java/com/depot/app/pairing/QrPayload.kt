package com.depot.app.pairing

import org.json.JSONObject

const val PROTOCOL_VERSION = 1
const val PAIRING_QR_TTL_MS = 120_000L // protocol.md §3.1

/**
 * protocol.md §3.1 — what the Client's QR code carries, all key material
 * base64. It holds no secret and no token: photographing the screen grants
 * nothing, because completing the pairing needs approval on this phone and
 * the ephemeral key is single-use.
 */
data class QrPayload(
    val v: Int,
    val signalUrl: String,
    val sessionId: String,
    val clientEk: String,
    val clientIk: String,
    val nonce: String,
) {
    companion object {
        fun parse(raw: String): QrPayload {
            val o = try {
                JSONObject(raw)
            } catch (_: Exception) {
                throw IllegalArgumentException("that is not valid QR payload JSON")
            }

            val payload = QrPayload(
                v = o.optInt("v", 0),
                signalUrl = o.optString("s"),
                sessionId = o.optString("id"),
                clientEk = o.optString("ek"),
                clientIk = o.optString("ik"),
                nonce = o.optString("n"),
            )

            if (payload.signalUrl.isEmpty() || payload.sessionId.isEmpty() ||
                payload.clientEk.isEmpty() || payload.clientIk.isEmpty() || payload.nonce.isEmpty()
            ) {
                throw IllegalArgumentException("QR payload is missing required fields")
            }
            // §3.1: the version is here so a Depot can refuse an incompatible
            // Client cleanly rather than failing later with a SAS mismatch.
            if (payload.v != PROTOCOL_VERSION) {
                throw IllegalArgumentException("unsupported protocol version ${payload.v}")
            }
            return payload
        }
    }
}
