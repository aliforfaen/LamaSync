package app.lamasync.companion.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LAMA-329 — the shell's connection indicator is derived, never guessed.
 *
 * These cases are the ones that decide what the top app bar claims and whether
 * it offers a reconnect, so they are worth pinning down off-device.
 */
class ConnectionStateTest {

    @Test
    fun `a live web session is the only OK state`() {
        val state = connectionStateOf(
            webSessionConnected = true,
            checkInOk = true,
            lastCheckInLabel = "Checked in",
        )
        assertEquals(ConnectionLevel.OK, state.level)
        assertEquals("Connected", state.label)
        assertFalse("a healthy session must not offer a reconnect", state.needsReconnect)
    }

    @Test
    fun `an unknown check-in result does not downgrade a live session`() {
        // checkInOk == null means "not reported yet" (a fresh launch before the
        // check-in completes). Claiming a warning would be a guess.
        val state = connectionStateOf(
            webSessionConnected = true,
            checkInOk = null,
            lastCheckInLabel = null,
        )
        assertEquals(ConnectionLevel.OK, state.level)
    }

    @Test
    fun `a lost web session is an error with a reconnect affordance`() {
        val state = connectionStateOf(
            webSessionConnected = false,
            checkInOk = true,
            lastCheckInLabel = null,
        )
        assertEquals(ConnectionLevel.ERROR, state.level)
        assertTrue("management needs the web session back", state.needsReconnect)
        assertTrue(state.label.isNotBlank())
    }

    @Test
    fun `a failed check-in warns without claiming the session is gone`() {
        val state = connectionStateOf(
            webSessionConnected = true,
            checkInOk = false,
            lastCheckInLabel = "Check-in failed: unreachable (will retry on next launch)",
        )
        assertEquals(ConnectionLevel.WARN, state.level)
        assertEquals(
            "Check-in failed: unreachable (will retry on next launch)",
            state.label,
        )
        assertFalse(
            "the native credential may still be valid; only the next launch can tell",
            state.needsReconnect,
        )
    }

    @Test
    fun `a failed check-in without a label still says something`() {
        val state = connectionStateOf(
            webSessionConnected = true,
            checkInOk = false,
            lastCheckInLabel = null,
        )
        assertEquals(ConnectionLevel.WARN, state.level)
        assertTrue("the indicator must never be a colour-only or empty signal", state.label.isNotBlank())
    }

    @Test
    fun `a lost session outranks a failed check-in`() {
        val state = connectionStateOf(
            webSessionConnected = false,
            checkInOk = false,
            lastCheckInLabel = "Check-in failed",
        )
        assertEquals(ConnectionLevel.ERROR, state.level)
        assertTrue(state.needsReconnect)
    }
}
