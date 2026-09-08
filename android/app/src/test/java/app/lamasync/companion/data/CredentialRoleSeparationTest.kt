package app.lamasync.companion.data

import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.network.MobileApiClient
import app.lamasync.companion.network.WebSessionBroker
import app.lamasync.companion.testutil.FakeRegistrationStore
import app.lamasync.companion.testutil.FakeTransport
import app.lamasync.companion.testutil.FakeVault
import app.lamasync.companion.testutil.FakeCookieScope
import app.lamasync.companion.testutil.cookieResponse
import app.lamasync.companion.testutil.jsonResponse
import app.lamasync.companion.testutil.sampleQr
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Credential-role separation at the wire level: after a full enrollment the
 * native client requests carry the native token and never the web grant; the
 * web-session request carries the grant and never the native token. The two
 * credential types ([NativeToken] vs [WebGrant]) are non-interchangeable at
 * the type level, and the native client API simply has no parameter that
 * accepts a grant.
 */
class CredentialRoleSeparationTest {

    @Test
    fun `native requests carry the native token and never the web grant`() = runTest {
        val transport = FakeTransport()
        val api = MobileApiClient(transport)
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/exchange",
                respond = jsonResponse(
                    200,
                    """{"hostId":"host-7","displayName":"Pixel","nativeToken":"NATIVE_TOKEN_ABC","webGrant":"WEB_GRANT_XYZ"}""",
                ),
            ),
        )
        transport.enqueue(
            FakeTransport.Rule(
                method = "GET",
                urlContains = "/me",
                respond = jsonResponse(
                    200,
                    """{"hostId":"host-7","displayName":"Pixel","clientType":"android","appVersion":"0.1.0"}""",
                ),
            ),
        )
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/check-in",
                respond = jsonResponse(200, "{}"),
            ),
        )

        val origin = "https://fleet.example.com"
        val exchange = api.exchangeEnrollment(origin, "enr_1", "secret-secret-secret", "Pixel", "0.1.0")
        api.me(origin, exchange.nativeToken)
        api.checkIn(origin, exchange.nativeToken, "0.1.0")

        val nativeWires = transport.requests.filter { it.url.contains("/me") || it.url.contains("/check-in") }
        assertTrue("expected native calls", nativeWires.isNotEmpty())
        for (wire in nativeWires.map { transport.wireOf(it) }) {
            assertTrue("native call must authenticate with the native token", wire.contains("Authorization: Bearer NATIVE_TOKEN_ABC"))
            assertFalse("native call must never contain the web grant", wire.contains("WEB_GRANT_XYZ"))
        }
    }

    @Test
    fun `web session bootstrap carries the grant and never the native token`() = runTest {
        val transport = FakeTransport()
        val api = MobileApiClient(transport)
        val broker = WebSessionBroker(transport)

        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/exchange",
                respond = jsonResponse(
                    200,
                    """{"hostId":"host-7","displayName":"Pixel","nativeToken":"NATIVE_TOKEN_ABC","webGrant":"WEB_GRANT_XYZ"}""",
                ),
            ),
        )
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/web-session",
                respond = cookieResponse(
                    "__Host-lamasync-mobile=sessionValue123; Path=/; Secure; HttpOnly; SameSite=Strict",
                ),
            ),
        )

        val origin = "https://fleet.example.com"
        val exchange = api.exchangeEnrollment(origin, "enr_1", "secret-secret-secret", "Pixel", "0.1.0")
        val session = broker.bootstrapWebSession(origin, exchange.webGrant)

        assertTrue(session.cookieHeader.startsWith("__Host-lamasync-mobile=sessionValue123"))
        assertEquals("fake-csrf-token", session.csrfToken)
        val brokerRequest = transport.requests.last { it.url.contains("/web-session") }
        val brokerWire = transport.wireOf(brokerRequest)
        assertTrue("bootstrap body must carry the grant under the `grant` key", brokerWire.contains("\"grant\":\"WEB_GRANT_XYZ\""))
        assertFalse("bootstrap must not carry the native token", brokerWire.contains("NATIVE_TOKEN_ABC"))
        assertFalse("bootstrap must not use a bearer header", brokerWire.contains("Bearer"))
    }

    @Test
    fun `full repository enrollment splits credentials to the right owners`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val registrationStore = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()

        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/exchange",
                respond = jsonResponse(
                    200,
                    """{"hostId":"host-9","displayName":"Pixel 8","nativeToken":"NATIVE_TOKEN_AAA","webGrant":"WEB_GRANT_BBB"}""",
                ),
            ),
        )
        transport.enqueue(
            FakeTransport.Rule(
                method = "GET",
                urlContains = "/me",
                respond = jsonResponse(
                    200,
                    """{"hostId":"host-9","displayName":"Pixel 8","clientType":"android","appVersion":"0.1.0"}""",
                ),
            ),
        )
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/web-session",
                respond = cookieResponse(
                    "__Host-lamasync-mobile=cookieV; Path=/; Secure; HttpOnly; SameSite=Strict",
                ),
            ),
        )

        val repository = CompanionRepository(
            api = MobileApiClient(transport),
            broker = WebSessionBroker(transport),
            vault = vault,
            registrationStore = registrationStore,
            cookieScope = cookieScope,
        )

        val outcome = repository.enroll(sampleQr(), "Pixel 8", "0.1.0")
        assertTrue("expected success, got $outcome", outcome is CompanionRepository.EnrollOutcome.Success)

        assertNotNull(vault.nativeToken())
        assertNotNull(vault.webGrant())
        assertNotNull(registrationStore.load())
        assertTrue(cookieScope.installed.isNotEmpty())

        val nativeCalls = transport.requests.filter { it.url.contains("/me") }
        assertTrue(nativeCalls.isNotEmpty())
        val grantWires = transport.requests.filter { it.url.contains("/web-session") }
        assertTrue(grantWires.isNotEmpty())
        assertTrue(transport.wireOf(nativeCalls.first()).contains("NATIVE_TOKEN_AAA"))
        assertFalse(transport.wireOf(nativeCalls.first()).contains("WEB_GRANT_BBB"))
        assertFalse(transport.wireOf(grantWires.first()).contains("NATIVE_TOKEN_AAA"))
    }

    @Test
    fun `unused credentials never leave the vault`() = runTest {
        // Even when both secrets are present in the vault, a native check-in
        // leaks neither grant nor token into the cookie or web-session layer.
        val transport = FakeTransport()
        val vault = FakeVault()
        vault.saveCredentials(NativeToken.of("NATIVE_TOKEN_CCC"), WebGrant.of("WEB_GRANT_DDD"))
        val registrationStore = FakeRegistrationStore()
        registrationStore.save(
            Registration(
                origin = "https://fleet.example.com",
                hostId = "host-1",
                displayName = "Phone",
                enrolledAtEpochMillis = 1L,
            ),
        )
        val cookieScope = FakeCookieScope()
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/check-in",
                respond = jsonResponse(200, "{}"),
            ),
        )

        val repository = CompanionRepository(
            api = MobileApiClient(transport),
            broker = WebSessionBroker(transport),
            vault = vault,
            registrationStore = registrationStore,
            cookieScope = cookieScope,
        )
        repository.checkIn("0.1.0")

        val wire = transport.wireOf(transport.requests.single())
        assertTrue(wire.contains("NATIVE_TOKEN_CCC"))
        assertFalse(wire.contains("WEB_GRANT_DDD"))
        assertTrue(cookieScope.installed.isEmpty())
    }

    @Test
    fun `native client maps server errors without touching secrets`() = runTest {
        val transport = FakeTransport()
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/exchange",
                respond = jsonResponse(410, """{"error":"expired"}"""),
            ),
        )
        val api = MobileApiClient(transport)
        val failure = runCatching {
            api.exchangeEnrollment("https://fleet.example.com", "enr_1", "secret-secret-secret", "Phone", "0.1.0")
        }.exceptionOrNull()
        assertTrue(failure is ApiFailure.EnrollmentExpired)
        // No credential material may appear in any emitted request error path.
        assertTrue(transport.requests.single().body?.toString(Charsets.UTF_8).orEmpty().contains("secret"))
    }
}
