package com.depot.app.crypto

import com.goterl.lazysodium.interfaces.Box
import com.goterl.lazysodium.interfaces.Sign

data class KeyPair(val publicKey: ByteArray, val privateKey: ByteArray) {
    // Data classes compare ByteArray by reference; key material deserves
    // content comparison so equality means what a caller would expect.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is KeyPair) return false
        return publicKey.contentEquals(other.publicKey) && privateKey.contentEquals(other.privateKey)
    }

    override fun hashCode(): Int = 31 * publicKey.contentHashCode() + privateKey.contentHashCode()
}

/** Ed25519 identity keypair — long-term, per protocol.md §2.1. */
fun generateIdentityKeyPair(): KeyPair {
    val pk = ByteArray(Sign.ED25519_PUBLICKEYBYTES)
    val sk = ByteArray(Sign.ED25519_SECRETKEYBYTES)
    require(Sodium.lazy.cryptoSignKeypair(pk, sk), "crypto_sign_keypair")
    return KeyPair(pk, sk)
}

/** Deterministic Ed25519 keypair from a 32-byte seed — used by the test vectors. */
fun identityKeyPairFromSeed(seed: ByteArray): KeyPair {
    require(seed.size == Sign.ED25519_SEEDBYTES) { "seed must be ${Sign.ED25519_SEEDBYTES} bytes" }
    val pk = ByteArray(Sign.ED25519_PUBLICKEYBYTES)
    val sk = ByteArray(Sign.ED25519_SECRETKEYBYTES)
    require(Sodium.lazy.cryptoSignSeedKeypair(pk, sk, seed), "crypto_sign_seed_keypair")
    return KeyPair(pk, sk)
}

/** X25519 ephemeral keypair — one pairing or one session, per protocol.md §2.1. */
fun generateEphemeralKeyPair(): KeyPair {
    val pk = ByteArray(Box.PUBLICKEYBYTES)
    val sk = ByteArray(Box.SECRETKEYBYTES)
    require(Sodium.lazy.cryptoBoxKeypair(pk, sk), "crypto_box_keypair")
    return KeyPair(pk, sk)
}

/** X25519 public key for a given private scalar. */
fun scalarMultBase(privateKey: ByteArray): ByteArray {
    val out = ByteArray(Box.PUBLICKEYBYTES)
    require(Sodium.lazy.cryptoScalarMultBase(out, privateKey), "crypto_scalarmult_base")
    return out
}

fun randomBytes(length: Int): ByteArray = Sodium.lazy.randomBytesBuf(length)
