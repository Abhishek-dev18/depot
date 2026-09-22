package com.depot.app.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.depot.app.crypto.KeyPair
import com.depot.app.crypto.fromBase64
import com.depot.app.crypto.generateIdentityKeyPair
import com.depot.app.crypto.toBase64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * DepotIdentity (protocol.md §2.1) — the long-term Ed25519 keypair that is
 * the root of this Depot's authority. Losing it means every paired Client
 * must re-pair; leaking it means an attacker can impersonate the Depot.
 *
 * libsodium keys are raw bytes, so they cannot live inside AndroidKeyStore
 * directly. Instead the keystore holds a hardware-backed AES-GCM key that
 * never leaves secure hardware, and that key encrypts the identity blob
 * stored in SharedPreferences. An attacker with the prefs file alone gets
 * ciphertext.
 *
 * Deliberately not `setUserAuthenticationRequired`: a Depot must be able to
 * answer a reconnection while the phone is locked in a pocket.
 */
object IdentityStore {

    private const val PREFS = "depot.identity"
    private const val KEY_IDENTITY = "depot.identity.blob"
    private const val KEYSTORE_ALIAS = "depot.identity.wrapping"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    private const val NONCE_BYTES = 12

    // Synchronized: pairing and the reconnect listener both call this, and
    // on a first launch two callers each finding nothing stored would mint
    // two identities — one of them handed to a Client and then overwritten.
    @Synchronized
    fun loadOrCreate(context: Context): KeyPair {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY_IDENTITY, null)?.let { stored ->
            val restored = runCatching { decode(decrypt(stored)) }.getOrNull()
            if (restored != null) return restored
            // Stored, but no longer readable: the wrapping key is gone. It
            // lives in the keystore and never leaves this phone, so this is
            // a blob copied from another one (a restore, a device transfer)
            // or a keystore that was reset. The identity it held cannot be
            // recovered by anyone, and refusing to start would fail here on
            // every launch for ever. A new identity is the only way on;
            // every Client has to pair again, and the device list — records
            // of Clients whose credentials the new key cannot vouch for — is
            // cleared rather than left showing pairings that cannot work.
            DeviceStore.clear(context)
        }
        val created = generateIdentityKeyPair()
        // commit(), not apply(): this key is about to be put in front of a
        // Client, and must not be lost to a process death a moment later.
        prefs.edit().putString(KEY_IDENTITY, encrypt(encode(created))).commit()
        return created
    }

    private fun encode(kp: KeyPair): String = JSONObject()
        .put("publicKey", kp.publicKey.toBase64())
        .put("privateKey", kp.privateKey.toBase64())
        .toString()

    private fun decode(json: String): KeyPair {
        val o = JSONObject(json)
        return KeyPair(o.getString("publicKey").fromBase64(), o.getString("privateKey").fromBase64())
    }

    private fun wrappingKey(): SecretKey {
        val keystore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keystore.getEntry(KEYSTORE_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEYSTORE_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    /** Stored as base64(nonce ‖ ciphertext) — GCM needs a fresh nonce per encryption. */
    private fun encrypt(plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return (cipher.iv + ciphertext).toBase64()
    }

    private fun decrypt(stored: String): String {
        val bytes = stored.fromBase64()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            wrappingKey(),
            GCMParameterSpec(GCM_TAG_BITS, bytes, 0, NONCE_BYTES),
        )
        return String(cipher.doFinal(bytes, NONCE_BYTES, bytes.size - NONCE_BYTES), Charsets.UTF_8)
    }
}
