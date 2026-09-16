package com.depot.app.storage

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.depot.app.crypto.signDetached
import com.depot.app.crypto.verifyDetached
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StorageTest {

    /**
     * Redirects SharedPreferences to test-only files.
     *
     * These tests run against the installed app, so using its real storage
     * means a test run wipes whatever the user actually paired — the
     * identity key lives in a different file and survives, so the next
     * reconnect fails at "not a known device" with a credential that still
     * verifies. Isolating here rather than threading a name through
     * DeviceStore keeps the production API honest.
     */
    private val context: Context = object : ContextWrapper(
        InstrumentationRegistry.getInstrumentation().targetContext,
    ) {
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
            super.getSharedPreferences("test.$name", mode)
    }

    @Before
    fun clearDevices() {
        context.getSharedPreferences("depot.devices", 0).edit().clear().commit()
    }

    @Test
    fun identityIsStableAcrossLoadsAndActuallyUsable() {
        val first = IdentityStore.loadOrCreate(context)
        val second = IdentityStore.loadOrCreate(context)

        // A regenerated identity would silently invalidate every issued
        // credential, so stability here is what keeps pairings alive.
        assertEquals(first.publicKey.toList(), second.publicKey.toList())
        assertEquals(first.privateKey.toList(), second.privateKey.toList())

        // Round-tripping through AndroidKeyStore must not corrupt the key.
        val message = "reconnect transcript".toByteArray()
        assertTrue(verifyDetached(signDetached(message, second.privateKey), message, first.publicKey))
    }

    @Test
    fun identityIsNotStoredInPlaintext() {
        IdentityStore.loadOrCreate(context)
        val blob = context.getSharedPreferences("depot.identity", 0)
            .getString("depot.identity.blob", null)!!
        // The stored form is base64(nonce ‖ AES-GCM ciphertext); if the raw
        // JSON were written instead, the key names would be visible.
        assertTrue(!blob.contains("privateKey"))
        assertTrue(!blob.contains("publicKey"))
    }

    @Test
    fun savingTheSameClientTwiceUpdatesRatherThanDuplicates() {
        val now = System.currentTimeMillis()
        DeviceStore.save(context, DeviceRecord("client-a", "First", now, now, false))
        DeviceStore.save(context, DeviceRecord("client-a", "Renamed", now, now + 1, false))

        val devices = DeviceStore.list(context)
        assertEquals(1, devices.size)
        assertEquals("Renamed", devices[0].label)
    }

    @Test
    fun revokeSurvivesAReloadAndLeavesOtherDevicesAlone() {
        val now = System.currentTimeMillis()
        DeviceStore.save(context, DeviceRecord("client-a", "A", now, now, false))
        DeviceStore.save(context, DeviceRecord("client-b", "B", now, now, false))

        DeviceStore.revoke(context, "client-a")

        // Revocation is only meaningful if it is still true after a
        // restart — §6 relies on the Depot refusing the handshake later.
        assertTrue(DeviceStore.get(context, "client-a")!!.revoked)
        assertTrue(!DeviceStore.get(context, "client-b")!!.revoked)
    }

    @Test
    fun touchUpdatesLastSeenWithoutClearingRevocation() {
        // Backdated so the comparison cannot land in the same millisecond.
        val stale = System.currentTimeMillis() - 10_000
        DeviceStore.save(context, DeviceRecord("client-a", "A", stale, stale, true))
        DeviceStore.touch(context, "client-a")

        val device = DeviceStore.get(context, "client-a")!!
        assertTrue(device.lastSeenAt > stale)
        // Seeing a revoked device reconnect must not un-revoke it.
        assertTrue(device.revoked)
    }
}
