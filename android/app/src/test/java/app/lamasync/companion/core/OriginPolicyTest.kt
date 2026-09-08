package app.lamasync.companion.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginPolicyTest {

    private fun valid(input: String): String {
        val check = OriginPolicy.parseHttpsOrigin(input)
        assertTrue("expected valid origin for $input, got $check", check is OriginCheck.Valid)
        return (check as OriginCheck.Valid).origin
    }

    private fun rejected(input: String): OriginRejection {
        val check = OriginPolicy.parseHttpsOrigin(input)
        assertTrue("expected rejection for $input, got $check", check is OriginCheck.Invalid)
        return (check as OriginCheck.Invalid).reason
    }

    @Test
    fun `canonical form has no trailing slash and default port omitted`() {
        assertEquals("https://fleet.example.com", valid("https://fleet.example.com"))
        assertEquals("https://fleet.example.com", valid("https://fleet.example.com/"))
        assertEquals("https://fleet.example.com", valid("https://FLEET.Example.COM"))
        assertEquals("https://fleet.example.com", valid("https://fleet.example.com:443"))
    }

    @Test
    fun `explicit non-default port is preserved`() {
        assertEquals("https://fleet.example.com:8443", valid("https://fleet.example.com:8443"))
    }

    @Test
    fun `rejections cover the pinned origin rules`() {
        assertEquals(OriginRejection.NOT_HTTPS, rejected("http://fleet.example.com"))
        assertEquals(OriginRejection.NOT_HTTPS, rejected("ftp://fleet.example.com"))
        assertEquals(OriginRejection.HAS_USERINFO, rejected("https://user:pw@fleet.example.com"))
        assertEquals(OriginRejection.HAS_USERINFO, rejected("https://user@fleet.example.com"))
        assertEquals(OriginRejection.HAS_QUERY_OR_FRAGMENT, rejected("https://fleet.example.com?x=1"))
        assertEquals(OriginRejection.HAS_QUERY_OR_FRAGMENT, rejected("https://fleet.example.com#frag"))
        assertEquals(OriginRejection.NON_ROOT_PATH, rejected("https://fleet.example.com/x"))
        assertEquals(OriginRejection.MALFORMED, rejected("https://"))
        assertEquals(OriginRejection.MALFORMED, rejected("fleet.example.com"))
        assertEquals(OriginRejection.MALFORMED, rejected(""))
    }

    @Test
    fun `bounded length`() {
        val long = "https://" + "a".repeat(250) + ".com"
        assertEquals(OriginRejection.OVER_LENGTH, rejected(long))
        assertTrue(valid("https://" + "a".repeat(63) + ".example.com").isNotBlank())
    }

    @Test
    fun `same-origin compares scheme host and effective port`() {
        val origin = "https://fleet.example.com"
        assertTrue(OriginPolicy.isSameOrigin(origin, "https://fleet.example.com/"))
        assertTrue(OriginPolicy.isSameOrigin(origin, "https://fleet.example.com/app?x=1#y"))
        assertTrue(OriginPolicy.isSameOrigin(origin, "https://fleet.example.com:443/"))
        assertFalse(OriginPolicy.isSameOrigin(origin, "http://fleet.example.com/"))
        assertFalse(OriginPolicy.isSameOrigin(origin, "https://fleet.example.com:8443/"))
        assertFalse(OriginPolicy.isSameOrigin(origin, "https://sub.fleet.example.com/"))
        assertFalse(OriginPolicy.isSameOrigin(origin, "https://example.com/"))
        assertFalse(OriginPolicy.isSameOrigin(origin, "https://evil.example.com/"))
        assertTrue(OriginPolicy.isSameOrigin("https://host.example:8443", "https://host.example:8443/x"))
        assertFalse(OriginPolicy.isSameOrigin("https://host.example:8443", "https://host.example/"))
    }

    @Test
    fun `same-origin never matches garbage`() {
        val origin = "https://fleet.example.com"
        assertFalse(OriginPolicy.isSameOrigin(origin, ""))
        assertFalse(OriginPolicy.isSameOrigin(origin, "not a url"))
        assertFalse(OriginPolicy.isSameOrigin(origin, "javascript:alert(1)"))
        assertFalse(OriginPolicy.isSameOrigin(origin, "file:///etc/passwd"))
    }
}
