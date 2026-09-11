package app.lamasync.companion.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LAMA-329 — the navigation contract, off-device.
 *
 * The route table is now the single source the nav graph, the top app bar and
 * the shell's start destination all read from, so the properties worth pinning
 * down are that it stays internally consistent and that the start-destination
 * rule (the R5 blank-screen bug) cannot silently invert.
 */
class ShellNavigationTest {

    @Test
    fun `an unpaired shell starts on uploads so share intake stays renderable`() {
        // R5: a share intent can land before this device is paired, and Manage
        // renders nothing without a registration. Starting on Uploads is what
        // keeps back navigation from pointing at an empty screen.
        assertEquals(Destination.UPLOADS.route, shellStartDestination(paired = false))
    }

    @Test
    fun `a paired shell starts on manage`() {
        assertEquals(Destination.MANAGE.route, shellStartDestination(paired = true))
    }

    @Test
    fun `every destination has a unique, non-empty route`() {
        val routes = Destination.entries.map { it.route }
        assertEquals("a duplicate route would make navigate() ambiguous", routes.size, routes.toSet().size)
        for (route in routes) {
            assertTrue("route must not be blank", route.isNotBlank())
            assertFalse("routes are used verbatim as nav destinations", route.contains('/'))
        }
    }

    @Test
    fun `every destination has a title for the app bar`() {
        for (destination in Destination.entries) {
            assertTrue(
                "${destination.name} has no app bar title",
                destination.title.isNotBlank(),
            )
        }
    }

    @Test
    fun `the shell gate is the manage screen`() {
        // `Screen.MANAGE` means "the managed shell is active"; the post-enrollment
        // destinations were deliberately removed from this enum so the back stack
        // is the only record of where the user is. If a destination is ever added
        // back here, this breaks and someone has to decide which is the truth.
        assertEquals(
            setOf(Screen.WELCOME, Screen.SCANNER, Screen.CONFIRM, Screen.PROGRESS, Screen.MANAGE),
            Screen.entries.toSet(),
        )
    }

    // ---------------------------------------------------------------- web state

    @Test
    fun `the web state is inert before a webview exists`() {
        val state = ManageWebState()
        assertFalse("back must not claim a history it does not have", state.canGoBack)
        assertFalse(state.goBack())
        assertFalse(state.loading)
        assertFalse(state.refreshing)
    }

    @Test
    fun `a finished load clears the refresh indicator`() {
        val state = ManageWebState()

        // A pull gesture or the top-bar reload raises the indicator...
        state.reload()
        assertTrue("a requested reload must show the indicator", state.refreshing)

        // ...a load in flight keeps it up...
        state.onWebStateChanged(canGoBack = false, loading = true)
        assertTrue(state.refreshing)

        // ...and only the load FINISHING lowers it, so it can never spin forever.
        state.onWebStateChanged(canGoBack = true, loading = false)
        assertFalse(state.refreshing)
        assertFalse(state.loading)
        assertTrue(state.canGoBack)
        assertEquals(RefreshOutcome.Loaded, state.consumeRefreshOutcome())
    }

    // ------------------------------------------------- LAMA-334 item 2 states

    @Test
    fun `a main-frame load failure retires the indicator and reports it`() {
        val state = ManageWebState()
        state.reload()
        state.onWebStateChanged(canGoBack = false, loading = true)

        state.onLoadFailed("net::ERR_NAME_NOT_RESOLVED")

        assertFalse("a failed load must not leave the spinner up", state.refreshing)
        assertFalse(state.loading)
        assertEquals(
            RefreshOutcome.Failed("net::ERR_NAME_NOT_RESOLVED"),
            state.consumeRefreshOutcome(),
        )
    }

    @Test
    fun `the watchdog retires an indicator that no event ever closed`() {
        val state = ManageWebState()
        state.reload()
        state.onWebStateChanged(canGoBack = false, loading = true)

        // No onPageFinished, no onReceivedError — exactly the stall the field
        // report described.
        state.refreshTimedOut()

        assertFalse("a timed-out refresh must stop spinning", state.refreshing)
        assertEquals(RefreshOutcome.TimedOut, state.consumeRefreshOutcome())

        // A late load finishing afterwards is not a second outcome.
        state.onWebStateChanged(canGoBack = true, loading = false)
        assertEquals(null, state.consumeRefreshOutcome())
    }

    @Test
    fun `leaving the surface cancels a refresh instead of leaving it raised`() {
        val state = ManageWebState()
        state.reload()

        state.cancelRefresh()
        state.clear()

        assertFalse(state.refreshing)
        assertFalse(state.loading)
        assertEquals(RefreshOutcome.Cancelled, state.consumeRefreshOutcome())
    }

    @Test
    fun `every reload bumps the generation the watchdog keys on`() {
        val state = ManageWebState()
        val before = state.refreshGeneration

        state.reload()
        state.reload()

        assertEquals(before + 2, state.refreshGeneration)
        // Nothing has reported a terminal event yet, so there is no outcome to
        // announce — a fresh generation must not reuse the previous one's.
        assertEquals(null, state.consumeRefreshOutcome())
    }
}
