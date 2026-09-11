package app.lamasync.companion.ui

import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.ShellPreferences
import app.lamasync.companion.data.ThemePreference
import app.lamasync.companion.data.UploadPolicy

/**
 * LAMA-329 — the native Settings screen.
 *
 * Ownership rule this screen obeys: **every switch writes through the store
 * that already owns that fact.** There is no settings-local copy of anything.
 *
 * | Group                | Owned by                                          |
 * | -------------------- | ------------------------------------------------- |
 * | Appearance           | `ShellPreferencesStore` (theme, dynamic colour)   |
 * | Transfers            | `UploadPolicyStore` (manual uploads)              |
 * | Camera protection    | `MediaProtectionStore` via `AutoProtectViewModel`  |
 * | Notifications        | the platform (no stored preference)               |
 * | Browser experience   | `ShellPreferencesStore`                           |
 * | Connection           | `RegistrationStore` + live session state          |
 * | About                | `RegistrationStore` + `BuildConfig`               |
 *
 * Two honest departures from the direction study, both deliberate:
 *
 *  1. **Transfers is labelled "Manual uploads".** The app has two independent
 *     transfer policies — this one for manual uploads (`UploadPolicyStore`)
 *     and a second for automatic camera protection
 *     (`AutoProtectSettings.unmeteredOnly` / `chargingOnly`). Presenting one
 *     unlabelled pair of switches would claim a device-wide policy the app does
 *     not have. The camera policy keeps its own controls on the Camera
 *     protection screen, which this group links to.
 *  2. **Notifications does not invent a preference.** There is no stored
 *     notification setting: the only real state is the platform's, so the row
 *     reports it and opens the system page that owns it.
 *
 * Neither screen ever displays a credential — see the acceptance gate.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    registration: Registration,
    appVersion: String,
    preferences: ShellPreferences,
    connected: Boolean,
    busy: Boolean,
    uploadPolicy: UploadPolicy,
    autoProtect: AutoProtectViewModel.AutoProtectUiState,
    onTheme: (ThemePreference) -> Unit,
    onDynamicColor: (Boolean) -> Unit,
    onUnmeteredOnly: (Boolean) -> Unit,
    onChargingOnly: (Boolean) -> Unit,
    onPullToRefresh: (Boolean) -> Unit,
    onOpenExternalLinks: (Boolean) -> Unit,
    onOpenCameraProtection: () -> Unit,
    onOpenConnection: () -> Unit,
    onOpenAbout: () -> Unit,
    onReconnect: () -> Unit,
    onDisconnect: () -> Unit,
) {
    val context = LocalContext.current

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            "Keep your files safe, in sync, and where you need them.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(6.dp))

        SettingsSection("Appearance") {
            ThemeChoiceRow(selected = preferences.theme, onSelect = onTheme)
            SettingsSwitchRow(
                title = "Match my wallpaper",
                subtitle = "Use the system accent colours instead of the LamaSync palette",
                checked = preferences.dynamicColor,
                onCheckedChange = onDynamicColor,
            )
        }

        SettingsSection("Transfers — manual uploads") {
            SettingsSwitchRow(
                title = "Only transfer over Wi-Fi",
                subtitle = "Wait for an unmetered network before uploading",
                checked = uploadPolicy.unmeteredOnly,
                onCheckedChange = onUnmeteredOnly,
            )
            SettingsSwitchRow(
                title = "Only transfer while charging",
                subtitle = "Pause uploads when the device is on battery",
                checked = uploadPolicy.chargingOnly,
                onCheckedChange = onChargingOnly,
            )
        }

        SettingsSection("Camera protection") {
            SettingsClickRow(
                title = "Back up photos and videos",
                subtitle = cameraProtectionSummary(autoProtect),
                onClick = onOpenCameraProtection,
            )
            Text(
                "Automatic camera protection has its own transfer conditions; open the screen above to change them.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        SettingsSection("Notifications") {
            val enabled = notificationsEnabled(context)
            SettingsClickRow(
                title = "Sync activity",
                subtitle = if (enabled) {
                    "Allowed by Android — transfer progress can be shown"
                } else {
                    "Blocked by Android — transfer progress will not be shown"
                },
                onClick = { openNotificationSettings(context) },
            )
        }

        SettingsSection("Browser experience") {
            SettingsSwitchRow(
                title = "Pull to refresh",
                subtitle = "Swipe down at the top of a page to reload the management UI",
                checked = preferences.pullToRefresh,
                onCheckedChange = onPullToRefresh,
            )
            SettingsSwitchRow(
                title = "Open external links in a browser",
                subtitle = "Off blocks cross-origin links instead of handing them to another app",
                checked = preferences.openExternalLinks,
                onCheckedChange = onOpenExternalLinks,
            )
        }

        SettingsSection("Connection") {
            SettingsClickRow(
                title = "Server",
                subtitle = if (connected) {
                    "${registration.origin} · web session active"
                } else {
                    "${registration.origin} · web session expired"
                },
                onClick = onOpenConnection,
            )
            if (!connected) {
                Button(
                    onClick = onReconnect,
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Reconnect web session")
                }
            }
        }

        SettingsSection("About") {
            SettingsClickRow(
                title = "App version",
                subtitle = appVersion,
                onClick = onOpenAbout,
            )
        }

        Spacer(Modifier.height(6.dp))
        DisconnectSection(
            busy = busy,
            onDisconnect = onDisconnect,
            explanation = "This revokes this device on the server and clears all local data. " +
                "Your files stay safe on your other devices.",
        )
        Text(
            "LamaSync · A quieter internet for your files.",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 12.dp),
        )
    }
}

/**
 * A one-line, honest summary of the automatic protection state — never a claim
 * the app cannot back up. Pure, so it is unit-tested without a device.
 */
internal fun cameraProtectionSummary(
    state: AutoProtectViewModel.AutoProtectUiState,
): String {
    if (!state.settings.anySourceEnabled) {
        return "Off — nothing is being protected automatically"
    }
    val enabled = buildList {
        if (state.settings.cameraPhotosEnabled) add("photos")
        if (state.settings.cameraVideosEnabled) add("videos")
        if (state.settings.screenshotsEnabled) add("screenshots")
    }.joinToString(", ")
    val pending = when {
        state.pendingAutoCount <= 0L -> ""
        state.pendingAutoCount == 1L -> " · 1 item pending"
        else -> " · ${state.pendingAutoCount} items pending"
    }
    return "On for $enabled$pending"
}

@Composable
private fun SettingsSection(title: String, content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            title.uppercase(),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        content()
    }
}

/**
 * A labelled switch whose whole row is the control.
 *
 * The Row owns the toggle (`Modifier.toggleable` + `role = Role.Switch`) and the
 * `Switch` is passed `onCheckedChange = null`, which is the Material pattern for
 * exactly this: one merged, >= 48dp target that TalkBack announces as a single
 * switch with both the title and the explanation, instead of a bare switch whose
 * label is unreachable.
 */
@Composable
private fun SettingsSwitchRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = checked, onCheckedChange = null)
    }
}

@Composable
private fun SettingsClickRow(
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    // TextButton rather than a bare Row: focusable, >= 48dp, and it announces
    // itself as a button to TalkBack.
    TextButton(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ThemeChoiceRow(
    selected: ThemePreference,
    onSelect: (ThemePreference) -> Unit,
) {
    val options = listOf(
        ThemePreference.SYSTEM to "System",
        ThemePreference.LIGHT to "Light",
        ThemePreference.DARK to "Dark",
    )
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text("Theme", style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.height(6.dp))
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().selectableGroup()) {
            options.forEachIndexed { index, (value, label) ->
                SegmentedButton(
                    selected = value == selected,
                    onClick = { onSelect(value) },
                    shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                ) {
                    Text(label)
                }
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(
            when (selected) {
                ThemePreference.SYSTEM -> "Following the system setting"
                ThemePreference.LIGHT -> "Always light"
                ThemePreference.DARK -> "Always dark"
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * The destructive action, shared by Settings and Connection so both paths show
 * the identical confirmation: a disconnect revokes the native credential, the
 * web grant and every web session, and clears local data.
 */
@Composable
internal fun DisconnectSection(
    busy: Boolean,
    onDisconnect: () -> Unit,
    explanation: String,
) {
    var confirming by remember { mutableStateOf(false) }

    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "Disconnect this device",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(
                explanation,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Button(
                onClick = { confirming = true },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Disconnect")
            }
        }
    }

    if (confirming) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Disconnect this device?") },
            text = {
                Text(
                    "This revokes the native credential, the web grant and all web sessions on " +
                        "the server, and clears all local data. The app can be re-paired later " +
                        "with a new QR code.",
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        confirming = false
                        onDisconnect()
                    },
                ) {
                    Text("Disconnect")
                }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) {
                    Text("Cancel")
                }
            },
        )
    }
}

/**
 * The live, platform-owned notification state. There is deliberately no stored
 * preference to drift out of step with it.
 */
private fun notificationsEnabled(context: Context): Boolean =
    NotificationManagerCompat.from(context).areNotificationsEnabled()

private fun openNotificationSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}

/**
 * About: the device/server facts that are not settings. Server identity is on
 * Connection; this is the local half. No credential material is ever rendered.
 */
@Composable
fun AboutScreen(
    registration: Registration,
    appVersion: String,
    lastCheckInLabel: String?,
    checkInOk: Boolean?,
) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            "LamaSync Companion",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
        )
        Text(
            "This app keeps this device's files in step with your fleet and protects its " +
                "camera media. Fleet administration lives in the web UI, which opens inside " +
                "the app with a separate, expiring session.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        SettingsSection("This device") {
            InfoRow("Device name", registration.displayName)
            InfoRow("Device ID", registration.hostId)
            InfoRow("App version", appVersion)
            InfoRow(
                "Enrolled",
                formatTimestamp(registration.enrolledAtEpochMillis),
            )
        }

        SettingsSection("Check-in") {
            InfoRow(
                "Last check-in",
                lastCheckInLabel ?: formatTimestampOrNever(registration.lastCheckInEpochMillis),
            )
            if (checkInOk == false) {
                Text(
                    "The last check-in failed. The app retries on the next launch; the native " +
                        "credential may still be valid.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        Text(
            "Secrets (the native credential and the web grant) are held in Android Keystore-backed " +
                "encryption and are never displayed, exported or backed up.",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Shared detail row for Connection and About, so the two render alike. */
@Composable
internal fun InfoRow(label: String, value: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

internal fun formatTimestamp(epochMillis: Long): String =
    java.text.DateFormat.getDateTimeInstance().format(java.util.Date(epochMillis))

internal fun formatTimestampOrNever(epochMillis: Long?): String =
    if (epochMillis == null) "Never checked in" else formatTimestamp(epochMillis)
