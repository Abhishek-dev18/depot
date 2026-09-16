package com.depot.app.crypto

import com.goterl.lazysodium.interfaces.AEAD

/** protocol.md §5.3 frame kinds. */
object FrameType {
    const val CHUNK: Byte = 1
    const val CTL: Byte = 2
}

const val FLAG_COMPRESSED: Int = 0b1

/** protocol.md §3.3 direction byte — which derived key a frame is encrypted with. */
object Direction {
    const val CLIENT_TO_DEPOT: Int = 0
    const val DEPOT_TO_CLIENT: Int = 1
}

private const val CHUNK_HEADER_LEN = 1 + 4 + 4 + 1
private const val CTL_HEADER_LEN = 1 + 8
private val NPUB = AEAD.XCHACHA20POLY1305_IETF_NPUBBYTES
private val ABYTES = AEAD.XCHACHA20POLY1305_IETF_ABYTES

/** No nonce is transmitted — both sides derive it (protocol.md §5.3). */
fun deriveChunkNonce(direction: Int, transferId: Int, chunkIndex: Int): ByteArray {
    val nonce = ByteArray(NPUB)
    nonce[0] = direction.toByte()
    u32be(transferId).copyInto(nonce, 1)
    u32be(chunkIndex).copyInto(nonce, 5)
    return nonce // remaining 15 bytes stay zero
}

/**
 * Control-frame nonce. The leading byte is `0x80 or direction`, so it can
 * never equal a chunk nonce's leading byte (0 or 1): the two nonce spaces
 * are disjoint by construction even though both use the same directional
 * key.
 */
fun deriveCtlNonce(direction: Int, counter: Long): ByteArray {
    val nonce = ByteArray(NPUB)
    nonce[0] = (0x80 or direction).toByte()
    u64be(counter).copyInto(nonce, 1)
    return nonce
}

private fun aeadEncrypt(key: ByteArray, nonce: ByteArray, plaintext: ByteArray): ByteArray {
    val ciphertext = ByteArray(plaintext.size + ABYTES)
    require(
        Sodium.lazy.cryptoAeadXChaCha20Poly1305IetfEncrypt(
            ciphertext, longArrayOf(0),
            plaintext, plaintext.size.toLong(),
            null, 0L,
            null, nonce, key,
        ),
        "crypto_aead_xchacha20poly1305_ietf_encrypt",
    )
    return ciphertext
}

private fun aeadDecrypt(key: ByteArray, nonce: ByteArray, ciphertext: ByteArray): ByteArray {
    if (ciphertext.size < ABYTES) throw IllegalArgumentException("ciphertext shorter than auth tag")
    val plaintext = ByteArray(ciphertext.size - ABYTES)
    require(
        Sodium.lazy.cryptoAeadXChaCha20Poly1305IetfDecrypt(
            plaintext, longArrayOf(0),
            null,
            ciphertext, ciphertext.size.toLong(),
            null, 0L,
            nonce, key,
        ),
        "crypto_aead_xchacha20poly1305_ietf_decrypt",
    )
    return plaintext
}

class EncodedChunk(
    val transferId: Int,
    val chunkIndex: Int,
    val plaintext: ByteArray,
    val compressed: Boolean,
)

class DecodedChunk(
    val transferId: Int,
    val chunkIndex: Int,
    val compressed: Boolean,
    val plaintext: ByteArray,
)

fun encodeChunkFrame(key: ByteArray, direction: Int, chunk: EncodedChunk): ByteArray {
    val nonce = deriveChunkNonce(direction, chunk.transferId, chunk.chunkIndex)
    val ciphertext = aeadEncrypt(key, nonce, chunk.plaintext)

    val frame = ByteArray(CHUNK_HEADER_LEN + ciphertext.size)
    frame[0] = FrameType.CHUNK
    u32be(chunk.transferId).copyInto(frame, 1)
    u32be(chunk.chunkIndex).copyInto(frame, 5)
    frame[9] = (if (chunk.compressed) FLAG_COMPRESSED else 0).toByte()
    ciphertext.copyInto(frame, CHUNK_HEADER_LEN)
    return frame
}

fun decodeChunkFrame(key: ByteArray, direction: Int, frame: ByteArray): DecodedChunk {
    if (frame.size < CHUNK_HEADER_LEN) throw IllegalArgumentException("frame shorter than header")
    if (frame[0] != FrameType.CHUNK) throw IllegalArgumentException("unknown frame type ${frame[0]}")
    val transferId = readU32be(frame, 1)
    val chunkIndex = readU32be(frame, 5)
    val compressed = (frame[9].toInt() and FLAG_COMPRESSED) != 0

    val nonce = deriveChunkNonce(direction, transferId, chunkIndex)
    val plaintext = aeadDecrypt(key, nonce, frame.copyOfRange(CHUNK_HEADER_LEN, frame.size))
    return DecodedChunk(transferId, chunkIndex, compressed, plaintext)
}

class DecodedCtl(val counter: Long, val plaintext: ByteArray)

/**
 * protocol.md §5.3: control messages are encrypted with the same session
 * keys as chunks. Signal relays the SDP that sets up DTLS, so DTLS alone
 * does not protect this channel from the relay — without this the manifest
 * (file name, size, chunk hashes) would be readable and forgeable by it.
 */
fun encodeCtlFrame(key: ByteArray, direction: Int, counter: Long, plaintext: ByteArray): ByteArray {
    val ciphertext = aeadEncrypt(key, deriveCtlNonce(direction, counter), plaintext)
    val frame = ByteArray(CTL_HEADER_LEN + ciphertext.size)
    frame[0] = FrameType.CTL
    u64be(counter).copyInto(frame, 1)
    ciphertext.copyInto(frame, CTL_HEADER_LEN)
    return frame
}

fun decodeCtlFrame(key: ByteArray, direction: Int, frame: ByteArray): DecodedCtl {
    if (frame.size < CTL_HEADER_LEN) throw IllegalArgumentException("ctl frame shorter than header")
    if (frame[0] != FrameType.CTL) throw IllegalArgumentException("not a ctl frame: type ${frame[0]}")
    val counter = readU64be(frame, 1)
    val plaintext = aeadDecrypt(key, deriveCtlNonce(direction, counter), frame.copyOfRange(CTL_HEADER_LEN, frame.size))
    return DecodedCtl(counter, plaintext)
}
