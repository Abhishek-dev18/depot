package com.depot.app.crypto

import com.goterl.lazysodium.LazySodiumAndroid
import com.goterl.lazysodium.SodiumAndroid

/**
 * The single libsodium handle for the process. LazySodium implements every
 * Native interface this package needs (AEAD, GenericHash, Sign, Box,
 * DiffieHellman, Random) on one object, and loading the native library
 * twice is wasteful, so it is created once here.
 */
object Sodium {
    val lazy: LazySodiumAndroid by kotlin.lazy { LazySodiumAndroid(SodiumAndroid()) }
}

/** Every native call returns false on failure; none of them may fail silently. */
internal fun require(ok: Boolean, what: String) {
    if (!ok) throw IllegalStateException("libsodium call failed: $what")
}
