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
import app.lamasync.companion.testutil.sampleQrWith
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regressions for the enrollment-binding invariant (review finding 1) and the
 * disconnect session pairing / cleanup reporting (findings 2 and 3, plus the
 * correction-round R2) at the repository layer. These enforce the rules
 * independent of ViewModel checks: stored credentials are bound to one
 * (origin, enrollmentId) and may never be sent to a different server, and a
 * re-pair must not start a new exchange (or drop the previous pairing's
 * cleanup state) while the old web-session cookie removal is unconfirmed.
 */
class EnrollmentInvariantRegressionTest {

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

    private fun exchangeResponse(hostId: String, token: String, grant: String) =
        FakeTransport.Rule(
            method = "POST",
            urlContains = "/exchange",
            respond = jsonResponse(
                200,
                """{"hostId":"$hostId","displayName":"Pixel","nativeToken":"$token","webGrant":"$grant"}""",
            ),
        )

    private fun meResponse(hostId: String, displayName: String, status: Int = 200) =
        FakeTransport.Rule(
            method = "GET",
            urlContains = "/me",
            respond = jsonResponse(
                status,
                """{"hostId":"$hostId","displayName":"$displayName","clientType":"android","appVersion":"0.1.0"}""",
            ),
        )

    private fun webSessionRule(cookie: String, csrf: String = "fake-csrf-token") =
        FakeTransport.Rule(
            method = "POST",
            urlContains = "/web-session",
            respond = cookieResponse(cookie, csrf),
        )

    // ------------------------------------------------------------------
    // Finding 1 — interrupted enrollment credentials stay bound to origin A
    // ------------------------------------------------------------------

    @Test
    fun `interrupted enrollment credentials never reach a different origin`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        val repo = repository(transport, vault, store, cookieScope)

        // Exchange on A succeeds; the identity probe fails. The vault now
        // holds A credentials with a binding at EXCHANGED.
        transport.enqueue(exchangeResponse("host-a", "TOKEN_A", "GRANT_A"))
        transport.enqueue(meResponse("host-a", "Pixel", status = 401))
        val first = repo.enroll(sampleQrWith("https://fleet-a.example.com", "enr_A"), "Pixel", "0.1.0")
        assertTrue((first as CompanionRepository.EnrollOutcome.Failure).step == CompanionRepository.EnrollStep.IDENTITY)
        assertEquals("TOKEN_A", vault.nativeToken()?.value)
        assertEquals("https://fleet-a.example.com", store.loadBinding()?.origin)

        // User scans origin B. The A state (and credentials) must be replaced
        // and B must perform its own exchange — no A credential may appear in
        // any request to B.
        transport.enqueue(exchangeResponse("host-b", "TOKEN_B", "GRANT_B"))
        transport.enqueue(meResponse("host-b", "Pixel"))
        transport.enqueue(webSessionRule("__Host-lamasync-mobile=cookieB; Path=/; Secure; HttpOnly"))

        val second = repo.enroll(sampleQrWith("https://fleet-b.example.com", "enr_B"), "Pixel", "0.1.0")

        assertTrue("expected success for B, got $second", second is CompanionRepository.EnrollOutcome.Success)
        assertEquals("host-b", (second as CompanionRepository.EnrollOutcome.Success).registration.hostId)
        assertEquals("https://fleet-b.example.com", store.loadBinding()?.origin)
        assertEquals("TOKEN_B", vault.nativeToken()?.value)
        assertNull("A's native token must be wiped before B activated", vault.nativeToken()?.takeIf { it.value == "TOKEN_A" })

        val bRequests = transport.requests.filter { it.url.contains("fleet-b.example.com") }
        assertTrue("expected requests to B", bRequests.isNotEmpty())
        for (wire in bRequests.map { transport.wireOf(it) }) {
            assertFalse("A native token must never appear in a request to B: $wire", wire.contains("TOKEN_A"))
            assertFalse("A web grant must never appear in a request to B: $wire", wire.contains("GRANT_A"))
        }
        // A's exchange ran exactly once and B's exchange ran exactly once.
        assertEquals(2, transport.requests.count { it.url.contains("/exchange") })
        // B's native identity probe authenticates with B's own token.
        val meB = bRequests.single { it.url.contains("/me") }
        assertTrue(transport.wireOf(meB).contains("Authorization: Bearer TOKEN_B"))
    }

    @Test
    fun `same enrollment resumes after process death without re-exchange`() = runTest {
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()

        // Attempt 1 (process 1): exchange succeeds, identity probe fails.
        val transport1 = FakeTransport()
        transport1.enqueue(exchangeResponse("host-a", "TOKEN_A", "GRANT_A"))
        transport1.enqueue(meResponse("host-a", "Pixel", status = 401))
        val repo1 = repository(transport1, vault, store, cookieScope)
        val first = repo1.enroll(sampleQrWith("https://fleet-a.example.com", "enr_A"), "Pixel", "0.1.0")
        assertTrue((first as CompanionRepository.EnrollOutcome.Failure).step == CompanionRepository.EnrollStep.IDENTITY)

        // "Process death": a brand-new repository over the SAME persisted
        // stores. Re-scanning the same QR must resume, not re-exchange.
        val transport2 = FakeTransport()
        transport2.enqueue(meResponse("host-a", "Pixel"))
        transport2.enqueue(webSessionRule("__Host-lamasync-mobile=cookieA; Path=/; Secure; HttpOnly"))
        val repo2 = repository(transport2, vault, store, cookieScope)

        val resumed = repo2.enroll(sampleQrWith("https://fleet-a.example.com", "enr_A"), "Pixel", "0.1.0")

        assertTrue("expected resume success, got $resumed", resumed is CompanionRepository.EnrollOutcome.Success)
        assertEquals("https://fleet-a.example.com", (resumed as CompanionRepository.EnrollOutcome.Success).registration.origin)
        assertTrue("resume must not re-exchange the consumed QR", transport2.requests.none { it.url.contains("/exchange") })
        assertEquals(1, transport2.requests.count { it.url.contains("/me") })
        assertEquals(1, transport2.requests.count { it.url.contains("/web-session") })
        // Same-enrollment recovery keeps the persisted credentials untouched.
        assertEquals("TOKEN_A", vault.nativeToken()?.value)
        assertEquals("GRANT_A", vault.webGrant()?.value)
        assertEquals(EnrollmentStage.REGISTERED, store.loadBinding()?.stage)
    }

    @Test
    fun `completeEnrollment refuses an origin that does not match the binding`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val repo = repository(transport, vault, store)

        transport.enqueue(exchangeResponse("host-a", "TOKEN_A", "GRANT_A"))
        transport.enqueue(meResponse("host-a", "Pixel", status = 401))
        val first = repo.enroll(sampleQrWith("https://fleet-a.example.com", "enr_A"), "Pixel", "0.1.0")
        assertTrue((first as CompanionRepository.EnrollOutcome.Failure).step == CompanionRepository.EnrollStep.IDENTITY)

        // Resume for an origin that is NOT the bound one must refuse without
        // emitting any request carrying A's credentials.
        val outcome = repo.completeEnrollment("https://fleet-c.example.com", "0.1.0")

        assertTrue(outcome is CompanionRepository.EnrollOutcome.Failure)
        assertEquals(
            CompanionRepository.EnrollStep.IDENTITY,
            (outcome as CompanionRepository.EnrollOutcome.Failure).step,
        )
        assertTrue(
            "refused resume must not touch the network",
            transport.requests.none { it.url.contains("fleet-c.example.com") },
        )
    }

    // ------------------------------------------------------------------
    // Finding 2 — disconnect revoke uses the same fresh session for cookie+CSRF
    // ------------------------------------------------------------------

    private fun seedRegistrationAndCredential(
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
    }

    @Test
    fun `disconnect revoke sends the fresh bootstrap cookie and csrf even with a stale cookie present`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        seedRegistrationAndCredential(vault, store, cookieScope)
        // CookieManager still holds the stale cookie from an earlier session.
        cookieScope.installSessionCookie("https://fleet.example.com", "old=staleSessionA")

        transport.enqueue(webSessionRule("__Host-lamasync-mobile=freshSessionB; Path=/; Secure; HttpOnly", csrf = "csrf-fresh-B"))
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/revoke",
                respond = jsonResponse(200, "{}"),
            ),
        )
        val repo = repository(transport, vault, store, cookieScope)

        val result = repo.disconnect()

        assertTrue("revoke must succeed when cookie+CSRF come from the same bootstrap", result.remoteSucceeded)
        assertTrue(result.localCleared)
        val revokeWire = transport.wireOf(transport.requests.last { it.url.contains("/revoke") })
        assertTrue(
            "revoke must present the fresh bootstrap cookie, not the stale CookieManager one",
            revokeWire.contains("Cookie: __Host-lamasync-mobile=freshSessionB"),
        )
        assertFalse("stale session cookie must never be sent", revokeWire.contains("old=staleSessionA"))
        assertTrue(
            "revoke must present the CSRF from the same fresh bootstrap",
            revokeWire.contains("X-CSRF-Token: csrf-fresh-B"),
        )
    }

    @Test
    fun `disconnect revoke works when CookieManager holds no previous cookie`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        seedRegistrationAndCredential(vault, store, cookieScope)
        // No pre-existing cookie at all (fresh install, session expired).

        transport.enqueue(webSessionRule("__Host-lamasync-mobile=freshSessionB; Path=/; Secure; HttpOnly", csrf = "csrf-fresh-B"))
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/revoke",
                respond = jsonResponse(200, "{}"),
            ),
        )
        val repo = repository(transport, vault, store, cookieScope)

        val result = repo.disconnect()

        assertTrue("revoke with no old cookie must still succeed", result.remoteSucceeded)
        assertTrue(result.localCleared)
        val revokeWire = transport.wireOf(transport.requests.last { it.url.contains("/revoke") })
        assertTrue(revokeWire.contains("Cookie: __Host-lamasync-mobile=freshSessionB"))
        assertTrue(revokeWire.contains("X-CSRF-Token: csrf-fresh-B"))
    }

    // ------------------------------------------------------------------
    // Finding 3 — local cleanup reports honestly
    // ------------------------------------------------------------------

    @Test
    fun `disconnect reports localCleared false when cookie removal is not confirmed`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        seedRegistrationAndCredential(vault, store, cookieScope)
        cookieScope.failClear = true

        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/web-session",
                failWith = ApiFailure.Network(ApiFailure.Network.CauseKind.CONNECT, Exception("offline")),
            ),
        )
        val repo = repository(transport, vault, store, cookieScope)

        val result = repo.disconnect()

        assertFalse(result.remoteSucceeded)
        assertTrue("the expiry must still be attempted", cookieScope.cleared.contains("https://fleet.example.com"))
        assertFalse("localCleared must reflect the unconfirmed removal", result.localCleared)
        // Other teardown steps still run even when the cookie removal failed.
        assertNull(vault.nativeToken())
        assertNull(store.load())
    }

    @Test
    fun `enrollment reports failure when the platform rejects the session cookie`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        cookieScope.rejectInstall = true

        transport.enqueue(exchangeResponse("host-7", "TOKEN_1", "GRANT_1"))
        transport.enqueue(meResponse("host-7", "Pixel"))
        transport.enqueue(webSessionRule("__Host-lamasync-mobile=cookie1; Path=/; Secure; HttpOnly"))
        val repo = repository(transport, vault, store, cookieScope)

        val outcome = repo.enroll(sampleQrWith("https://fleet.example.com", "enr_1"), "Pixel", "0.1.0")

        assertTrue(outcome is CompanionRepository.EnrollOutcome.Failure)
        assertEquals(
            CompanionRepository.EnrollStep.WEB_SESSION,
            (outcome as CompanionRepository.EnrollOutcome.Failure).step,
        )
        // Credentials + registration survive so the Retry can re-bootstrap
        // without re-exchanging.
        assertNotNull(vault.nativeToken())
        assertNotNull(store.load())
        assertNotNull(store.loadBinding())
    }

    // ------------------------------------------------------------------
    // R2 — cleanup failure must gate re-pairing and stay retryable
    // ------------------------------------------------------------------

    private suspend fun seedPairingWithCookie(
        vault: FakeVault,
        store: FakeRegistrationStore,
        cookieScope: FakeCookieScope,
    ) {
        seedRegistrationAndCredential(vault, store, cookieScope)
        cookieScope.installSessionCookie("https://fleet.example.com", "old=value")
    }

    private fun assertCleanupGate(outcome: CompanionRepository.EnrollOutcome) {
        assertTrue("expected CLEANUP failure, got $outcome", outcome is CompanionRepository.EnrollOutcome.Failure)
        val failure = outcome as CompanionRepository.EnrollOutcome.Failure
        assertEquals(CompanionRepository.EnrollStep.CLEANUP, failure.step)
        assertTrue(failure.cause is CompanionRepository.LocalCleanupUnconfirmed)
        assertEquals(
            listOf("https://fleet.example.com"),
            (failure.cause as CompanionRepository.LocalCleanupUnconfirmed).unconfirmedOrigins,
        )
    }

    @Test
    fun `re-pair with unconfirmed cookie removal refuses the new exchange and keeps A intact`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        seedPairingWithCookie(vault, store, cookieScope)
        cookieScope.failClear = true
        val repo = repository(transport, vault, store, cookieScope)

        val outcome = repo.enroll(sampleQrWith("https://new.example.com", "enr_B"), "Pixel", "0.1.0")

        assertCleanupGate(outcome)
        assertTrue("B's exchange must not start", transport.requests.none { it.url.contains("/exchange") })
        assertTrue("no request reached the new origin",
            transport.requests.none { it.url.contains("new.example.com") })
        // A's pairing records and cookie survive so cleanup can be retried.
        assertNotNull(store.load())
        assertEquals("TOKEN_1", vault.nativeToken()?.value)
        assertNotNull(cookieScope.readSessionCookie("https://fleet.example.com"))
        assertEquals("removal was attempted and reported", listOf("https://fleet.example.com"), cookieScope.cleared)
    }

    @Test
    fun `re-pair with throwing cookie removal refuses the new exchange`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        seedPairingWithCookie(vault, store, cookieScope)
        cookieScope.throwOnClear = Exception("platform cookie manager failed")
        val repo = repository(transport, vault, store, cookieScope)

        val outcome = repo.enroll(sampleQrWith("https://new.example.com", "enr_B"), "Pixel", "0.1.0")

        assertCleanupGate(outcome)
        assertTrue(transport.requests.none { it.url.contains("/exchange") })
        assertNotNull("A survives the throwing adapter", store.load())
        assertEquals("TOKEN_1", vault.nativeToken()?.value)
    }

    @Test
    fun `re-pair proceeds only once the previous cookie removal is confirmed`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        seedPairingWithCookie(vault, store, cookieScope)
        cookieScope.failClear = true
        val repo = repository(transport, vault, store, cookieScope)

        val gated = repo.enroll(sampleQrWith("https://new.example.com", "enr_B"), "Pixel", "0.1.0")
        assertCleanupGate(gated)
        assertEquals("TOKEN_1", vault.nativeToken()?.value)

        // Cookie removal becomes confirmable; the same confirm proceeds.
        cookieScope.failClear = false
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
        transport.enqueue(meResponse("host-new", "Pixel"))
        transport.enqueue(webSessionRule("__Host-lamasync-mobile=cookieNew; Path=/; Secure; HttpOnly"))
        val outcome = repo.enroll(sampleQrWith("https://new.example.com", "enr_B"), "Pixel", "0.1.0")

        assertTrue("expected success on the retry, got $outcome", outcome is CompanionRepository.EnrollOutcome.Success)
        assertEquals("host-new", (outcome as CompanionRepository.EnrollOutcome.Success).registration.hostId)
        assertEquals("https://new.example.com", store.loadBinding()?.origin)
        assertEquals("NEW_TOKEN", vault.nativeToken()?.value)
        assertNull("A's cookie was removed before B activated",
            cookieScope.readSessionCookie("https://fleet.example.com"))
        assertEquals("exactly one exchange with B after the gate", 1,
            transport.requests.count { it.url.contains("/exchange") })
    }

    @Test
    fun `disconnect persists unconfirmed cookie origins and retryLocalCleanup clears them`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        seedPairingWithCookie(vault, store, cookieScope)
        cookieScope.failClear = true
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/web-session",
                failWith = ApiFailure.Network(ApiFailure.Network.CauseKind.CONNECT, Exception("offline")),
            ),
        )
        val repo = repository(transport, vault, store, cookieScope)

        val result = repo.disconnect()

        assertFalse(result.remoteSucceeded)
        assertFalse("cleanup is honestly reported as unconfirmed", result.localCleared)
        assertEquals(listOf("https://fleet.example.com"), result.unconfirmedCookieOrigins)
        // The registration/binding were wiped, but the non-secret origin marker
        // is retained so a later launch can still offer the cleanup retry.
        assertNull(store.load())
        assertEquals(listOf("https://fleet.example.com"), store.loadCleanupPending())

        cookieScope.failClear = false
        val retry = repo.retryLocalCleanup(listOf("https://fleet.example.com"))
        assertTrue("cleanup retry clears the cookie", retry.cleared)
        assertNull(cookieScope.readSessionCookie("https://fleet.example.com"))
        assertTrue("marker is cleared after a confirmed retry", store.loadCleanupPending().isEmpty())
    }

    // ------------------------------------------------------------------
    // Finding 5 (repository half) — bootstrap failure resumes from REGISTERED
    // ------------------------------------------------------------------

    @Test
    fun `bootstrap failure keeps registration and resume preserves display name and credential`() = runTest {
        val transport = FakeTransport()
        val vault = FakeVault()
        val store = FakeRegistrationStore()
        val cookieScope = FakeCookieScope()
        val repo = repository(transport, vault, store, cookieScope)

        // Exchange + identity succeed; the bootstrap fails once.
        transport.enqueue(exchangeResponse("host-7", "TOKEN_1", "GRANT_1"))
        transport.enqueue(meResponse("host-7", "")) // blank server display name -> requested name kept
        transport.enqueue(
            FakeTransport.Rule(
                method = "POST",
                urlContains = "/web-session",
                failWith = ApiFailure.Network(ApiFailure.Network.CauseKind.CONNECT, Exception("offline")),
            ),
        )
        val first = repo.enroll(sampleQrWith("https://fleet.example.com", "enr_1"), "Pixel 8", "0.1.0")
        assertTrue((first as CompanionRepository.EnrollOutcome.Failure).step == CompanionRepository.EnrollStep.WEB_SESSION)

        // Registration was saved with the requested display name; the resume
        // stage is REGISTERED.
        val registration = store.load()
        assertNotNull(registration)
        assertEquals("Pixel 8", registration?.displayName)
        assertEquals(EnrollmentStage.REGISTERED, store.loadBinding()?.stage)
        assertEquals(1_700_000_000_000L, registration?.enrolledAtEpochMillis)

        // Retry: re-bootstrap from the saved grant only.
        transport.enqueue(webSessionRule("__Host-lamasync-mobile=cookie1; Path=/; Secure; HttpOnly"))
        val resumed = repo.completeEnrollment("https://fleet.example.com", "0.1.0")

        assertTrue("expected success, got $resumed", resumed is CompanionRepository.EnrollOutcome.Success)
        assertEquals("https://fleet.example.com", (resumed as CompanionRepository.EnrollOutcome.Success).registration.origin)
        // Exactly one exchange and exactly one identity probe across the whole flow.
        assertEquals(1, transport.requests.count { it.url.contains("/exchange") })
        assertEquals(1, transport.requests.count { it.url.contains("/me") })
        assertEquals(2, transport.requests.count { it.url.contains("/web-session") })
        // Credentials and the display name are untouched by the retry.
        assertEquals("TOKEN_1", vault.nativeToken()?.value)
        assertEquals("Pixel 8", store.load()?.displayName)
        assertEquals(1_700_000_000_000L, store.load()?.enrolledAtEpochMillis)
    }
}
