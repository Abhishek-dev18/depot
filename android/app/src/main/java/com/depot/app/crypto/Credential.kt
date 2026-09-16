package com.depot.app.crypto

import com.goterl.lazysodium.interfaces.Sign

/** protocol.md §3.6. sig is a base64 Ed25519 signature by DepotIdentity. */
data class Credential(
    val depotId: String,
    val clientId: String,
    val issuedAt: Long,
    val expiresAt: Long,
    val sig: String,
)

private const val NINETY_DAYS_MS = 90L * 24 * 60 * 60 * 1000

/** Canonical bytes the signature covers — everything but sig itself. */
private fun signingBytes(depotId: String, clientId: String, issuedAt: Long, expiresAt: Long): ByteArray =
    buildTranscript(listOf(utf8(depotId), utf8(clientId), u64be(issuedAt), u64be(expiresAt)))

fun signDetached(message: ByteArray, privateKey: ByteArray): ByteArray {
    val sig = ByteArray(Sign.ED25519_BYTES)
    require(
        Sodium.lazy.cryptoSignDetached(sig, message, message.size.toLong(), privateKey),
        "crypto_sign_detached",
    )
    return sig
}

/** Note the length is an Int here — lazysodium's verify takes int, sign takes long. */
fun verifyDetached(signature: ByteArray, message: ByteArray, publicKey: ByteArray): Boolean =
    signature.size == Sign.ED25519_BYTES &&
        Sodium.lazy.cryptoSignVerifyDetached(signature, message, message.size, publicKey)

/** Depot side: issue a credential for a newly (or already) paired client. */
fun issueCredential(
    depotIdentityPrivate: ByteArray,
    depotId: String,
    clientId: String,
    now: Long = System.currentTimeMillis(),
): Credential {
    val expiresAt = now + NINETY_DAYS_MS
    val sig = signDetached(signingBytes(depotId, clientId, now, expiresAt), depotIdentityPrivate)
    return Credential(depotId, clientId, now, expiresAt, sig.toBase64())
}

/** Checks signature and expiry only — revocation is a separate, local decision (§6). */
fun verifyCredential(
    cred: Credential,
    depotIdentityPublic: ByteArray,
    now: Long = System.currentTimeMillis(),
): Boolean {
    if (now >= cred.expiresAt) return false
    return try {
        verifyDetached(
            cred.sig.fromBase64(),
            signingBytes(cred.depotId, cred.clientId, cred.issuedAt, cred.expiresAt),
            depotIdentityPublic,
        )
    } catch (_: IllegalArgumentException) {
        false // malformed base64 in sig
    }
}
