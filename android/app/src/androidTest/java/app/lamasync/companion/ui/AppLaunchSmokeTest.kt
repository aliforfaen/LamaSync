package app.lamasync.companion.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.RegistrationStoreImpl
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real-app smoke test: launches the actual activity on a clean device state
 * and asserts the onboarding surface appears. (This is not a parser mirror —
 * it exercises activity + ViewModel + repository startup wiring.)
 */
@RunWith(AndroidJUnit4::class)
class AppLaunchSmokeTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Before
    fun resetDeviceState() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        KeystoreCredentialVault(context).clear()
        RegistrationStoreImpl(context).clear()
    }

    @Test
    fun cleanInstallShowsEnrollmentEntryPoint() {
        composeRule.onNodeWithText("LamaSync Companion").assertIsDisplayed()
        composeRule.onNodeWithText("Scan enrollment QR code").assertIsDisplayed()
    }
}
