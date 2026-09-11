package app.lamasync.companion.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.RegistrationStoreImpl
import app.lamasync.companion.data.ShellPreferences
import app.lamasync.companion.data.ShellPreferencesStore
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-329 — Android back stays deterministic on the surfaces this change
 * touched.
 *
 * The shell adds a back handler (WebView history first) and turns on
 * `android:enableOnBackInvokedCallback`. Both are easy to get wrong in a way
 * that silently swallows back: a handler left enabled with nothing to do, or a
 * predictive-back callback that never completes, leaves the user stuck.
 *
 * Emulator-only: `@Before` clears the vault and registration (as
 * [AppLaunchSmokeTest] already does), so it must never be run against a paired
 * phone.
 */
@RunWith(AndroidJUnit4::class)
class ShellBackBehaviorInstrumentedTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun resetDeviceState() {
        KeystoreCredentialVault(context).clear()
        RegistrationStoreImpl(context).clear()
        ShellPreferencesStore(context).save(ShellPreferences())
        // Re-derive the surface from the wiped state (the activity is created
        // by the rule before @Before runs).
        composeRule.activity.runOnUiThread {
            composeRule.activity.recreate()
        }
        composeRule.waitForIdle()
    }

    @Test
    fun backOnTheEnrollmentSurfaceIsNotSwallowed() {
        composeRule.onNodeWithText("Scan enrollment QR code").assertIsDisplayed()

        composeRule.activityRule.scenario.onActivity { activity ->
            activity.onBackPressedDispatcher.onBackPressed()
        }
        composeRule.waitForIdle()

        assertTrue(
            "an unpaired, un-enrolled device must be able to leave the app with back",
            composeRule.activity.isFinishing,
        )
    }
}
