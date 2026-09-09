package app.lamasync.companion.ui

import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.core.net.toUri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import android.webkit.WebView
import app.lamasync.companion.data.Registration
import app.lamasync.companion.web.HardenedWebView

/**
 * Management screen: hardened WebView pointed at the enrolled origin plus a
 * compact header that opens the connection panel.
 */
@Composable
fun ManagementScreen(
    registration: Registration,
    webSessionConnected: Boolean,
    navUrl: String?,
    onNavUrlConsumed: () -> Unit,
    onOpenConnection: () -> Unit,
    onReconnect: () -> Unit,
    onOpenUploads: () -> Unit,
    onOpenAutoProtect: () -> Unit,
) {
    val context = LocalContext.current
    var webView by remember { mutableStateOf<WebView?>(null) }
    val origin = registration.origin

    val listener = remember(context) {
        object : HardenedWebView.Listener {
            override fun onOpenExternally(url: String) = openInBrowser(context, url)

            override fun onBlockedNavigation(url: String) {
                Toast.makeText(context, "Blocked navigation to $url", Toast.LENGTH_SHORT).show()
            }

            override fun onBlockedSsl(url: String) {
                Toast.makeText(context, "Blocked: certificate error at $url", Toast.LENGTH_LONG).show()
            }

            override fun onPageTitle(title: String?) = Unit
        }
    }

    Column(Modifier.fillMaxSize()) {
        Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "LamaSync — ${hostLabel(origin)}",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                    )
                    if (!webSessionConnected) {
                        Text(
                            "Web session expired — reconnect",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
                TextButton(onClick = onOpenConnection) {
                    Text("Connection")
                }
                TextButton(onClick = onOpenUploads) {
                    Text("Uploads")
                }
                TextButton(onClick = onOpenAutoProtect) {
                    Text("Auto")
                }
            }
        }
        Box(Modifier.fillMaxSize()) {
            AndroidView(
                factory = { ctx ->
                    HardenedWebView.create(
                        context = ctx,
                        canonicalOrigin = origin,
                        debugAllowWebContentsDebugging = app.lamasync.companion.BuildConfig.DEBUG,
                        listener = listener,
                    ).also { view ->
                        webView = view
                        view.loadUrl("$origin/")
                    }
                },
                onRelease = {
                    webView = null
                    it.destroy()
                },
                modifier = Modifier.fillMaxSize(),
            )
            if (!webSessionConnected) {
                Surface(
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .padding(top = 12.dp),
                    shape = MaterialTheme.shapes.large,
                    color = MaterialTheme.colorScheme.inverseSurface,
                ) {
                    Button(onClick = onReconnect, modifier = Modifier.padding(4.dp)) {
                        Text("Reconnect web session")
                    }
                }
            }
        }
    }
    // After a reconnect the same WebView is kept and only reloaded.
    LaunchedEffect(webSessionConnected) {
        if (webSessionConnected) webView?.reload()
    }
    // LAMA-296 stage 1: an uploaded-file receipt's open-in-web path (the
    // Data Browser deep link). The WebView stays on the enrolled origin.
    LaunchedEffect(navUrl) {
        if (navUrl != null) {
            webView?.loadUrl(navUrl)
            onNavUrlConsumed()
        }
    }
}

@Composable
fun ConnectionScreen(
    registration: Registration,
    appVersion: String,
    lastCheckInLabel: String?,
    checkInOk: Boolean?,
    busy: Boolean,
    onBack: () -> Unit,
    onReconnect: () -> Unit,
    onDisconnect: () -> Unit,
) {
    var confirmingDisconnect by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Connection", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)

        InfoRow("Server", registration.origin)
        InfoRow("Device ID", registration.hostId)
        InfoRow("Device name", registration.displayName)
        InfoRow("App version", appVersion)
        val checkInText = lastCheckInLabel
            ?: if (registration.lastCheckInEpochMillis != null) {
                val at = java.text.DateFormat.getDateTimeInstance()
                    .format(java.util.Date(registration.lastCheckInEpochMillis))
                "Last check-in: $at"
            } else {
                "Never checked in"
            }
        InfoRow(
            "Check-in",
            checkInText + (if (checkInOk == false) " (failed)" else ""),
        )

        Text(
            "The native credential identifies this device only. Fleet administration happens " +
                "inside the web UI through the separate web session, which expires after " +
                "12 hours and can be restored with Reconnect without another QR scan.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(8.dp))
        Button(onClick = onReconnect, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Text("Reconnect web session")
        }
        TextButton(
            onClick = { confirmingDisconnect = true },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Disconnect this device", color = MaterialTheme.colorScheme.error)
        }
        TextButton(onClick = onBack) {
            Text("Back to management")
        }
    }

    if (confirmingDisconnect) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmingDisconnect = false },
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
                        confirmingDisconnect = false
                        onDisconnect()
                    },
                ) {
                    Text("Disconnect")
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingDisconnect = false }) {
                    Text("Cancel")
                }
            },
        )
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

private fun hostLabel(origin: String): String =
    origin.removePrefix("https://").substringBefore('/')

private fun openInBrowser(context: Context, url: String) {
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()))
    }.onFailure {
        Toast.makeText(context, "Could not open $url", Toast.LENGTH_SHORT).show()
    }
}
