package app.lamasync.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.UploadQueueItem
import app.lamasync.companion.data.UploadStatus
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

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        // LAMA-329: the title and the back affordance moved to the app bar;
        // this line keeps the one fact the app bar does not carry.
        Text(
            "Device ${pairedRegistration.hostId}",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.message?.let {
            val color = if (state.messageIsError) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            }
            Surface(color = color.copy(alpha = 0.12f), shape = MaterialTheme.shapes.medium) {
                Text(
                    it,
                    modifier = Modifier.padding(12.dp),
                    color = color,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Spacer(Modifier.height(8.dp))
        }

        if (state.pendingShare != null) {
            DestinationPicker(
                destinations = state.pendingShare!!.destinations,
                fileCount = state.pendingShare!!.uris.size,
                onPick = viewModel::chooseDestination,
                onCancel = viewModel::cancelDestinationChoice,
            )
            Spacer(Modifier.height(8.dp))
        }

        if (state.items.isEmpty()) {
            Text(
                "Nothing queued yet. Share a file into LamaSync from another app, or use " +
                    "“Select files” below. Completed uploads appear in the web UI's Data Browser.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
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
            Column {
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
    onPick: (MobileUploadDestinationDto) -> Unit,
    onCancel: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Text(
            "Choose an inbox for $fileCount file${if (fileCount == 1) "" else "s"}:",
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
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    item.displayName,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                )
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
    Text(
        label,
        style = MaterialTheme.typography.labelMedium,
        color = color,
        fontWeight = FontWeight.SemiBold,
    )
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
