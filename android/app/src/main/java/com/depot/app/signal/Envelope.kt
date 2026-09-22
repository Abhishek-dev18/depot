package com.depot.app.signal

import org.json.JSONObject

/** Mirrors signal/envelope.go — must stay in sync with the Go server (protocol.md §7.1). */
class Envelope(
    val type: String,
    val sessionId: String? = null,
    val depotId: String? = null,
    val clientId: String? = null,
    val reason: String? = null,
    val payload: JSONObject? = null,
) {
    /** The Go server declares every field `omitempty`, so absent means absent. */
    fun toJson(): String {
        val o = JSONObject()
        o.put("type", type)
        sessionId?.let { o.put("sessionId", it) }
        depotId?.let { o.put("depotId", it) }
        clientId?.let { o.put("clientId", it) }
        reason?.let { o.put("reason", it) }
        payload?.let { o.put("payload", it) }
        return o.toString()
    }

    companion object {
        fun fromJson(text: String): Envelope {
            val o = JSONObject(text)
            return Envelope(
                type = o.optString("type"),
                sessionId = o.optStringOrNull("sessionId"),
                depotId = o.optStringOrNull("depotId"),
                clientId = o.optStringOrNull("clientId"),
                reason = o.optStringOrNull("reason"),
                payload = o.optJSONObject("payload"),
            )
        }
    }
}

/** optString() returns "" for a missing key, which is not the same as absent. */
private fun JSONObject.optStringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) getString(key) else null

// Message types Signal owns.
const val TYPE_HELLO = "hello"
const val TYPE_JOIN = "join"
const val TYPE_REGISTER = "register"
const val TYPE_CONNECT = "connect"
const val TYPE_REVOKE = "revoke"

const val TYPE_SESSION_CREATED = "session_created"
const val TYPE_PEER_JOINED = "peer_joined"
const val TYPE_PEER_LEFT = "peer_left"
const val TYPE_INCOMING = "incoming"
const val TYPE_ERROR = "error"

/** Signal -> a registering Depot: sign this nonce to prove it is you (§7.1). */
const val TYPE_REGISTER_CHALLENGE = "register_challenge"

/** Signal -> a Depot whose proof checked out: Clients can reach it now. */
const val TYPE_REGISTERED = "registered"

// Error reasons.
const val REASON_SESSION_EXPIRED = "session_expired"
const val REASON_SESSION_FULL = "session_full"
const val REASON_SESSION_NOT_FOUND = "session_not_found"
const val REASON_DEPOT_OFFLINE = "depot_offline"
const val REASON_CLIENT_REVOKED = "client_revoked"
const val REASON_RATE_LIMITED = "rate_limited"
const val REASON_NO_ROUTE = "no_route"
const val REASON_BAD_ENVELOPE = "bad_envelope"
const val REASON_ALREADY_CONNECTED = "already_connected"

/** A register not signed by the key its depotId names. */
const val REASON_UNAUTHORIZED = "unauthorized"
