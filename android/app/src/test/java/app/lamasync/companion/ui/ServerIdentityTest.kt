package app.lamasync.companion.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * LAMA-334 item 7 — the shell header shows a server, not an endpoint.
 *
 * The origin is an authorization fact; the header is a product surface. These
 * cases pin what the user reads and what stays on the Connection screen.
 */
class ServerIdentityTest {

    @Test
    fun `the scheme and path are not part of the identity`() {
        assertEquals("lamasync.home", serverIdentity("https://lamasync.home"))
        assertEquals("lamasync.home", serverIdentity("https://lamasync.home/"))
        assertEquals("lamasync.home", serverIdentity("https://lamasync.home/api/v1"))
        assertEquals("lamasync.home", serverIdentity("http://lamasync.home"))
    }

    @Test
    fun `a default port is dropped and a non-default port is kept`() {
        assertEquals("lamasync.home", serverIdentity("https://lamasync.home:443"))
        assertEquals("lamasync.home:8443", serverIdentity("https://lamasync.home:8443/"))
        assertEquals("192.168.1.5", serverIdentity("http://192.168.1.5:80"))
        assertEquals("192.168.1.5:8080", serverIdentity("http://192.168.1.5:8080"))
    }

    @Test
    fun `an ipv6 literal survives`() {
        assertEquals("[fd00::1]:8443", serverIdentity("https://[fd00::1]:8443"))
        assertEquals("[fd00::1]", serverIdentity("https://[fd00::1]:443"))
    }

    @Test
    fun `the tailnet magic dns name is shown as-is`() {
        assertEquals(
            "lamasync.tailnet-example.ts.net",
            serverIdentity("https://lamasync.tailnet-example.ts.net/#/data?kind=s3"),
        )
    }

    @Test
    fun `an absent origin says so instead of rendering an empty header`() {
        assertEquals("not paired", serverIdentity(null))
        assertEquals("not paired", serverIdentity(""))
        assertEquals("not paired", serverIdentity("   "))
    }
}
