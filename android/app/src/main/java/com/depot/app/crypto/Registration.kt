package com.depot.app.crypto

/**
 * protocol.md §7.1: a Depot registers with Signal by signing the nonce it
 * is handed, with the DepotIdentity its depotId names. Knowing a depotId
 * is not the same as being that Depot — every Client ever paired with it
 * knows it. The label keeps these bytes apart from everything else
 * DepotIdentity signs; signal/register.go builds the same bytes.
 */
private const val REGISTER_LABEL = "depot-signal-register/v1"

fun registerSigningBytes(depotId: String, nonce: ByteArray): ByteArray =
    buildTranscript(listOf(utf8(REGISTER_LABEL), utf8(depotId), nonce))

fun signRegistration(depotIdentityPrivate: ByteArray, depotId: String, nonce: ByteArray): String =
    signDetached(registerSigningBytes(depotId, nonce), depotIdentityPrivate).toBase64()
