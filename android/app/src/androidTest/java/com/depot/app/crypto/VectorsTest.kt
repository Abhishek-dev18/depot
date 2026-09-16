package com.depot.app.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Asserts this implementation against docs/vectors/test-vectors.json, the
 * same file web/src/crypto/vectors.test.ts checks itself against.
 *
 * These run on a device because lazysodium-android loads a native library;
 * a plain JVM unit test has no .so to bind to.
 *
 * A failure here means Android and web would derive different keys, and
 * pairing would fail in the field as an unexplained SAS mismatch. Fix the
 * implementation — only regenerate the vectors when the wire format is
 * deliberately changing, and then update both sides together.
 */
@RunWith(AndroidJUnit4::class)
class VectorsTest {

    private val vectors: JSONObject by lazy {
        val json = InstrumentationRegistry.getInstrumentation().context.assets
            .open("test-vectors.json")
            .bufferedReader()
            .use { it.readText() }
        JSONObject(json)
    }

    @Test
    fun lengthPrefixedTranscriptMatches() {
        val v = vectors.getJSONObject("transcript")
        val fields = v.getJSONArray("fields")
        val parsed = (0 until fields.length()).map { fields.getString(it).fromHex() }
        assertEquals(v.getString("expected"), buildTranscript(parsed).toHex())
    }

    @Test
    fun pairingDerivationMatches() {
        val v = vectors.getJSONObject("pairing")

        // Public keys must come back out of the fixed private scalars.
        assertEquals(v.getString("clientEkPub"), scalarMultBase(v.getString("clientEkPriv").fromHex()).toHex())
        assertEquals(v.getString("depotEkPub"), scalarMultBase(v.getString("depotEkPriv").fromHex()).toHex())

        val clientIk = identityKeyPairFromSeed(v.getString("clientIkSeed").fromHex())
        val depotIk = identityKeyPairFromSeed(v.getString("depotIkSeed").fromHex())
        assertEquals(v.getString("clientIkPub"), clientIk.publicKey.toHex())
        assertEquals(v.getString("depotIkPub"), depotIk.publicKey.toHex())

        val transcript = pairingTranscript(
            PairingTranscriptInput(
                version = v.getInt("version"),
                sessionId = v.getString("sessionId").fromHex(),
                clientEk = v.getString("clientEkPub").fromHex(),
                clientIk = clientIk.publicKey,
                depotEk = v.getString("depotEkPub").fromHex(),
                depotIk = depotIk.publicKey,
                nonce = v.getString("nonce").fromHex(),
            ),
        )
        assertEquals(v.getString("transcript"), transcript.toHex())

        val shared = ecdh(v.getString("clientEkPriv").fromHex(), v.getString("depotEkPub").fromHex())
        assertEquals(v.getString("sharedSecret"), shared.toHex())

        // Both sides of the DH must agree, or pairing silently diverges.
        val sharedOther = ecdh(v.getString("depotEkPriv").fromHex(), v.getString("clientEkPub").fromHex())
        assertEquals(shared.toHex(), sharedOther.toHex())

        val keys = deriveKeys(shared, transcript)
        assertEquals(v.getString("master"), keys.master.toHex())
        assertEquals(v.getString("kC2D"), keys.kC2D.toHex())
        assertEquals(v.getString("kD2C"), keys.kD2C.toHex())
        assertEquals(v.getString("sasSeed"), keys.sasSeed.toHex())
        assertEquals(v.getString("sas"), computeSAS(keys.sasSeed))
    }

    @Test
    fun credentialSigningMatches() {
        val v = vectors.getJSONObject("credential")
        val depotIk = identityKeyPairFromSeed(vectors.getJSONObject("pairing").getString("depotIkSeed").fromHex())

        val cred = Credential(
            depotId = v.getString("depotId"),
            clientId = v.getString("clientId"),
            issuedAt = v.getLong("issuedAt"),
            expiresAt = v.getLong("expiresAt"),
            sig = v.getString("sig"),
        )
        // Ed25519 is deterministic, so the signature itself is a known answer.
        assertTrue(verifyCredential(cred, depotIk.publicKey, now = cred.issuedAt))
        assertEquals(v.getString("depotId"), depotIk.publicKey.toBase64())

        // Expiry and tampering must both be rejected.
        assertTrue(!verifyCredential(cred, depotIk.publicKey, now = cred.expiresAt))
        assertTrue(!verifyCredential(cred.copy(clientId = "someone-else"), depotIk.publicKey, now = cred.issuedAt))
    }

    @Test
    fun reconnectSignatureMatches() {
        val p = vectors.getJSONObject("pairing")
        val v = vectors.getJSONObject("reconnect")
        val clientIk = identityKeyPairFromSeed(p.getString("clientIkSeed").fromHex())

        val transcript = reconnectTranscript(
            p.getString("clientEkPub").fromHex(),
            p.getString("depotEkPub").fromHex(),
            v.getString("challengeNonce").fromHex(),
        )
        assertEquals(v.getString("transcript"), transcript.toHex())
        assertEquals(v.getString("sig"), signReconnectResponse(clientIk.privateKey, transcript))
        assertTrue(verifyReconnectResponse(v.getString("sig"), transcript, clientIk.publicKey))
    }

    @Test
    fun derivedNoncesMatchAndStayDisjoint() {
        val v = vectors.getJSONObject("nonces")
        assertEquals(
            v.getString("chunk_d2c_t7_i3"),
            deriveChunkNonce(Direction.DEPOT_TO_CLIENT, 7, 3).toHex(),
        )
        assertEquals(
            v.getString("chunk_c2d_t0_i0"),
            deriveChunkNonce(Direction.CLIENT_TO_DEPOT, 0, 0).toHex(),
        )
        assertEquals(v.getString("ctl_c2d_counter2"), deriveCtlNonce(Direction.CLIENT_TO_DEPOT, 2).toHex())
        assertEquals(v.getString("ctl_d2c_counter0"), deriveCtlNonce(Direction.DEPOT_TO_CLIENT, 0).toHex())

        // Both frame kinds share one directional key, so the nonce spaces
        // overlapping would mean catastrophic keystream reuse.
        val seen = mutableSetOf<String>()
        for (direction in listOf(Direction.CLIENT_TO_DEPOT, Direction.DEPOT_TO_CLIENT)) {
            for (i in 0 until 64) {
                seen.add(deriveCtlNonce(direction, i.toLong()).toHex())
                seen.add(deriveChunkNonce(direction, 0, i).toHex())
                seen.add(deriveChunkNonce(direction, i, 0).toHex())
            }
        }
        assertEquals(2 * (64 + 64 + 64 - 1), seen.size)
    }

    @Test
    fun encryptedFramesMatchByteForByte() {
        val f = vectors.getJSONObject("frames")

        val c = f.getJSONObject("chunk")
        val chunkFrame = encodeChunkFrame(
            c.getString("key").fromHex(),
            Direction.DEPOT_TO_CLIENT,
            EncodedChunk(
                transferId = c.getInt("transferId"),
                chunkIndex = c.getInt("chunkIndex"),
                plaintext = c.getString("plaintext").fromHex(),
                compressed = c.getBoolean("compressed"),
            ),
        )
        assertEquals(c.getString("frame"), chunkFrame.toHex())

        val decodedChunk = decodeChunkFrame(c.getString("key").fromHex(), Direction.DEPOT_TO_CLIENT, chunkFrame)
        assertEquals(c.getString("plaintext"), decodedChunk.plaintext.toHex())

        val t = f.getJSONObject("ctl")
        val ctlFrame = encodeCtlFrame(
            t.getString("key").fromHex(),
            Direction.CLIENT_TO_DEPOT,
            t.getLong("counter"),
            t.getString("plaintext").fromHex(),
        )
        assertEquals(t.getString("frame"), ctlFrame.toHex())

        val decodedCtl = decodeCtlFrame(t.getString("key").fromHex(), Direction.CLIENT_TO_DEPOT, ctlFrame)
        assertEquals(t.getLong("counter"), decodedCtl.counter)
        assertEquals(t.getString("plaintextUtf8"), String(decodedCtl.plaintext, Charsets.UTF_8))
    }

    @Test
    fun base64RoundTripsWithoutPadding() {
        val v = vectors.getJSONObject("credential")
        // The web side strips '=' padding; these strings cross the wire
        // verbatim inside the QR payload, so the encoding must agree.
        val depotId = v.getString("depotId")
        assertTrue(!depotId.contains("="))
        assertEquals(depotId, depotId.fromBase64().toBase64())
    }
}
