package app.lamasync.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.lamasync.companion.data.Registration

/**
 * LAMA-329 — the Connection destination.
 *
 * Scope is deliberately narrow: this screen owns the *server relationship*
 * (which server, whether its web session is alive, how to restore or end it).
 * The device-local facts — device id, app version, enrollment and check-in —
 * live on About, so no detail row is stated in two places that could drift.
 *
 * Reached from the top app bar (via Settings), and it keeps the same
 * confirmation dialog for the destructive action as Settings
 * ([DisconnectSection]) so the two entry points cannot describe the disconnect
 * differently.
 */
@Composable
fun ConnectionScreen(
    registration: Registration,
    connected: Boolean,
    busy: Boolean,
    onReconnect: () -> Unit,
    onDisconnect: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            "Connection",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
        )

        InfoRow("Server", registration.origin)
        InfoRow(
            "Web session",
            if (connected) {
                "Active — fleet administration is available inside the app"
            } else {
                "Expired — reconnect to restore fleet administration"
            },
        )

        Text(
            "The native credential identifies this device only. Fleet administration happens " +
                "inside the web UI through the separate web session, which expires after " +
                "12 hours and can be restored with Reconnect without another QR scan.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(4.dp))
        Button(onClick = onReconnect, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Text("Reconnect web session")
        }

        Spacer(Modifier.height(8.dp))
        DisconnectSection(
            busy = busy,
            onDisconnect = onDisconnect,
            explanation = "This revokes this device on the server and clears all local data. " +
                "The app can be re-paired later with a new QR code.",
        )
    }
}
