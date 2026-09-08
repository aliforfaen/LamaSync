package app.lamasync.companion.core

import org.junit.Assert.assertEquals
import org.junit.Test

class WebViewNavigationPolicyTest {

    private val origin = "https://fleet.example.com"

    private fun decide(url: String?) = WebViewNavigationPolicy.decide(origin, url)

    @Test
    fun `same-origin top-level navigation is allowed`() {
        assertEquals(NavigationDecision.Allow, decide("https://fleet.example.com/"))
        assertEquals(NavigationDecision.Allow, decide("https://fleet.example.com/"))
        assertEquals(NavigationDecision.Allow, decide("https://fleet.example.com/settings"))
        assertEquals(NavigationDecision.Allow, decide("https://fleet.example.com/route?tab=hosts"))
        assertEquals(NavigationDecision.Allow, decide("https://FLEET.example.com:443/"))
    }

    @Test
    fun `cross-origin https opens externally`() {
        assertEquals(NavigationDecision.OpenExternally, decide("https://other.example.com/"))
        assertEquals(NavigationDecision.OpenExternally, decide("https://sub.fleet.example.com/"))
        assertEquals(NavigationDecision.OpenExternally, decide("https://fleet.example.com:8443/"))
        assertEquals(NavigationDecision.OpenExternally, decide("https://evil.com/fleet.example.com"))
    }

    @Test
    fun `plain http never loads in the credential-bearing webview`() {
        // Even same host: insecure transport must not receive the session cookie.
        assertEquals(NavigationDecision.OpenExternally, decide("http://fleet.example.com/"))
        assertEquals(NavigationDecision.OpenExternally, decide("http://other.example.com/"))
    }

    @Test
    fun `unsafe schemes are blocked`() {
        for (url in listOf(
            "file:///etc/hosts",
            "content://media/external/file",
            "data:text/html,<script>alert(1)</script>",
            "javascript:alert(document.cookie)",
            "intent://fleet.example.com/#Intent;scheme=https;end",
            "ftp://fleet.example.com/",
            "blob:https://fleet.example.com/uuid",
            "about:blank",
            "mailto:user@example.com",
        )) {
            assertEquals("scheme $url", NavigationDecision.Blocked, decide(url))
        }
    }

    @Test
    fun `userinfo urls are blocked even on the enrolled host`() {
        assertEquals(NavigationDecision.Blocked, decide("https://attacker@fleet.example.com/"))
    }

    @Test
    fun `blank and malformed urls are blocked`() {
        assertEquals(NavigationDecision.Blocked, decide(null))
        assertEquals(NavigationDecision.Blocked, decide(""))
        assertEquals(NavigationDecision.Blocked, decide("   "))
        assertEquals(NavigationDecision.Blocked, decide("not a url"))
        val huge = "https://fleet.example.com/" + "x".repeat(5000)
        assertEquals(NavigationDecision.Blocked, decide(huge))
    }
}
