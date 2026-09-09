package app.lamasync.companion.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.lamasync.companion.media.MediaCollection
import app.lamasync.companion.media.MediaCoverage
import app.lamasync.companion.media.MediaPermissionScope
import app.lamasync.companion.media.MediaPermissions
import app.lamasync.companion.media.ScopeMode
import java.text.DateFormat
import java.util.Date

/**
 * LAMA-296 stage 2 — automatic-protection setup + status surface.
 *
 * Sources, initial scope, transfer policy, permission recovery and
 * destination readiness on one screen; the status block derives everything
 * from the durable stores (coverage = contiguous completion model, pending =
 * auto queue items, waiting reason + scope = live checks). Stage-1 manual
 * uploads are untouched.
 */
@Composable
fun AutoProtectScreen(
    viewModel: AutoProtectViewModel,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val state by viewModel.ui.collectAsStateWithLifecycle()

    // Re-check the live permission scope whenever the screen resumes (the
    // user can change access in settings without the app knowing).
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) viewModel.refreshScope()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted -> viewModel.onPermissionResult(granted) }

    LaunchedEffect(state.message) {
        state.message?.let {
            android.widget.Toast.makeText(context, it, android.widget.Toast.LENGTH_SHORT).show()
            viewModel.dismissMessage()
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column {
                Text(
                    "Automatic protection",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "Camera media back up automatically when conditions allow.",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = onBack) { Text("Back") }
        }

        // Request the runtime permissions in ONE dialog, limited to what the
        // enabled sources need (P0-3: request only required permissions).
        LaunchedEffect(state.settings.anySourceEnabled, state.scopes) {
            if (state.settings.anySourceEnabled &&
                state.scopes.values.all { it == MediaPermissionScope.NOT_GRANTED }
            ) {
                permissionLauncher.launch(
                    MediaPermissions.requestList(
                        android.os.Build.VERSION.SDK_INT,
                        photosEnabled = state.settings.cameraPhotosEnabled || state.settings.screenshotsEnabled,
                        videosEnabled = state.settings.cameraVideosEnabled || state.settings.screenshotsEnabled,
                    ),
                )
            }
        }

        // Permission status + recovery (per collection — P0-3).
        PermissionCard(
            scopes = state.scopes,
            guidance = state.scopeGuidance,
            onRequest = {
                permissionLauncher.launch(
                    MediaPermissions.requestList(
                        android.os.Build.VERSION.SDK_INT,
                        photosEnabled = state.settings.cameraPhotosEnabled || state.settings.screenshotsEnabled,
                        videosEnabled = state.settings.cameraVideosEnabled || state.settings.screenshotsEnabled,
                    ),
                )
            },
            onOpenSettings = {
                context.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null),
                    ),
                )
            },
        )

        // Sources.
        Text("Sources", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        SourceCard("Camera photos", "Everything in DCIM/Camera that is an image") {
            Switch(
                checked = state.settings.cameraPhotosEnabled,
                onCheckedChange = viewModel::setCameraPhotos,
            )
        }
        SourceCard("Camera videos", "Videos in DCIM/Camera, including large recordings") {
            Switch(
                checked = state.settings.cameraVideosEnabled,
                onCheckedChange = viewModel::setCameraVideos,
            )
        }
        SourceCard("Screenshots", "Images in the Screenshots folder") {
            Switch(
                checked = state.settings.screenshotsEnabled,
                onCheckedChange = viewModel::setScreenshots,
            )
        }

        // Initial scope.
        Text("Initial scope", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)) {
            Column(Modifier.padding(12.dp)) {
                ScopeOption(
                    selected = state.settings.scopeMode == ScopeMode.NEW_ONLY,
                    title = "New media only",
                    subtitle = "Protect photos/videos captured AFTER the first scan.",
                    onClick = { viewModel.setScopeMode(ScopeMode.NEW_ONLY) },
                )
                ScopeOption(
                    selected = state.settings.scopeMode == ScopeMode.EXISTING_HISTORY,
                    title = "Existing history too",
                    subtitle = "Import everything already on the device (can take a while).",
                    onClick = { viewModel.setScopeMode(ScopeMode.EXISTING_HISTORY) },
                )
            }
        }

        // Transfer policy (AUTOMATIC work only — never manual uploads).
        Text("Transfer conditions", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)) {
            Column(Modifier.padding(12.dp)) {
                PolicyRow("Only on unmetered Wi-Fi", "Large videos wait on metered networks.",
                    state.settings.unmeteredOnly, viewModel::setUnmeteredOnly)
                PolicyRow("Only while charging", "Saves battery for long transfers.",
                    state.settings.chargingOnly, viewModel::setChargingOnly)
                Text(
                    "Applies to automatic protection only. Manual uploads always follow " +
                        "their own Uploads screen settings.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // Destination readiness.
        Text("Destination", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)) {
            val relPath = state.settings.cameraDestinationRelPath
            val label = state.settings.cameraDestinationLabel
            Column(Modifier.padding(12.dp)) {
                if (relPath != null) {
                    Text("Server-approved: ${label ?: "Camera"}", fontWeight = FontWeight.Medium)
                    Text(
                        relPath,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Text(
                        "No Camera inbox assigned yet. An administrator assigns it in " +
                            "Admin → Android devices.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }

        // Status.
        StatusCard(state = state, waitingText = viewModel.waitingReasonText())

        Button(
            onClick = viewModel::syncNow,
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.busy && state.settings.anySourceEnabled,
        ) {
            Text(if (state.busy) "Syncing…" else "Sync now")
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun PermissionCard(
    scopes: Map<app.lamasync.companion.media.MediaCollection, MediaPermissionScope>,
    guidance: String,
    onRequest: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val anyGranted = scopes.values.any { it != MediaPermissionScope.NOT_GRANTED }
    val anyFull = scopes.values.any { it == MediaPermissionScope.FULL }
    val anyDenied = scopes.values.any { it == MediaPermissionScope.NOT_GRANTED }
    val color = when {
        anyFull -> MaterialTheme.colorScheme.primary
        anyGranted -> MaterialTheme.colorScheme.tertiary
        else -> MaterialTheme.colorScheme.error
    }
    Surface(shape = MaterialTheme.shapes.medium, color = color.copy(alpha = 0.12f)) {
        Column(Modifier.padding(12.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column {
                    Text(
                        "Media access",
                        fontWeight = FontWeight.SemiBold,
                        color = color,
                    )
                    Text(
                        when {
                            anyFull && !anyDenied -> "Full access to photos and videos"
                            else -> "Photos: ${scopes[MediaCollection.IMAGES]?.label()} · Videos: ${scopes[MediaCollection.VIDEOS]?.label()}"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = color,
                    )
                }
                if (!anyFull || anyDenied) {
                    TextButton(onClick = onRequest) {
                        Text(if (anyGranted) "Grant full access" else "Grant access")
                    }
                }
            }
            Text(
                guidance,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (anyDenied) {
                TextButton(onClick = onOpenSettings) {
                    Text("Open App settings")
                }
            }
        }
    }
}

private fun MediaPermissionScope.label(): String = when (this) {
    MediaPermissionScope.FULL -> "full"
    MediaPermissionScope.PARTIAL -> "selected"
    MediaPermissionScope.NOT_GRANTED -> "not granted"
}

@Composable
private fun SourceCard(title: String, subtitle: String, trailing: @Composable () -> Unit) {
    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            trailing()
        }
    }
}

@Composable
private fun ScopeOption(
    selected: Boolean,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Column {
            Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            Text(
                subtitle,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun PolicyRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            Text(
                subtitle,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun StatusCard(
    state: AutoProtectViewModel.AutoProtectUiState,
    waitingText: String?,
) {
    val settings = state.settings
    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)) {
        Column(Modifier.padding(12.dp)) {
            Text("Status", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            StatusRow("Protected through", MediaCoverage.protectedThroughLabel(state.coverage.protectedThroughEpochMillis) ?: "Nothing protected yet")
            StatusRow("Last successful protection", settings.lastSuccessfulProtectionEpochMillis?.let { formatTime(it) } ?: "Never")
            StatusRow("Pending", "${state.pendingAutoCount} file${if (state.pendingAutoCount == 1L) "" else "s"} · ${formatBytes(state.pendingAutoBytes)}")
            StatusRow("Coverage", "${state.coverage.contiguousProtectedCount} of ${state.coverage.totalCount} contiguous")
            if (state.coverage.unreadableCount > 0) {
                StatusRow("Needs attention", "${state.coverage.unreadableCount} file${if (state.coverage.unreadableCount == 1L) "" else "s"} unreadable")
            }
            val scanLabel = settings.lastScanAtEpochMillis?.let { "Last scan ${formatTime(it)}" }
            if (scanLabel != null) {
                StatusRow("Last scan", "$scanLabel · ${settings.lastScanStatus.name.lowercase().replace('_', ' ')}")
            }
            waitingText?.let {
                Spacer(Modifier.height(6.dp))
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun StatusRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(0.45f),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(0.55f),
        )
    }
}

/** Keeps the pure waiting-reason text reachable from the composable. */
private fun formatTime(epochMillis: Long): String =
    DateFormat.getDateTimeInstance().format(Date(epochMillis))

private fun formatBytes(bytes: Long): String {
    if (bytes == 0L) return "0 B"
    val units = listOf("B", "KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var unit = 0
    while (value >= 1024 && unit < units.lastIndex) {
        value /= 1024
        unit++
    }
    return "%.1f %s".format(value, units[unit])
}