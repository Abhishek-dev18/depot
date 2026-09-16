package com.depot.app.crypto

/**
 * protocol.md §4 leaves the exact "fresh transcript" the RESPONSE signs
 * unspecified beyond "a nonce the Depot chose in this session". Both
 * implementations bind it to the Depot's fresh challenge nonce and both
 * sides' fresh ephemeral keys, so a captured signature cannot be replayed
 * against a different reconnection or reflected back at its producer.
 */
fun reconnectTranscript(clientEk: ByteArray, depotEk: ByteArray, challengeNonce: ByteArray): ByteArray =
    buildTranscript(listOf(clientEk, depotEk, challengeNonce))

/** Client side: prove possession of ClientIdentity's private key. */
fun signReconnectResponse(clientIdentityPrivate: ByteArray, transcript: ByteArray): String =
    signDetached(transcript, clientIdentityPrivate).toBase64()

/** Depot side: step 4 of §4 — verify against the stored clientIdentityPub. */
fun verifyReconnectResponse(
    signatureB64: String,
    transcript: ByteArray,
    clientIdentityPublic: ByteArray,
): Boolean = try {
    verifyDetached(signatureB64.fromBase64(), transcript, clientIdentityPublic)
} catch (_: IllegalArgumentException) {
    false
}
