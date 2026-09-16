package com.depot.app.crypto

import java.io.ByteArrayOutputStream

/**
 * Length-prefixed concatenation, per protocol.md §3.3: every field is
 * preceded by its length as a uint16 big-endian, so no two distinct field
 * splits can produce the same bytes (unlike naive concatenation, where
 * "ab"+"c" and "a"+"bc" collide).
 */
fun buildTranscript(fields: List<ByteArray>): ByteArray {
    val out = ByteArrayOutputStream()
    for (f in fields) {
        require(f.size <= 0xffff) { "transcript field exceeds uint16 length prefix" }
        out.write((f.size ushr 8) and 0xff)
        out.write(f.size and 0xff)
        out.write(f)
    }
    return out.toByteArray()
}

fun u8(n: Int): ByteArray = byteArrayOf((n and 0xff).toByte())

fun u32be(n: Int): ByteArray = byteArrayOf(
    ((n ushr 24) and 0xff).toByte(),
    ((n ushr 16) and 0xff).toByte(),
    ((n ushr 8) and 0xff).toByte(),
    (n and 0xff).toByte(),
)

fun u64be(n: Long): ByteArray {
    val out = ByteArray(8)
    for (i in 0 until 8) out[i] = ((n ushr (56 - i * 8)) and 0xff).toByte()
    return out
}

fun readU32be(bytes: ByteArray, offset: Int): Int =
    ((bytes[offset].toInt() and 0xff) shl 24) or
        ((bytes[offset + 1].toInt() and 0xff) shl 16) or
        ((bytes[offset + 2].toInt() and 0xff) shl 8) or
        (bytes[offset + 3].toInt() and 0xff)

fun readU64be(bytes: ByteArray, offset: Int): Long {
    var v = 0L
    for (i in 0 until 8) v = (v shl 8) or (bytes[offset + i].toLong() and 0xff)
    return v
}

/**
 * The web side uses an ASCII-only encoder here to sidestep a jsdom realm
 * quirk; for the protocol constants and base64 strings that reach this
 * function, UTF-8 produces identical bytes.
 */
fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)
