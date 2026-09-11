package app.lamasync.companion.ui

import androidx.compose.material3.ColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.material3.MaterialTheme

/**
 * LAMA-329 — the shell's connection indicator.
 *
 * Three honest levels, derived only from state the app already knows. The
 * indicator is NEVER colour-only: every level carries a label, so the shell
 * survives a colour-blind reader, a monochrome screenshot and TalkBack.
 */
enum class ConnectionLevel { OK, WARN, ERROR }

data class ConnectionState(
    val level: ConnectionLevel,
    val label: String,
    /** The web session is gone and only a reconnect (not a QR re-scan) restores it. */
    val needsReconnect: Boolean,
)

/**
 * Pure derivation so the shell's indicator can be unit-tested without a device.
 *
 * The web session is the only thing the *management* surface actually needs, so
 * its loss is an [ConnectionLevel.ERROR] with a reconnect affordance. A failed
 * check-in is a warning: the native credential may still be valid (the next
 * launch retries), and the management surface keeps working.
 */
fun connectionStateOf(
    webSessionConnected: Boolean,
    checkInOk: Boolean?,
    lastCheckInLabel: String?,
): ConnectionState = when {
    !webSessionConnected -> ConnectionState(
        level = ConnectionLevel.ERROR,
        label = "Web session expired",
        needsReconnect = true,
    )
    checkInOk == false -> ConnectionState(
        level = ConnectionLevel.WARN,
        label = lastCheckInLabel ?: "Check-in failed",
        needsReconnect = false,
    )
    else -> ConnectionState(
        level = ConnectionLevel.OK,
        label = "Connected",
        needsReconnect = false,
    )
}

@Composable
internal fun ConnectionLevel.indicatorColor(colorScheme: ColorScheme = MaterialTheme.colorScheme) =
    when (this) {
        ConnectionLevel.OK -> colorScheme.primary
        ConnectionLevel.WARN -> colorScheme.tertiary
        ConnectionLevel.ERROR -> colorScheme.error
    }
