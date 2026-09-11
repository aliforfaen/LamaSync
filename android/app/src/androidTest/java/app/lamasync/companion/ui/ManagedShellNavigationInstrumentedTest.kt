package app.lamasync.companion.ui

import android.app.Application
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.RegistrationStoreImpl
import app.lamasync.companion.data.ShellPreferences
import app.lamasync.companion.data.ShellPreferencesStore
import app.lamasync.companion.data.WebGrant
import app.lamasync.companion.ui.theme.LamaSyncTheme
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-329 — the PAIRED shell actually renders and navigates.
 *
 * This is the one path the unit tests cannot reach and that the HTTPS vertical
 * only covers when a live server is configured: a device that already holds a
 * registration walks `SessionViewModel.initialize()` →
 * `screen = Screen.MANAGE` → `ManagedShell`, and everything new lives there
 * (the top app bar, the nav graph, the WebView host).
 *
 * The pairing is seeded through the REAL stores, so no ViewModel seam or fake
 * repository is involved. The enrolled origin is deliberately unreachable, so
 * the assertions target state that resolves synchronously:
 * `webSessionConnected` is derived from the real cookie jar (no cookie on a
 * clean device ⇒ the expired state), and the check-in merely warns.
 *
 * A deliberate pairing destructive test: `@Before` clears the vault and
 * registration, so it must never be run against a real phone.
 */
@RunWith(AndroidJUnit4::class)
class ManagedShellNavigationInstrumentedTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val app = ApplicationProvider.getApplicationContext<Application>()

    private companion object {
        const val ORIGIN = "https://fleet.example.com"
    }

    @Before
    fun seedACompletedPairing() {
        KeystoreCredentialVault(app).clear()
        RegistrationStoreImpl(app).clear()
        ShellPreferencesStore(app).save(ShellPreferences())

        RegistrationStoreImpl(app).save(
            Registration(
                origin = ORIGIN,
                hostId = "mob-shell-1",
                displayName = "Shell test",
                enrolledAtEpochMillis = 1L,
            ),
        )
        KeystoreCredentialVault(app).saveCredentials(
            NativeToken.of("native-token"),
            WebGrant.of("web-grant"),
        )
    }

    @After
    fun tearDown() {
        KeystoreCredentialVault(app).clear()
        RegistrationStoreImpl(app).clear()
        ShellPreferencesStore(app).save(ShellPreferences())
    }

    private fun renderShell() {
        val session = SessionViewModel(app)
        session.initialize()
        val uploads = UploadsViewModel(app).also { it.initialize() }
        val autoProtect = AutoProtectViewModel(app).also { it.initialize() }
        val shell = ShellPreferencesViewModel(app).also { it.initialize() }

        composeRule.setContent {
            LamaSyncTheme(preferences = ShellPreferences()) {
                LamaSyncApp(
                    sessionViewModel = session,
                    uploadsViewModel = uploads,
                    autoProtectViewModel = autoProtect,
                    shellViewModel = shell,
                    openDocumentPicker = {},
                )
            }
        }
        composeRule.waitForIdle()
    }

    @Test
    fun aPairedDeviceLandsInTheManagedShellWithItsConnectionState() {
        renderShell()

        // The top app bar identifies the host...
        composeRule.onNodeWithText("LamaSync", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("fleet.example.com", substring = true).assertIsDisplayed()

        // ...and reports the connection state in WORDS, not just as a dot.
        // No session cookie exists on a clean device, so this is the expired
        // state, which must also offer the way out of it.
        composeRule.onNodeWithText("Web session expired").assertIsDisplayed()
        composeRule.onNodeWithText("Reconnect").assertIsDisplayed()

        // The reload affordance is part of the shell contract.
        composeRule.onNodeWithContentDescription("Reload the management UI").assertIsDisplayed()
    }

    @Test
    fun theOverflowMenuReachesASettingsDestinationAndBackReturnsToManage() {
        renderShell()

        composeRule.onNodeWithContentDescription("More actions").performClick()
        composeRule.onNodeWithText("Settings").performClick()
        composeRule.waitForIdle()

        // The native Settings destination is now the app bar's subject, so the
        // up affordance is present and the management title is not.
        composeRule.onNodeWithText("Match my wallpaper").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Back").assertIsDisplayed()

        composeRule.onNodeWithContentDescription("Back").performClick()
        composeRule.waitForIdle()

        // Back returns to the management surface rather than leaving the shell.
        composeRule.onNodeWithText("LamaSync", substring = true).assertIsDisplayed()
        composeRule.onNodeWithContentDescription("More actions").assertIsDisplayed()
    }

    @Test
    fun theOverflowMenuReachesUploadsAndCameraProtection() {
        renderShell()

        composeRule.onNodeWithContentDescription("More actions").performClick()
        composeRule.onNodeWithText("Uploads").performClick()
        composeRule.waitForIdle()
        // Uploads renders the paired device identity once its own ViewModel has
        // initialised.
        composeRule.onNodeWithText("mob-shell-1", substring = true).assertIsDisplayed()

        // Back out, then take the other overflow entry.
        composeRule.onNodeWithContentDescription("Back").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription("More actions").performClick()
        composeRule.onNodeWithText("Camera protection").performClick()
        composeRule.waitForIdle()
        // The screen's own title lives in the app bar now; its body opens with
        // the explanatory line instead.
        composeRule
            .onNodeWithText("Camera media back up automatically when conditions allow.")
            .assertIsDisplayed()
    }
}
