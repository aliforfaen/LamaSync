package app.lamasync.companion.ui

import android.app.Application
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.RegistrationStoreImpl
import app.lamasync.companion.data.WebGrant
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-296 stage-1 correction R5 — share/drop intents while UNPAIRED or with
 * LOST credential material must land on a renderable onboarding/error state
 * (the Uploads screen mounts it) instead of crashing with a null assertion
 * or showing an empty app surface. Cold-start and warm (already-open)
 * intents both funnel through acceptShare, so both shapes are exercised
 * here through the REAL UploadsViewModel over the real stores/vault.
 */
@RunWith(AndroidJUnit4::class)
class UploadIntakePairingStateInstrumentedTest {

    private lateinit var app: Application

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        // Isolated starting state: no registration, no credentials.
        RegistrationStoreImpl(app).clear()
        KeystoreCredentialVault(app).clear()
    }

    @After
    fun tearDown() {
        RegistrationStoreImpl(app).clear()
        KeystoreCredentialVault(app).clear()
    }

    private fun shareUri(): Uri = Uri.parse("content://authority/shared-notes.pdf")

    @Test
    fun unpairedShareBlocksIntakeRenderablyAndNeverQueues() {
        val vm = UploadsViewModel(app)
        vm.initialize()
        vm.acceptShare(listOf(shareUri()), 0)

        val state = vm.ui.value
        // The Uploads screen renders the onboarding surface from this block.
        assertEquals(UploadsViewModel.IntakeBlock.UNPAIRED, state.intakeBlock)
        assertFalse("no share is queued while unpaired", state.pendingShare != null)
        assertTrue("an explicit pairing message exists", state.message.orEmpty().contains("Pair"))
        // No crash reached here — the previous `vault.nativeToken()!!` bug
        // would have thrown a null assertion in this exact flow.
    }

    @Test
    fun warmSecondShareWhileUnpairedStaysStable() {
        val vm = UploadsViewModel(app)
        vm.initialize()
        // First intent (cold) ...
        vm.acceptShare(listOf(shareUri()), 0)
        // ... then a SECOND intent while the app is already open (warm):
        // the block stays renderable and the app state stays coherent.
        vm.acceptShare(listOf(shareUri(), Uri.parse("content://authority/b.png")), 0)
        val state = vm.ui.value
        assertEquals(UploadsViewModel.IntakeBlock.UNPAIRED, state.intakeBlock)
        assertTrue(state.message.orEmpty().contains("Pair"))
    }

    @Test
    fun credentialLostShareIsRenderableWithoutNullAssertion() {
        // Registration metadata survived (delete/restore or Keystore loss),
        // but the secret material is gone — intake must NOT force-unwrap.
        RegistrationStoreImpl(app).save(
            Registration(
                origin = "https://fleet.example.com",
                hostId = "mob-credlost-1",
                displayName = "Credential test",
                enrolledAtEpochMillis = 1L,
            ),
        )
        KeystoreCredentialVault(app).clear()
        assertEquals(null, KeystoreCredentialVault(app).nativeToken())

        val vm = UploadsViewModel(app)
        vm.initialize()
        vm.acceptShare(listOf(shareUri()), 0)

        val state = vm.ui.value
        assertEquals(UploadsViewModel.IntakeBlock.CREDENTIAL_LOST, state.intakeBlock)
        assertTrue(state.message.orEmpty().contains("credential"))
        assertTrue("intake bus calms down", !state.busy)
    }

    @Test
    fun pairingBlocksClearWhenAPairedIntakeSucceeds() {
        // A paired (registration + credential) device never sees the block.
        RegistrationStoreImpl(app).save(
            Registration(
                origin = "https://fleet.example.com",
                hostId = "mob-paired-1",
                displayName = "Paired",
                enrolledAtEpochMillis = 1L,
            ),
        )
        KeystoreCredentialVault(app).saveCredentials(
            NativeToken.of("native-token"),
            WebGrant.of("web-grant"),
        )
        // Unpaired first: the block is set...
        val vm = UploadsViewModel(app)
        vm.initialize()
        RegistrationStoreImpl(app).clear()
        vm.acceptShare(listOf(shareUri()), 0)
        assertEquals(UploadsViewModel.IntakeBlock.UNPAIRED, vm.ui.value.intakeBlock)

        // ...then the device pairs and shares again: the block clears.
        RegistrationStoreImpl(app).save(
            Registration(
                origin = "https://fleet.example.com",
                hostId = "mob-paired-1",
                displayName = "Paired",
                enrolledAtEpochMillis = 1L,
            ),
        )
        vm.acceptShare(listOf(shareUri()), 0)
        assertEquals(null, vm.ui.value.intakeBlock)
    }
}