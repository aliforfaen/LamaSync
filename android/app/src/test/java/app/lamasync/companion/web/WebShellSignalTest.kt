package app.lamasync.companion.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LAMA-329 — the embedded display-mode signal.
 *
 * The signal may only ever change presentation, so the properties worth
 * pinning down are that it stays on the enrolled origin, that it says exactly
 * one thing, and that it is idempotent enough for the WebView's reload path.
 */
class WebShellSignalTest {

    private val origin = "https://fleet.example.com"

    @Test
    fun `the initial url stays on the enrolled origin`() {
        val url = WebShellSignal.initialUrl(origin)
        assertTrue(url.startsWith("$origin/"))
        assertEquals("$origin/?${WebShellSignal.PARAM}=${WebShellSignal.EMBEDDED_VALUE}", url)
    }

    @Test
    fun `a trailing slash on the stored origin does not double up`() {
        assertEquals(
            WebShellSignal.initialUrl(origin),
            WebShellSignal.initialUrl("$origin/"),
        )
    }

    @Test
    fun `the initial url carries the signal`() {
        assertTrue(WebShellSignal.carriesEmbeddedSignal(WebShellSignal.initialUrl(origin)))
    }

    @Test
    fun `a plain same-origin url does not carry the signal`() {
        // The deep-link path (upload receipt → Data Browser) loads plain URLs;
        // the SPA is expected to remember the mode for the session, so this must
        // not be mistaken for a signal-carrying load.
        assertFalse(WebShellSignal.carriesEmbeddedSignal("$origin/#/data?kind=local&path=%2Fx"))
        assertFalse(WebShellSignal.carriesEmbeddedSignal("$origin/"))
        assertFalse(WebShellSignal.carriesEmbeddedSignal(null))
        assertFalse(WebShellSignal.carriesEmbeddedSignal(""))
    }

    @Test
    fun `other parameter names and values are not the signal`() {
        assertFalse(WebShellSignal.carriesEmbeddedSignal("$origin/?lamasyncShell=browser"))
        assertFalse(WebShellSignal.carriesEmbeddedSignal("$origin/?lamasyncShell="))
        assertFalse(WebShellSignal.carriesEmbeddedSignal("$origin/?other=android"))
    }

    @Test
    fun `the signal is found among other parameters and before a fragment`() {
        assertTrue(
            WebShellSignal.carriesEmbeddedSignal(
                "$origin/?a=1&${WebShellSignal.PARAM}=${WebShellSignal.EMBEDDED_VALUE}&b=2#/hosts",
            ),
        )
    }

    @Test
    fun `the parameter name is a single stable contract shared with the web ui`() {
        // Mirrored by packages/web-ui/src/shell.ts (SHELL_PARAM) and covered by
        // that module's tests. Renaming it here without renaming it there would
        // silently disable presentation branching in the embedded SPA.
        assertEquals("lamasyncShell", WebShellSignal.PARAM)
        assertEquals("android", WebShellSignal.EMBEDDED_VALUE)
    }
}
