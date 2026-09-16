package com.depot.app.crypto

/**
 * protocol.md §3.2's PAIR_RESPONSE carries a `sig` whose exact coverage the
 * spec leaves unstated. Both implementations bind it to depotEk, sessionId
 * and nonce: it lets the Client reject a Depot whose DepotIdentity does not
 * actually endorse the ephemeral key it just presented — defense in depth
 * before the human SAS comparison, which carries the real authentication
 * weight against a Signal-in-the-middle (§3.4).
 */
private fun pairResponseSigningBytes(depotEk: ByteArray, sessionId: ByteArray, nonce: ByteArray): ByteArray =
    buildTranscript(listOf(depotEk, sessionId, nonce))

fun signPairResponse(
    depotIdentityPrivate: ByteArray,
    depotEk: ByteArray,
    sessionId: ByteArray,
    nonce: ByteArray,
): String = signDetached(pairResponseSigningBytes(depotEk, sessionId, nonce), depotIdentityPrivate).toBase64()

fun verifyPairResponse(
    sigB64: String,
    depotIk: ByteArray,
    depotEk: ByteArray,
    sessionId: ByteArray,
    nonce: ByteArray,
): Boolean = try {
    verifyDetached(sigB64.fromBase64(), pairResponseSigningBytes(depotEk, sessionId, nonce), depotIk)
} catch (_: IllegalArgumentException) {
    false
}
