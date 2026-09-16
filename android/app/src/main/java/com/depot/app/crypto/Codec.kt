package com.depot.app.crypto

import java.util.Base64

/**
 * Standard-alphabet base64 with padding stripped, matching web/src/crypto/codec.ts.
 * The two sides exchange these strings verbatim inside the QR payload and
 * credentials, so the encoding has to agree byte for byte. java.util.Base64
 * is available from API 26, which is this app's minSdk.
 */
fun ByteArray.toBase64(): String = Base64.getEncoder().withoutPadding().encodeToString(this)

/** Accepts padded or unpadded input — the Java decoder tolerates both. */
fun String.fromBase64(): ByteArray = Base64.getDecoder().decode(this)

fun ByteArray.toHex(): String {
    val out = StringBuilder(size * 2)
    for (b in this) {
        val v = b.toInt() and 0xff
        out.append("0123456789abcdef"[v ushr 4])
        out.append("0123456789abcdef"[v and 0x0f])
    }
    return out.toString()
}

fun String.fromHex(): ByteArray {
    require(length % 2 == 0) { "hex string has odd length" }
    val out = ByteArray(length / 2)
    for (i in out.indices) {
        out[i] = ((Character.digit(this[i * 2], 16) shl 4) or Character.digit(this[i * 2 + 1], 16)).toByte()
    }
    return out
}
