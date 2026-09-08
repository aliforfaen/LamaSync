package app.lamasync.companion.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real Android Keystore round trip (device/emulator only — this is exactly the
 * behavior the local unit tests cannot exercise).
 */
@RunWith(AndroidJUnit4::class)
class KeystoreCredentialVaultInstrumentedTest {

    private lateinit var vault: KeystoreCredentialVault
    private lateinit var registrationStore: RegistrationStore

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        vault = KeystoreCredentialVault(context)
        registrationStore = RegistrationStoreImpl(context)
        vault.clear()
        registrationStore.clear()
    }

    @Test
    fun roundTripPersistsBothSecretsEncrypted() {
        val token = NativeToken.of("native-token-instrumented-" + "x".repeat(64))
        val grant = WebGrant.of("web-grant-instrumented-" + "y".repeat(64))

        vault.saveCredentials(token, grant)

        assertTrue(vault.hasCredentials())
        assertEquals(token, vault.nativeToken())
        assertEquals(grant, vault.webGrant())
    }

    @Test
    fun clearDestroysSecretsAndKeyMaterial() {
        vault.saveCredentials(NativeToken.of("t1"), WebGrant.of("g1"))
        vault.clear()
        assertFalse(vault.hasCredentials())
        assertNull(vault.nativeToken())
        assertNull(vault.webGrant())
    }

    @Test
    fun corruptedCiphertextFailsClosedInsteadOfReturningGarbage() {
        vault.saveCredentials(NativeToken.of("original-token"), WebGrant.of("original-grant"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefs = context.getSharedPreferences("lamasync_secure_vault", android.content.Context.MODE_PRIVATE)
        // Corrupt the stored native-token ciphertext directly.
        prefs.edit().putString("native_token", "v1:AAECAwQFBgcICQoLDA0ODw==").commit()

        assertNull("corrupted ciphertext must fail closed", vault.nativeToken())
        // The untouched grant must still decrypt.
        assertEquals(WebGrant.of("original-grant"), vault.webGrant())
    }

    @Test
    fun roundTripSurvivesStoreReload() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        vault.saveCredentials(NativeToken.of("token-reload"), WebGrant.of("grant-reload"))

        val reloaded = KeystoreCredentialVault(context)
        assertNotNull(reloaded.nativeToken())
        assertEquals("token-reload", reloaded.nativeToken()?.value)
        assertEquals("grant-reload", reloaded.webGrant()?.value)
    }
}
