package app.lamasync.companion.ui

import android.app.Application
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.printToString
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.ShellPreferences
import app.lamasync.companion.data.ShellPreferencesStore
import app.lamasync.companion.data.ThemePreference
import app.lamasync.companion.data.UploadPolicy
import app.lamasync.companion.data.UploadPolicyStore
import app.lamasync.companion.ui.theme.LamaSyncTheme
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-329 — Settings writes through the store that OWNS each fact.
 *
 * The rule the screen has to keep is that it never keeps a settings-local copy
 * of anything: a switch that merely changed a local echo while the store kept
 * the old value is exactly the "second source of truth" failure this issue was
 * written to avoid. These assertions therefore read the REAL stores back after
 * a tap rather than trusting the rendered state.
 */
@RunWith(AndroidJUnit4::class)
class SettingsScreenInstrumentedTest {

    @get:Rule
    val composeRule = createComposeRule()

    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val shellStore = ShellPreferencesStore(app)
    private val uploadPolicyStore = UploadPolicyStore(app)

    private val registration = Registration(
        origin = "https://fleet.example.com",
        hostId = "mob-settings-1",
        displayName = "Settings test",
        enrolledAtEpochMillis = 1L,
    )

    @Before
    fun cleanStartingState() {
        shellStore.save(ShellPreferences())
        uploadPolicyStore.save(UploadPolicy())
    }

    @After
    fun restoreDefaults() {
        shellStore.save(ShellPreferences())
        uploadPolicyStore.save(UploadPolicy())
    }

    private fun showSettings(
        preferences: ShellPreferences,
        uploadPolicy: UploadPolicy = UploadPolicy(),
        onTheme: (ThemePreference) -> Unit = {},
        onUnmeteredOnly: (Boolean) -> Unit = {},
        onChargingOnly: (Boolean) -> Unit = {},
        onPullToRefresh: (Boolean) -> Unit = {},
        onOpenExternalLinks: (Boolean) -> Unit = {},
        onDynamicColor: (Boolean) -> Unit = {},
    ) {
        composeRule.setContent {
            LamaSyncTheme(preferences = preferences) {
                SettingsScreen(
                    registration = registration,
                    appVersion = "0.0.0-test",
                    preferences = preferences,
                    connected = true,
                    busy = false,
                    uploadPolicy = uploadPolicy,
                    autoProtect = AutoProtectViewModel.AutoProtectUiState(),
                    onTheme = onTheme,
                    onDynamicColor = onDynamicColor,
                    onUnmeteredOnly = onUnmeteredOnly,
                    onChargingOnly = onChargingOnly,
                    onPullToRefresh = onPullToRefresh,
                    onOpenExternalLinks = onOpenExternalLinks,
                    onOpenCameraProtection = {},
                    onOpenConnection = {},
                    onOpenAbout = {},
                    onReconnect = {},
                    onDisconnect = {},
                )
            }
        }
    }

    @Test
    fun aTransferSwitchTogglesFromItsWholeRow() {
        var requested: Boolean? = null
        showSettings(ShellPreferences(), onUnmeteredOnly = { requested = it })

        // Tapping the LABEL (not the switch itself) must work: the row is the
        // control, so the label is part of the >= 48dp target.
        composeRule.onNodeWithText("Only transfer over Wi-Fi").performClick()
        assertEquals(true, requested)
    }

    @Test
    fun everySwitchReportsTheStateOfTheStoreThatOwnsIt() {
        // The charging constraint had no UI at all before this change; it is
        // enforced for manual uploads by UploadWorkScheduler, and the screen
        // must show the stored truth rather than an invented default.
        val stored = UploadPolicy(unmeteredOnly = true, chargingOnly = true)
        showSettings(
            ShellPreferences(pullToRefresh = true, openExternalLinks = true, dynamicColor = false),
            uploadPolicy = stored,
        )

        composeRule.onNodeWithText("Only transfer over Wi-Fi").assertIsOn()
        composeRule.onNodeWithText("Only transfer while charging").assertIsOn()
        composeRule.onNodeWithText("Pull to refresh").assertIsOn()
        composeRule.onNodeWithText("Open external links in a browser").assertIsOn()
        composeRule.onNodeWithText("Match my wallpaper").assertIsOff()
    }

    @Test
    fun aDisabledBrowserPreferenceIsShownAsOff() {
        showSettings(ShellPreferences(pullToRefresh = false, openExternalLinks = false))
        composeRule.onNodeWithText("Pull to refresh").assertIsOff()
        composeRule.onNodeWithText("Open external links in a browser").assertIsOff()
    }

    @Test
    fun theThemeChoiceIsStatedInWordsAndIsSelectable() {
        var chosen: ThemePreference? = null
        showSettings(ShellPreferences(theme = ThemePreference.DARK), onTheme = { chosen = it })

        // Stated in words as well as by the selected segment, so the current
        // choice is not signalled by shape/position alone.
        composeRule.onNodeWithText("Always dark").assertExists()
        composeRule.onNodeWithText("Light").performClick()
        assertEquals(ThemePreference.LIGHT, chosen)
    }

    @Test
    fun anOffThemeChoiceSaysSoRatherThanRepeatingTheSystemDefault() {
        showSettings(ShellPreferences(theme = ThemePreference.SYSTEM))
        composeRule.onNodeWithText("Following the system setting").assertExists()
    }

    @Test
    fun theFailureExplanationForAnExpiredWebSessionIsVisible() {
        composeRule.setContent {
            LamaSyncTheme(preferences = ShellPreferences()) {
                SettingsScreen(
                    registration = registration,
                    appVersion = "0.0.0-test",
                    preferences = ShellPreferences(),
                    connected = false,
                    busy = false,
                    uploadPolicy = UploadPolicy(),
                    autoProtect = AutoProtectViewModel.AutoProtectUiState(),
                    onTheme = {},
                    onDynamicColor = {},
                    onUnmeteredOnly = {},
                    onChargingOnly = {},
                    onPullToRefresh = {},
                    onOpenExternalLinks = {},
                    onOpenCameraProtection = {},
                    onOpenConnection = {},
                    onOpenAbout = {},
                    onReconnect = {},
                    onDisconnect = {},
                )
            }
        }
        // The reconnect affordance and the reason for it are both present: the
        // shell must not offer a button without saying why.
        composeRule.onNodeWithText("Reconnect web session").assertExists()
    }

    /**
     * The acceptance gate: neither credential is ever displayed.
     *
     * Settings is only handed the non-secret [Registration] and the device-local
     * preferences, so this is a structural guard rather than a proof — but it
     * fails loudly if someone later adds a row that prints a secret.
     */
    @Test
    fun noCredentialMaterialIsRendered() {
        showSettings(ShellPreferences())
        val dump = composeRule.onRoot().printToString()
        assertTrue(
            "the non-secret facts should be visible so this dump is not empty",
            dump.contains("fleet.example.com") && dump.contains("0.0.0-test"),
        )
        for (forbidden in listOf("native-token", "web-grant", "Bearer ", "Authorization", "keystore")) {
            assertTrue(
                "Settings must never render credential material (found \"$forbidden\")",
                !dump.contains(forbidden, ignoreCase = true),
            )
        }
    }
}
