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

/**
 * What the Depot signs in CHALLENGE (§4 step 2), so the Client knows it is
 * talking to the Depot it paired with rather than whoever registered that
 * id at Signal. The label keeps these bytes distinct from everything else
 * DepotIdentity signs — a credential, a PAIR_RESPONSE — and from the
 * Client's own RESPONSE.
 */
private const val DEPOT_CHALLENGE_LABEL = "depot-reconnect-challenge/v1"

fun depotChallengeBytes(clientEk: ByteArray, depotEk: ByteArray, challengeNonce: ByteArray): ByteArray =
    buildTranscript(listOf(utf8(DEPOT_CHALLENGE_LABEL), clientEk, depotEk, challengeNonce))

/** Depot side: prove possession of DepotIdentity's private key. */
fun signDepotChallenge(
    depotIdentityPrivate: ByteArray,
    clientEk: ByteArray,
    depotEk: ByteArray,
    challengeNonce: ByteArray,
): String = signDetached(depotChallengeBytes(clientEk, depotEk, challengeNonce), depotIdentityPrivate).toBase64()

/** Client side: check a CHALLENGE against the depotId it paired with. */
fun verifyDepotChallenge(
    signatureB64: String,
    depotIdentityPublic: ByteArray,
    clientEk: ByteArray,
    depotEk: ByteArray,
    challengeNonce: ByteArray,
): Boolean = try {
    verifyDetached(signatureB64.fromBase64(), depotChallengeBytes(clientEk, depotEk, challengeNonce), depotIdentityPublic)
} catch (_: IllegalArgumentException) {
    false
}
