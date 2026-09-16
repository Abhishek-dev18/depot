package com.depot.app.crypto

import com.goterl.lazysodium.interfaces.Box
import java.math.BigInteger

class PairingTranscriptInput(
    val version: Int,
    val sessionId: ByteArray,
    val clientEk: ByteArray,
    val clientIk: ByteArray,
    val depotEk: ByteArray,
    val depotIk: ByteArray,
    val nonce: ByteArray,
)

class DerivedKeys(
    val master: ByteArray,
    val kC2D: ByteArray,
    val kD2C: ByteArray,
    val sasSeed: ByteArray,
)

/** protocol.md §3.3 transcript — both sides must build identical bytes. */
fun pairingTranscript(input: PairingTranscriptInput): ByteArray = buildTranscript(
    listOf(
        u8(input.version),
        input.sessionId,
        input.clientEk,
        input.clientIk,
        input.depotEk,
        input.depotIk,
        input.nonce,
    ),
)

/** X25519(ownEphemeralPrivate, peerEphemeralPublic) — raw Diffie-Hellman. */
fun ecdh(ownPrivate: ByteArray, peerPublic: ByteArray): ByteArray {
    val out = ByteArray(Box.PUBLICKEYBYTES)
    require(Sodium.lazy.cryptoScalarMult(out, ownPrivate, peerPublic), "crypto_scalarmult")
    return out
}

/**
 * BLAKE2b. Note the 8-byte SAS seed below is shorter than libsodium's
 * advisory BYTES_MIN of 16; libsodium enforces only 1..64, and the web
 * implementation derives the same 8 bytes, which docs/vectors pins.
 */
fun blake2b(outLen: Int, message: ByteArray, key: ByteArray): ByteArray {
    val out = ByteArray(outLen)
    require(
        Sodium.lazy.cryptoGenericHash(out, outLen, message, message.size.toLong(), key, key.size),
        "crypto_generichash",
    )
    return out
}

/** protocol.md §3.3: master + directional keys + SAS seed, all BLAKE2b. */
fun deriveKeys(shared: ByteArray, transcript: ByteArray): DerivedKeys {
    val master = blake2b(32, transcript, shared)
    return DerivedKeys(
        master = master,
        kC2D = blake2b(32, utf8("depot/v1/c2d"), master),
        kD2C = blake2b(32, utf8("depot/v1/d2c"), master),
        sasSeed = blake2b(8, utf8("depot/v1/sas"), master),
    )
}

/** protocol.md §3.4: decimal(SAS_seed mod 1000000), zero-padded to 6 digits. */
fun computeSAS(sasSeed: ByteArray): String =
    BigInteger(1, sasSeed).mod(BigInteger.valueOf(1_000_000L)).toString().padStart(6, '0')
