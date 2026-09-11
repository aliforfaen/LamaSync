package app.lamasync.companion.ui

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.UploadQueueItem
import app.lamasync.companion.data.UploadStatus
import app.lamasync.companion.media.GalleryFolder
import app.lamasync.companion.media.MediaPermissionScope
import app.lamasync.companion.media.MediaPermissions
import app.lamasync.companion.network.MobileUploadDestinationDto

/**
 * LAMA-296 stage 1 — the upload queue screen: accurate per-item states
 * (uploading, waiting, blocked, failed, cancelled, verified done), progress,
 * retry/cancel/remove, the destination picker when a share needs a choice,
 * the unmetered-network preference, and a browse/open action for completed
 * receipts.
 *
 * R5: with [pairedRegistration] null (a share arrived while unpaired or
 * credential-lost) the screen renders a renderable onboarding/error surface
 * instead of an empty app view.
 */
@Composable
fun UploadsScreen(
    viewModel: UploadsViewModel,
    pairedRegistration: Registration?,
    onBack: () -> Unit,
    onPairNow: () -> Unit,
    onOpenUrl: (String) -> Unit,
    onOpenDocumentPicker: () -> Unit,
    onOpenCameraProtection: () -> Unit,
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()

    // Not paired: a share intent landed but there is no usable enrollment —
    // an explicit onboarding/error surface, never an empty screen.
    if (pairedRegistration == null) {
        val block = state.intakeBlock ?: UploadsViewModel.IntakeBlock.UNPAIRED
        UnpairedUploadsSurface(
            credentialLost = block == UploadsViewModel.IntakeBlock.CREDENTIAL_LOST,
            onPairNow = onPairNow,
            onBack = onBack,
        )
        return
    }

    // LAMA-334 item 1: the media grant is requested only when the operator asks
    // to upload a gallery folder, and only for the two collections this feature
    // can use. Nothing is read until the dialog is answered.
    val galleryPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { viewModel.onGalleryPermissionResult() }

    LaunchedEffect(Unit) { viewModel.refreshGalleryFolders() }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        // One scroll surface for the whole screen: the gallery catalogue and
        // the queue used to be two scrollable regions, and a second scroller
        // inside a Column is how a phone gets a list it cannot reach the end of.
        LazyColumn(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                // LAMA-329: the title and the back affordance moved to the app
                // bar; this line keeps the one fact the app bar does not carry.
                Text(
                    "Device ${pairedRegistration.hostId}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            state.message?.let { text ->
                item {
                    val color = if (state.messageIsError) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    }
                    Surface(color = color.copy(alpha = 0.12f), shape = MaterialTheme.shapes.medium) {
                        Text(
                            text,
                            modifier = Modifier.padding(12.dp),
                            color = color,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }

            state.pendingShare?.let { pending ->
                item {
                    DestinationPicker(
                        destinations = pending.destinations,
                        fileCount = if (pending.gallery != null) {
                            pending.gallery.declaredCount
                        } else {
                            pending.uris.size
                        },
                        galleryLabel = pending.gallery?.label,
                        onPick = viewModel::chooseDestination,
                        onCancel = viewModel::cancelDestinationChoice,
                    )
                }
            }

            item {
                GallerySection(
                    gallery = state.gallery,
                    batch = state.galleryBatch,
                    onAllow = {
                        galleryPermissionLauncher.launch(
                            MediaPermissions.requestList(
                                sdkInt = android.os.Build.VERSION.SDK_INT,
                                photosEnabled = true,
                                videosEnabled = true,
                            ),
                        )
                    },
                    onUpload = viewModel::uploadGalleryFolder,
                    onStop = viewModel::cancelGalleryBatch,
                    onRefresh = viewModel::refreshGalleryFolders,
                    onOpenCameraProtection = onOpenCameraProtection,
                )
            }

            if (state.items.isEmpty()) {
                item {
                    Text(
                        "Nothing queued yet. Share a file into LamaSync from another app, " +
                            "upload a gallery folder above, or use “Select files” below. " +
                            "Completed uploads appear in the web UI's Data Browser.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                item {
                    Text(
                        "Queue (${state.items.size})",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                items(state.items, key = { it.id }) { item ->
                    UploadRow(
                        item = item,
                        onRetry = { viewModel.retryItem(item.id) },
                        onCancel = { viewModel.cancelItem(item.id) },
                        onRemove = { viewModel.removeItem(item.id) },
                        onOpen = {
                            item.receipt?.let {
                                onOpenUrl(
                                    viewModel.browseUrlFor(
                                        pairedRegistration.origin,
                                        it.browsePath,
                                        it.browseFolderId,
                                    ),
                                )
                            }
                        },
                    )
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Only on unmetered Wi-Fi", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "Large transfers may wait on metered networks.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = state.policy.unmeteredOnly,
                onCheckedChange = viewModel::setUnmeteredOnly,
            )
        }
        Button(
            onClick = onOpenDocumentPicker,
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.busy,
        ) {
            Text("Select files to upload")
        }
    }
}

/**
 * LAMA-334 item 1 — the gallery-folder section.
 *
 * Three honest states, never a dead panel: no media access (with the one
 * request that fixes it), access but no folders, and a catalogue. The copy
 * states the semantics the operator has to be able to predict — a one-shot
 * snapshot of what is in the folder NOW, not an ongoing sync.
 */
@Composable
private fun GallerySection(
    gallery: UploadsViewModel.GalleryState,
    batch: UploadsViewModel.GalleryBatch?,
    onAllow: () -> Unit,
    onUpload: (GalleryFolder) -> Unit,
    onStop: () -> Unit,
    onRefresh: () -> Unit,
    onOpenCameraProtection: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                "Gallery folders",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            TextButton(onClick = onRefresh, enabled = !gallery.loading) {
                Text(if (gallery.loading) "Reading…" else "Refresh")
            }
        }

        if (gallery.scope == MediaPermissionScope.NOT_GRANTED) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                shape = MaterialTheme.shapes.medium,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(
                        "Upload a whole gallery folder",
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "LamaSync reads only the photos and videos you grant — never other " +
                            "files on this device. You choose the folder afterwards.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = onAllow) { Text("Allow media access") }
                }
            }
            return@Column
        }

        Text(
            "A folder upload copies what is in the folder right now. New photos are not " +
                "picked up later — that is what Camera protection is for.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = onOpenCameraProtection) {
            Text("Set up continuous camera protection")
        }

        if (gallery.scope == MediaPermissionScope.PARTIAL) {
            Text(
                "Only the photos and videos you selected are visible. Grant full access in " +
                    "Android settings to see every folder.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.tertiary,
            )
        }

        batch?.let { progress ->
            Spacer(Modifier.height(4.dp))
            Surface(
                color = MaterialTheme.colorScheme.secondary.copy(alpha = 0.12f),
                shape = MaterialTheme.shapes.medium,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(
                        "Queuing ${progress.folderLabel} — ${progress.queued} of ${progress.total}",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                    )
                    if (progress.total > 0) {
                        LinearProgressIndicator(
                            progress = {
                                (progress.queued.toFloat() / progress.total).coerceIn(0f, 1f)
                            },
                            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                        )
                    }
                    if (progress.waiting) {
                        Text(
                            "Waiting for the files already staged to finish transferring, so " +
                                "this device does not fill up.",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(onClick = onStop) { Text("Stop adding files") }
                }
            }
        }

        gallery.error?.let { error ->
            Text(
                error,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        if (gallery.folders.isEmpty() && !gallery.loading) {
            Text(
                "No media folders found for the current access.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (gallery.truncated) {
            Text(
                "This gallery is larger than the screen scans, so these counts are a minimum.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        for (folder in gallery.folders) {
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
            ) {
                Row(
                    modifier = Modifier.padding(12.dp).fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            folder.label,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            "${folder.itemCount} item${if (folder.itemCount == 1) "" else "s"}" +
                                if (folder.totalBytes > 0L) " · ${formatBytes(folder.totalBytes)}" else "",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Button(
                        onClick = { onUpload(folder) },
                        enabled = batch == null && folder.itemCount > 0,
                    ) {
                        Text("Upload")
                    }
                }
            }
        }
    }
}

@Composable
private fun UnpairedUploadsSurface(
    credentialLost: Boolean,
    onPairNow: () -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text(
            "Uploads",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(16.dp))
        Surface(
            color = MaterialTheme.colorScheme.errorContainer,
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(16.dp)) {
                Text(
                    if (credentialLost) "Credential missing" else "Device not paired",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    if (credentialLost) {
                        "This device's upload credential is missing. Re-pair with a QR to upload files."
                    } else {
                        "Pair this device with a QR before sharing files. Your share was not queued."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
                Spacer(Modifier.height(12.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Button(onClick = onPairNow) {
                        Text(if (credentialLost) "Re-pair device" else "Pair device")
                    }
                    TextButton(onClick = onBack) { Text("Back") }
                }
            }
        }
    }
}

@Composable
private fun DestinationPicker(
    destinations: List<MobileUploadDestinationDto>,
    fileCount: Int,
    galleryLabel: String?,
    onPick: (MobileUploadDestinationDto) -> Unit,
    onCancel: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Text(
            if (galleryLabel != null) {
                "Choose an inbox for $galleryLabel ($fileCount file${if (fileCount == 1) "" else "s"}):"
            } else {
                "Choose an inbox for $fileCount file${if (fileCount == 1) "" else "s"}:"
            },
            style = MaterialTheme.typography.titleSmall,
        )
        destinations.forEach { dest ->
            Surface(
                onClick = { onPick(dest) },
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(dest.label, fontWeight = FontWeight.SemiBold)
                    Text(
                        dest.relPath,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        TextButton(onClick = onCancel) { Text("Cancel") }
    }
}

@Composable
private fun UploadRow(
    item: UploadQueueItem,
    onRetry: () -> Unit,
    onCancel: () -> Unit,
    onRemove: () -> Unit,
    onOpen: () -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    item.displayName,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    // LAMA-334 item 4: the filename yields space to the
                    // status. Without the weight the badge was the element
                    // that got squeezed, and a label with no room left wraps
                    // one character per line ("Queued" read vertically).
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                StatusBadge(item)
            }
            item.error?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            val total = item.sizeBytes ?: 0L
            if (total > 0L && item.status == UploadStatus.UPLOADING) {
                LinearProgressIndicator(
                    progress = { (item.uploadedBytes.toFloat() / total).coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                )
                Text(
                    "${formatBytes(item.uploadedBytes)} / ${formatBytes(total)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item.receipt?.let { receipt ->
                Text(
                    "Verified ✓ ${formatBytes(receipt.sizeBytes)} → ${receipt.finalRelPath}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row(Modifier.padding(top = 4.dp)) {
                when (item.status) {
                    UploadStatus.PENDING,
                    UploadStatus.UPLOADING,
                    UploadStatus.WAITING,
                    -> TextButton(onClick = onCancel) { Text("Cancel") }
                    UploadStatus.FAILED,
                    UploadStatus.BLOCKED,
                    -> {
                        TextButton(onClick = onRetry) { Text("Retry") }
                        TextButton(onClick = onCancel) { Text("Cancel") }
                    }
                    UploadStatus.DONE -> {
                        if (item.receipt != null) {
                            TextButton(onClick = onOpen) { Text("Open in web UI") }
                        }
                        TextButton(onClick = onRemove) { Text("Remove") }
                    }
                    UploadStatus.CANCELLED -> {
                        TextButton(onClick = onRemove) { Text("Remove") }
                    }
                }
            }
        }
    }
}

/**
 * The queue state as a horizontal badge.
 *
 * `softWrap = false` plus a surface that is sized by its own content is the
 * contract: a status word is never broken across lines to fit a column, and
 * the filename beside it is what truncates.
 */
@Composable
private fun StatusBadge(item: UploadQueueItem) {
    val (label, color) = when (item.status) {
        UploadStatus.PENDING -> "Queued" to MaterialTheme.colorScheme.onSurfaceVariant
        UploadStatus.UPLOADING -> "Uploading" to MaterialTheme.colorScheme.primary
        UploadStatus.WAITING -> "Waiting" to MaterialTheme.colorScheme.tertiary
        UploadStatus.BLOCKED -> "Needs attention" to MaterialTheme.colorScheme.error
        UploadStatus.FAILED -> "Failed" to MaterialTheme.colorScheme.error
        UploadStatus.CANCELLED -> "Cancelled" to MaterialTheme.colorScheme.onSurfaceVariant
        UploadStatus.DONE -> "Verified" to MaterialTheme.colorScheme.primary
    }
    Surface(color = color.copy(alpha = 0.12f), shape = MaterialTheme.shapes.small) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = color,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            softWrap = false,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
        )
    }
}

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
