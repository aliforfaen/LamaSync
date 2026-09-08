package app.lamasync.companion.data

import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.network.MobileApiClient
import app.lamasync.companion.network.WebSessionBroker
import app.lamasync.companion.testutil.FakeCookieScope
import app.lamasync.companion.testutil.FakeRegistrationStore
import app.lamasync.companion.testutil.FakeTransport
import app.lamasync.companion.testutil.FakeVault
import app.lamasync.companion.testutil.cookieResponse
import app.lamasync.companion.testutil.jsonResponse
import app.lamasync.companion.testutil.sampleQr
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionRepositoryFlowTest {

    private fun repository(
        transport: FakeTransport,
        vault: FakeVault = FakeVault(),
        registrationStore: FakeRegistrationStore = FakeRegistrationStore(),
        cookieScope: FakeCookieScope = FakeCookieScope(),
        epoch: () -> Long = { 1_700_000_000_000L },
    ) = CompanionRepository(
        api = MobileApiClient(transport),
        broker = WebSessionBroker(transport),
        vault = vault,
        registrationStore = registrationStore,
        cookieScope = cookieScope,
        now = epoch,
    )

    private fun seedExchangeResponse(transport: FakeTransport) {
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/exchange",
                respond = jsonResponse(
                    200,
                    """{"hostId":"host-7","displayName":"Pixel","nativeToken":"TOKEN_1","webGrant":"GRANT_1"}""",
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
                urlContains = "/web-session",
                respond = cookieResponse(
                    "__Host-lamasync-mobile=cookie1; Path=/; Secure; HttpOnly; SameSite=Strict",
                ),
            ),
        )
    }

    @Test
    fun `successful enrollment persists secrets registration and cookie`() = runTest {
        val transport = FakeTransport()
        seedExchangeResponse(transport)
        val vault = FakeVault()
        val registrationStore = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        val repo = repository(transport, vault, registrationStore, cookieScope)

        val outcome = repo.enroll(sampleQr(), "Pixel", "0.1.0")

        assertTrue(outcome is CompanionRepository.EnrollOutcome.Success)
        val registration = (outcome as CompanionRepository.EnrollOutcome.Success).registration
        assertEquals("https://fleet.example.com", registration.origin)
        assertEquals("host-7", registration.hostId)
        assertEquals(1_700_000_000_000L, registration.enrolledAtEpochMillis)
        assertNotNull(vault.nativeToken())
        assertNotNull(vault.webGrant())
        assertEquals(cookieScope.installed, listOf("https://fleet.example.com"))
    }

    @Test
    fun `expired enrollment maps to expired failure and stores nothing`() = runTest {
        val transport = FakeTransport()
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/exchange",
                respond = jsonResponse(410, "{}"),
            ),
        )
        val vault = FakeVault()
        val registrationStore = FakeRegistrationStore()
        val repo = repository(transport, vault, registrationStore, FakeCookieScope())

        val outcome = repo.enroll(sampleQr(), "Pixel", "0.1.0")

        assertTrue(outcome is CompanionRepository.EnrollOutcome.Failure)
        val failure = outcome as CompanionRepository.EnrollOutcome.Failure
        assertEquals(CompanionRepository.EnrollStep.EXCHANGE, failure.step)
        assertTrue(failure.cause is ApiFailure.EnrollmentExpired)
        assertNull(vault.nativeToken())
        assertNull(registrationStore.load())
    }

    @Test
    fun `consumed enrollment is reported distinctly`() = runTest {
        val transport = FakeTransport()
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/exchange",
                respond = jsonResponse(409, "{}"),
            ),
        )
        val repo = repository(transport)
        val outcome = repo.enroll(sampleQr(), "Pixel", "0.1.0")
        assertTrue((outcome as CompanionRepository.EnrollOutcome.Failure).cause is ApiFailure.EnrollmentConsumed)
    }

    @Test
    fun `re-pair clears previous auth before activating the new server`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val registrationStore = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()

        // Previous pairing with server A.
        vault.saveCredentials(NativeToken.of("OLD_TOKEN"), WebGrant.of("OLD_GRANT"))
        registrationStore.save(
            Registration(
                origin = "https://old.example.com",
                hostId = "host-old",
                displayName = "Old",
                enrolledAtEpochMillis = 1L,
            ),
        )
        cookieScope.installSessionCookie("https://old.example.com", "name=oldvalue")

        // New enrollment with server B.
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/exchange",
                respond = jsonResponse(
                    200,
                    """{"hostId":"host-new","displayName":"Pixel","nativeToken":"NEW_TOKEN","webGrant":"NEW_GRANT"}""",
                ),
            ),
        )
        transport.enqueue(
            FakeTransport.Rule(
                method = "GET",
                urlContains = "/me",
                respond = jsonResponse(
                    200,
                    """{"hostId":"host-new","displayName":"Pixel","clientType":"android","appVersion":"0.1.0"}""",
                ),
            ),
        )
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/web-session",
                respond = cookieResponse("__Host-lamasync-mobile=cookieNew; Path=/; Secure; HttpOnly"),
            ),
        )
        val repo = repository(transport, vault, registrationStore, cookieScope)

        val outcome = repo.enroll(sampleQr(origin = "https://new.example.com"), "Pixel", "0.1.0")

        assertTrue(outcome is CompanionRepository.EnrollOutcome.Success)
        assertEquals("host-new", (outcome as CompanionRepository.EnrollOutcome.Success).registration.hostId)
        assertEquals("https://old.example.com", cookieScope.cleared.firstOrNull())
        assertEquals("NEW_TOKEN", vault.nativeToken()?.value)
        assertNull(vault.nativeToken()?.takeIf { it.value == "OLD_TOKEN" })
        assertFalse(registrationStore.load()?.origin?.contains("old") ?: true)
        assertTrue(cookieScope.installed.contains("https://new.example.com"))
    }

    @Test
    fun `identity failure keeps credentials for resume`() = runTest {
        val transport = FakeTransport()
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/exchange",
                respond = jsonResponse(
                    200,
                    """{"hostId":"host-7","displayName":"Pixel","nativeToken":"TOKEN_1","webGrant":"GRANT_1"}""",
                ),
            ),
        )
        transport.enqueue(
            FakeTransport.Rule(
                method = "GET",
                urlContains = "/me",
                respond = jsonResponse(401, "{}"),
            ),
        )
        val vault = FakeVault()
        val repo = repository(transport, vault = vault)

        val outcome = repo.enroll(sampleQr(), "Pixel", "0.1.0")

        assertTrue(outcome is CompanionRepository.EnrollOutcome.Failure)
        val failure = outcome as CompanionRepository.EnrollOutcome.Failure
        assertEquals(CompanionRepository.EnrollStep.IDENTITY, failure.step)
        // Credentials already persisted: resume must not re-exchange.
        assertNotNull(vault.nativeToken())

        transport.clearAll()
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
                urlContains = "/web-session",
                respond = cookieResponse("__Host-lamasync-mobile=cookie1; Path=/; Secure; HttpOnly"),
            ),
        )
        val resumed = repo.completeEnrollment("https://fleet.example.com", "0.1.0")
        assertTrue(resumed is CompanionRepository.EnrollOutcome.Success)
        // The resume path must not re-POST the exchange (would 409).
        assertTrue(transport.requests.none { it.url.contains("/exchange") })
    }

    @Test
    fun `check-in updates last seen and skips when not enrolled`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val registrationStore = FakeRegistrationStore()
        registrationStore.save(
            Registration(
                origin = "https://fleet.example.com",
                hostId = "host-7",
                displayName = "Pixel",
                enrolledAtEpochMillis = 1L,
            ),
        )
        vault.saveCredentials(NativeToken.of("TOKEN_1"), WebGrant.of("GRANT_1"))
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/check-in",
                respond = jsonResponse(200, "{}"),
            ),
        )
        val repo = repository(transport, vault, registrationStore)

        val result = repo.checkIn("0.1.0")

        assertTrue(result is CompanionRepository.CheckInOutcome.Success)
        assertEquals(1_700_000_000_000L, registrationStore.load()?.lastCheckInEpochMillis)
        assertTrue(transport.wireOf(transport.requests.single()).contains("TOKEN_1"))
        assertFalse(transport.wireOf(transport.requests.single()).contains("GRANT_1"))

        val skipped = repository(FakeTransport(), FakeVault()).checkIn("0.1.0")
        assertTrue(skipped is CompanionRepository.CheckInOutcome.Skipped)
    }

    @Test
    fun `disconnect revokes remotely then clears locally on success`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val registrationStore = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        seedRegistrationAndCredential(vault, registrationStore, cookieScope)

        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/web-session",
                respond = cookieResponse("__Host-lamasync-mobile=cookie1; Path=/; Secure; HttpOnly"),
            ),
        )
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/revoke",
                respond = jsonResponse(200, "{}"),
            ),
        )
        val repo = repository(transport, vault, registrationStore, cookieScope)

        val result = repo.disconnect()

        assertTrue(result.remoteAttempted)
        assertTrue(result.remoteSucceeded)
        assertTrue(result.localCleared)
        assertNull(vault.nativeToken())
        assertNull(registrationStore.load())
        assertEquals(listOf("https://fleet.example.com"), cookieScope.cleared)

        val revokeWire = transport.wireOf(transport.requests.last { it.url.contains("/revoke") })
        assertTrue("revoke must send the session CSRF token", revokeWire.contains("X-CSRF-Token: fake-csrf-token"))
        assertTrue("revoke must send the exact enrolled origin", revokeWire.contains("Origin: https://fleet.example.com"))
    }

    @Test
    fun `disconnect while offline always clears local data`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val registrationStore = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        seedRegistrationAndCredential(vault, registrationStore, cookieScope)

        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/web-session",
                failWith = ApiFailure.Network(ApiFailure.Network.CauseKind.CONNECT, Exception("offline")),
            ),
        )
        val repo = repository(transport, vault, registrationStore, cookieScope)

        val result = repo.disconnect()

        assertTrue(result.remoteAttempted)
        assertFalse(result.remoteSucceeded)
        assertTrue("local data must be cleared even offline", result.localCleared)
        assertNull(vault.nativeToken())
        assertNull(vault.webGrant())
        assertNull(registrationStore.load())
        assertEquals(listOf("https://fleet.example.com"), cookieScope.cleared)
    }

    @Test
    fun `disconnect without a grant clears locally without remote attempt`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val registrationStore = FakeRegistrationStore()
        registrationStore.save(
            Registration(
                origin = "https://fleet.example.com",
                hostId = "host-7",
                displayName = "Pixel",
                enrolledAtEpochMillis = 1L,
            ),
        )
        val repo = repository(transport, vault, registrationStore, FakeCookieScope())

        val result = repo.disconnect()

        assertFalse(result.remoteAttempted)
        assertTrue(result.grantInvalid)
        assertNull(registrationStore.load())
    }

    @Test
    fun `reconnect web session restores the cookie from the stored grant`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val cookieScope = FakeCookieScope()
        vault.saveCredentials(NativeToken.of("TOKEN_1"), WebGrant.of("GRANT_1"))
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/web-session",
                respond = cookieResponse("__Host-lamasync-mobile=reconnected; Path=/; Secure; HttpOnly"),
            ),
        )
        val repo = repository(transport, vault = vault, cookieScope = cookieScope)

        val outcome = repo.reconnectWebSession("https://fleet.example.com")

        assertTrue(outcome is CompanionRepository.ReconnectOutcome.Success)
        assertEquals("__Host-lamasync-mobile=reconnected", cookieScope.readSessionCookie("https://fleet.example.com"))
    }

    @Test
    fun `reconnect fails when the grant was revoked`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        vault.saveCredentials(NativeToken.of("TOKEN_1"), WebGrant.of("GRANT_REVOKED"))
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/web-session",
                respond = jsonResponse(401, "{}"),
            ),
        )
        val repo = repository(transport, vault = vault)

        val outcome = repo.reconnectWebSession("https://fleet.example.com")

        assertTrue(outcome is CompanionRepository.ReconnectOutcome.Failure)
        assertTrue((outcome as CompanionRepository.ReconnectOutcome.Failure).cause is ApiFailure.Unauthorized)
    }

    private suspend fun seedRegistrationAndCredential(
        vault: FakeVault,
        registrationStore: FakeRegistrationStore,
        cookieScope: FakeCookieScope,
    ) {
        vault.saveCredentials(NativeToken.of("TOKEN_1"), WebGrant.of("GRANT_1"))
        registrationStore.save(
            Registration(
                origin = "https://fleet.example.com",
                hostId = "host-7",
                displayName = "Pixel",
                enrolledAtEpochMillis = 1L,
            ),
        )
        cookieScope.installSessionCookie("https://fleet.example.com", "old=value")
    }
}
