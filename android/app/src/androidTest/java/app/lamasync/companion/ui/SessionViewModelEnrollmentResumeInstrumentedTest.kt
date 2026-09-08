package app.lamasync.companion.ui

import android.app.Application
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.data.CompanionRepository
import app.lamasync.companion.data.EnrollmentBinding
import app.lamasync.companion.data.EnrollmentStage
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.RegistrationStore
import app.lamasync.companion.data.RegistrationStoreImpl
import app.lamasync.companion.data.SecureCredentialVault
import app.lamasync.companion.data.WebGrant
import app.lamasync.companion.network.HttpRequest
import app.lamasync.companion.network.HttpResponse
import app.lamasync.companion.network.HttpTransport
import app.lamasync.companion.network.MobileApiClient
import app.lamasync.companion.network.WebSessionBroker
import app.lamasync.companion.web.WebCookieScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * ViewModel state-transition regressions on a real device with fakes injected
 * through the SessionViewModel test seam (review findings 1 and 5, plus the
 * correction-round R1 and R2). These drive the actual state machine
 * (confirmEnrollment/retryEnrollment/resumePendingEnrollment/disconnect/
 * retryCleanup), not just repository calls:
 *
 *  - finding 5: after exchange+identity succeed and the bootstrap fails once,
 *    the UI Retry must resume from the REGISTERED stage — re-bootstrapping
 *    from the saved grant with exactly one exchange and an unchanged native
 *    credential.
 *  - finding 1: after an interrupted enrollment at origin A, scanning origin B
 *    must run B's own exchange — no A credential may reach B.
 *  - R1: a restart between exchange and registration must surface a visible
 *    pending-enrollment recovery (bound origin + chosen display name) whose
 *    resume needs no QR and no new exchange; missing credentials and
 *    completed-enrollment-after-web-logout must NOT show a phantom resume or
 *    auto re-bootstrap.
 *  - R2: disconnect renders local and remote outcomes independently, never
 *    claims local success when cleanup is unconfirmed, retains the origin for
 *    a cleanup retry, and re-pairing A→B must not silently proceed (or drop
 *    A's cleanup state) while A's cookie removal is unconfirmed.
 */
@RunWith(AndroidJUnit4::class)
class SessionViewModelEnrollmentResumeInstrumentedTest {

    private lateinit var app: Application

    @Before
    fun setUp() {
        app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        // Leave no real registration/vault state behind for sibling tests.
        KeystoreCredentialVault(app).clear()
        RegistrationStoreImpl(app).clear()
    }

    // ---------------------------------------------------------------- fakes

    private class Rule(
        val method: String,
        val urlContains: String,
        val respond: HttpResponse? = null,
        val failWith: ApiFailure? = null,
    )

    private class ScriptedTransport : HttpTransport {
        val requests = mutableListOf<HttpRequest>()
        private val rules = mutableListOf<Rule>()

        fun enqueue(rule: Rule) {
            rules += rule
        }

        override suspend fun execute(request: HttpRequest): HttpResponse {
            requests += request
            val index = rules.indexOfFirst {
                it.method == request.method && request.url.contains(it.urlContains)
            }
            if (index < 0) error("no rule for ${request.method} ${request.url}")
            val rule = rules.removeAt(index)
            rule.failWith?.let { throw it }
            return rule.respond ?: error("rule without response")
        }
    }

    private class MemVault : SecureCredentialVault {
        var native: NativeToken? = null
        var grant: WebGrant? = null
        var cleared = false

        override fun saveCredentials(nativeToken: NativeToken, webGrant: WebGrant) {
            native = nativeToken
            grant = webGrant
        }

        override fun nativeToken(): NativeToken? = native
        override fun webGrant(): WebGrant? = grant
        override fun hasCredentials(): Boolean = native != null

        override fun clear() {
            native = null
            grant = null
            cleared = true
        }
    }

    private class MemStore : RegistrationStore {
        var registration: Registration? = null
        var binding: EnrollmentBinding? = null
        var cleanupPending: List<String> = emptyList()

        override fun load(): Registration? = registration
        override fun save(registration: Registration) {
            this.registration = registration
        }

        override fun updateCheckIn(registration: Registration, epochMillis: Long, appVersion: String) {
            save(registration.copy(lastCheckInEpochMillis = epochMillis, lastCheckInAppVersion = appVersion))
        }

        override fun loadBinding(): EnrollmentBinding? = binding
        override fun saveBinding(binding: EnrollmentBinding) {
            this.binding = binding
        }

        override fun loadCleanupPending(): List<String> = cleanupPending
        override fun saveCleanupPending(origins: List<String>) {
            cleanupPending = origins
        }

        override fun clearCleanupPending() {
            cleanupPending = emptyList()
        }

        override fun clear() {
            registration = null
            binding = null
            cleanupPending = emptyList()
        }
    }

    private class MemCookieScope : WebCookieScope {
        private val cookies = mutableMapOf<String, String>()

        /** When true, [clearSessionCookie] reports failure and keeps the cookie. */
        var failClear = false

        /** When set, [clearSessionCookie] throws instead of clearing. */
        var throwOnClear: Exception? = null

        override suspend fun installSessionCookie(origin: String, setCookieHeader: String): Boolean {
            cookies[origin] = WebSessionBroker.cookiePair(setCookieHeader)
            return true
        }

        override fun readSessionCookie(origin: String): String? = cookies[origin]

        override suspend fun clearSessionCookie(origin: String): Boolean {
            throwOnClear?.let { throw it }
            if (failClear) return false
            cookies.remove(origin)
            return true
        }

        fun hasCookie(origin: String): Boolean = cookies.containsKey(origin)

        /** Synchronous seeding (the interface method is suspend). */
        fun seedCookie(origin: String) {
            cookies[origin] = "seeded-value"
        }
    }

    private fun json(status: Int, body: String): HttpResponse = HttpResponse(
        status = status,
        headers = mapOf("content-type" to listOf("application/json; charset=utf-8")),
        bodyText = body,
        finalUrl = "",
    )

    private fun cookie(status: Int = 200, cookie: String, csrf: String = "fake-csrf-token"): HttpResponse =
        HttpResponse(
            status = status,
            headers = mapOf("set-cookie" to listOf(cookie)),
            bodyText = """{"csrfToken":"$csrf"}""",
            finalUrl = "",
        )

    // ---------------------------------------------------------------- helpers

    private fun qrJson(origin: String, enrollmentId: String): String = """
        {"kind":"lamasync.android.enroll","version":1,"serverOrigin":"$origin",
         "enrollmentId":"$enrollmentId",
         "secret":"aBcD1234567890aBcD1234567890aBcD1234567890aBcD1234567890"}
    """.trimIndent()

    private fun harness(): Triple<ScriptedTransport, MemVault, MemStore> {
        val transport = ScriptedTransport()
        val vault = MemVault()
        val store = MemStore()
        val cookieScope = MemCookieScope()
        val repo = CompanionRepository(
            api = MobileApiClient(transport),
            broker = WebSessionBroker(transport),
            vault = vault,
            registrationStore = store,
            cookieScope = cookieScope,
        )
        harnessRepo = repo
        harnessTransport = transport
        harnessVault = vault
        harnessStore = store
        harnessCookieScope = cookieScope
        return Triple(transport, vault, store)
    }

    private lateinit var harnessRepo: CompanionRepository
    private lateinit var harnessTransport: ScriptedTransport
    private lateinit var harnessVault: MemVault
    private lateinit var harnessStore: MemStore
    private lateinit var harnessCookieScope: MemCookieScope

    private fun newViewModel(): SessionViewModel = SessionViewModel(app, harnessRepo)

    /**
     * Seeds a fully completed pairing at [origin]/[hostId]: registration +
     * REGISTERED binding + usable secrets + an installed session cookie. This
     * is the state a disconnect or a re-pair starts from.
     */
    private fun seedCompletedPairing(
        origin: String,
        hostId: String,
        token: String,
        grant: String,
        enrollmentId: String = "enr_AbC123",
        displayName: String = "Pixel",
        installCookie: Boolean = true,
    ) {
        harnessVault.saveCredentials(NativeToken.of(token), WebGrant.of(grant))
        harnessStore.save(
            Registration(
                origin = origin,
                hostId = hostId,
                displayName = displayName,
                enrolledAtEpochMillis = 1L,
            ),
        )
        harnessStore.saveBinding(
            EnrollmentBinding(
                origin = origin,
                enrollmentId = enrollmentId,
                hostId = hostId,
                displayName = displayName,
                stage = EnrollmentStage.REGISTERED,
            ),
        )
        if (installCookie) {
            harnessCookieScope.seedCookie(origin)
        }
    }

    private fun webSessionRule(
        cookieName: String = "__Host-lamasync-mobile=session; Path=/; Secure; HttpOnly",
        failWith: ApiFailure? = null,
    ) = Rule(method = "POST", urlContains = "/web-session", respond = cookie(cookie = cookieName), failWith = failWith)

    private fun SessionViewModel.awaitState(
        timeoutMillis: Long = 15_000,
        predicate: (UiState) -> Boolean,
    ) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < deadline) {
            instrumentation.waitForIdleSync()
            if (predicate(ui.value)) return
            SystemClock.sleep(100)
        }
        fail("Timed out waiting for ViewModel state; last state=${ui.value}")
    }

    private fun exchangeRule(hostId: String, token: String, grant: String) = Rule(
        method = "POST",
        urlContains = "/exchange",
        respond = json(
            200,
            """{"hostId":"$hostId","displayName":"Pixel","nativeToken":"$token","webGrant":"$grant"}""",
        ),
    )

    private fun meRule(hostId: String, displayName: String = "Pixel", status: Int = 200) = Rule(
        method = "GET",
        urlContains = "/me",
        respond = json(
            status,
            """{"hostId":"$hostId","displayName":"$displayName","clientType":"android","appVersion":"0.1.0"}""",
        ),
    )

    // ---------------------------------------------------------------- tests

    @Test
    fun retryAfterBootstrapFailureResumesWithoutReExchange() {
        harness()
        harnessTransport.enqueue(exchangeRule("host-7", "TOKEN_1", "GRANT_1"))
        harnessTransport.enqueue(meRule("host-7", "Pixel"))
        harnessTransport.enqueue(
            Rule(
                method = "POST",
                urlContains = "/web-session",
                failWith = ApiFailure.Network(ApiFailure.Network.CauseKind.CONNECT, Exception("offline")),
            ),
        )

        val vm = newViewModel()
        vm.onQrScanned(qrJson("https://fleet.example.com", "enr_AbC123"))
        assertEquals(Screen.CONFIRM, vm.ui.value.screen)

        vm.confirmEnrollment("Pixel")
        vm.awaitState { it.screen == Screen.CONFIRM && !it.busy }
        assertTrue("exchange+identity done, bootstrap failed -> resumable", vm.ui.value.pendingResume)
        assertEquals("exchange ran once before the bootstrap failure", 1,
            harnessTransport.requests.count { it.url.contains("/exchange") })
        assertEquals("identity probed once before the bootstrap failure", 1,
            harnessTransport.requests.count { it.url.contains("/me") })
        assertEquals("first bootstrap attempt failed", 1,
            harnessTransport.requests.count { it.url.contains("/web-session") })
        assertNotNull("registration must already be saved", harnessStore.registration)
        assertEquals(EnrollmentStage.REGISTERED, harnessStore.binding?.stage)

        // UI Retry: re-bootstrap only.
        harnessTransport.enqueue(
            Rule(
                method = "POST",
                urlContains = "/web-session",
                respond = cookie(cookie = "__Host-lamasync-mobile=cookie1; Path=/; Secure; HttpOnly"),
            ),
        )
        harnessTransport.enqueue(
            Rule(method = "POST", urlContains = "/check-in", respond = json(200, "{}")),
        )
        vm.retryEnrollment()
        vm.awaitState { it.screen == Screen.MANAGE && it.checkInOk == true }

        assertEquals("MANAGE screen must show the restored session", true, vm.ui.value.webSessionConnected)
        assertEquals("exactly one exchange across the whole retried flow", 1,
            harnessTransport.requests.count { it.url.contains("/exchange") })
        assertEquals("identity was not re-probed on REGISTERED resume", 1,
            harnessTransport.requests.count { it.url.contains("/me") })
        assertEquals("bootstrap attempted twice (failed + retried)", 2,
            harnessTransport.requests.count { it.url.contains("/web-session") })
        // Native credential and display name survive the retry untouched.
        assertEquals("TOKEN_1", harnessVault.native?.value)
        assertEquals("Pixel", vm.ui.value.registration?.displayName)
    }

    @Test
    fun scanningDifferentOriginAfterInterruptedEnrollmentRunsItsOwnExchange() {
        harness()
        // Origin A: exchange succeeds, identity probe fails.
        harnessTransport.enqueue(exchangeRule("host-a", "TOKEN_A", "GRANT_A"))
        harnessTransport.enqueue(meRule("host-a", "Pixel", status = 401))

        val vm = newViewModel()
        vm.onQrScanned(qrJson("https://fleet-a.example.com", "enr_A"))
        vm.confirmEnrollment("Pixel")
        vm.awaitState { it.screen == Screen.CONFIRM && !it.busy }
        assertTrue(vm.ui.value.pendingResume)
        assertEquals("TOKEN_A", harnessVault.native?.value)

        // Back out and scan origin B.
        vm.onConfirmBack()
        assertEquals(Screen.SCANNER, vm.ui.value.screen)
        vm.onQrScanned(qrJson("https://fleet-b.example.com", "enr_B"))
        assertEquals(Screen.CONFIRM, vm.ui.value.screen)
        assertFalse("B must not be offered as a resume of A's binding", vm.ui.value.pendingResume)

        harnessTransport.enqueue(exchangeRule("host-b", "TOKEN_B", "GRANT_B"))
        harnessTransport.enqueue(meRule("host-b", "Pixel"))
        harnessTransport.enqueue(
            Rule(
                method = "POST",
                urlContains = "/web-session",
                respond = cookie(cookie = "__Host-lamasync-mobile=cookieB; Path=/; Secure; HttpOnly"),
            ),
        )
        harnessTransport.enqueue(
            Rule(method = "POST", urlContains = "/check-in", respond = json(200, "{}")),
        )
        vm.confirmEnrollment("Pixel")
        vm.awaitState { it.screen == Screen.MANAGE && it.checkInOk == true }

        assertEquals("https://fleet-b.example.com", vm.ui.value.registration?.origin)
        assertEquals("TOKEN_B", harnessVault.native?.value)
        assertEquals("https://fleet-b.example.com", harnessStore.binding?.origin)

        val bRequests = harnessTransport.requests.filter { it.url.contains("fleet-b.example.com") }
        assertTrue("expected requests to B", bRequests.isNotEmpty())
        for (wire in bRequests.map { transportWire(it) }) {
            assertFalse("A native token must never reach B", wire.contains("TOKEN_A"))
            assertFalse("A web grant must never reach B", wire.contains("GRANT_A"))
        }
        val meB = bRequests.single { it.url.contains("/me") }
        assertTrue("B identity probe authenticates with B's own token", transportWire(meB).contains("TOKEN_B"))
    }

    // ------------------------------------------------------------------
    // R1 — pending-enrollment recovery after a restart before identity completes
    // ------------------------------------------------------------------

    @Test
    fun startupAfterExchangeBeforeIdentityOffersRecoveryAndResumesWithoutQrOrExchange() {
        harness()
        // The app died after EXCHANGED binding + credentials, before the
        // identity probe could save a registration (R1 reproduction).
        harnessVault.saveCredentials(NativeToken.of("TOKEN_A"), WebGrant.of("GRANT_A"))
        harnessStore.saveBinding(
            EnrollmentBinding(
                origin = "https://fleet-a.example.com",
                enrollmentId = "enr_A",
                hostId = "host-a",
                displayName = "Pixel 9",
                stage = EnrollmentStage.EXCHANGED,
            ),
        )
        harnessTransport.enqueue(meRule("host-a", "Pixel 9"))
        harnessTransport.enqueue(
            Rule(
                method = "POST",
                urlContains = "/web-session",
                respond = cookie(cookie = "__Host-lamasync-mobile=cookieA; Path=/; Secure; HttpOnly"),
            ),
        )
        harnessTransport.enqueue(Rule(method = "POST", urlContains = "/check-in", respond = json(200, "{}")))

        val vm = newViewModel()
        vm.initialize()
        vm.awaitState { it.pendingEnrollment != null }

        assertEquals("WELCOME hosts the recovery surface", Screen.WELCOME, vm.ui.value.screen)
        assertEquals("https://fleet-a.example.com", vm.ui.value.pendingEnrollment?.origin)
        assertEquals("recovery preserves the bound display name", "Pixel 9", vm.ui.value.pendingEnrollment?.displayName)
        assertNull("no registration saved yet", vm.ui.value.registration)
        assertTrue("no requests made by initialization alone", harnessTransport.requests.isEmpty())

        // User taps the VISIBLE resume action — no scanner input, no QR.
        vm.resumePendingEnrollment()
        vm.awaitState { it.screen == Screen.MANAGE && it.checkInOk == true }

        assertEquals("https://fleet-a.example.com", vm.ui.value.registration?.origin)
        assertEquals("display name preserved through resume", "Pixel 9", vm.ui.value.registration?.displayName)
        assertEquals("zero exchange requests: the consumed QR is never re-exchanged", 0,
            harnessTransport.requests.count { it.url.contains("/exchange") })
        assertEquals("exactly one identity probe", 1,
            harnessTransport.requests.count { it.url.contains("/me") })
        val meWire = transportWire(harnessTransport.requests.single { it.url.contains("/me") })
        assertTrue("identity probe authenticates with the STORED credential", meWire.contains("TOKEN_A"))
        assertTrue("all traffic went only to the bound origin",
            harnessTransport.requests.all { it.url.contains("fleet-a.example.com") })
        assertTrue("web session bootstrapped with the stored grant",
            harnessTransport.requests.any { it.url.contains("/web-session") })
        assertNull("recovery surface is gone after success", vm.ui.value.pendingEnrollment)
    }

    @Test
    fun startupRecoveryFailureKeepsTheRecoverySurfaceForRetry() {
        harness()
        harnessVault.saveCredentials(NativeToken.of("TOKEN_A"), WebGrant.of("GRANT_A"))
        harnessStore.saveBinding(
            EnrollmentBinding(
                origin = "https://fleet-a.example.com",
                enrollmentId = "enr_A",
                hostId = "host-a",
                displayName = "Pixel 9",
                stage = EnrollmentStage.EXCHANGED,
            ),
        )
        // Identity probe fails transiently.
        harnessTransport.enqueue(
            Rule(
                method = "GET",
                urlContains = "/me",
                failWith = ApiFailure.Network(ApiFailure.Network.CauseKind.CONNECT, Exception("offline")),
            ),
        )

        val vm = newViewModel()
        vm.initialize()
        vm.awaitState { it.pendingEnrollment != null }

        vm.resumePendingEnrollment()
        vm.awaitState { !it.busy }
        assertEquals("failure keeps WELCOME, not a QR-dependent screen", Screen.WELCOME, vm.ui.value.screen)
        assertNotNull("recovery surface survives a transient failure", vm.ui.value.pendingEnrollment)
        assertTrue("failure message explains the retryable error",
            vm.ui.value.message?.text?.contains("Cannot reach the server") ?: false)

        // Retry the same visible resume action after connectivity returns.
        harnessTransport.enqueue(meRule("host-a", "Pixel 9"))
        harnessTransport.enqueue(
            Rule(
                method = "POST",
                urlContains = "/web-session",
                respond = cookie(cookie = "__Host-lamasync-mobile=cookieA; Path=/; Secure; HttpOnly"),
            ),
        )
        harnessTransport.enqueue(Rule(method = "POST", urlContains = "/check-in", respond = json(200, "{}")))
        vm.resumePendingEnrollment()
        vm.awaitState { it.screen == Screen.MANAGE && it.checkInOk == true }

        assertEquals("still zero exchanges across the whole recovery", 0,
            harnessTransport.requests.count { it.url.contains("/exchange") })
    }

    @Test
    fun startupWithExchangedBindingButMissingCredentialsOffersNoPhantomResume() {
        harness()
        harnessStore.saveBinding(
            EnrollmentBinding(
                origin = "https://fleet-a.example.com",
                enrollmentId = "enr_A",
                hostId = "host-a",
                displayName = "Pixel",
                stage = EnrollmentStage.EXCHANGED,
            ),
        )
        // The Keystore key material was lost: no usable credentials.

        val vm = newViewModel()
        vm.initialize()

        assertEquals(Screen.WELCOME, vm.ui.value.screen)
        assertNull("no phantom resume when credentials are unusable", vm.ui.value.pendingEnrollment)
        assertFalse(vm.ui.value.credentialLost)
        assertTrue("missing-credentials startup makes no network requests", harnessTransport.requests.isEmpty())
    }

    @Test
    fun startupAfterWebLogoutOfCompletedEnrollmentDoesNotAutoRebootstrap() {
        harness()
        // Completed enrollment whose web session was logged out explicitly:
        // the registration + REGISTERED binding remain, the cookie is gone.
        seedCompletedPairing(
            "https://fleet.example.com", "host-7", "TOKEN_1", "GRANT_1",
            installCookie = false,
        )
        harnessTransport.enqueue(Rule(method = "POST", urlContains = "/check-in", respond = json(200, "{}")))

        val vm = newViewModel()
        vm.initialize()
        vm.awaitState { it.screen == Screen.MANAGE && it.checkInOk == true }

        assertEquals(Screen.MANAGE, vm.ui.value.screen)
        assertNull("no recovery surface for a completed enrollment", vm.ui.value.pendingEnrollment)
        assertFalse("cookie absent after web logout is surfaced honestly", vm.ui.value.webSessionConnected)
        assertEquals("no auto re-bootstrap of the completed enrollment", 0,
            harnessTransport.requests.count { it.url.contains("/web-session") })
        assertEquals("no re-exchange after web logout", 0,
            harnessTransport.requests.count { it.url.contains("/exchange") })
        assertEquals("identity metadata survives the logout", "https://fleet.example.com",
            vm.ui.value.registration?.origin)
    }

    // ------------------------------------------------------------------
    // R2 — cleanup failure propagation through disconnect and re-pairing
    // ------------------------------------------------------------------

    @Test
    fun disconnectWithUnconfirmedCookieClearReportsFailureAndRetryRecovers() {
        harness()
        seedCompletedPairing("https://fleet.example.com", "host-7", "TOKEN_1", "GRANT_1")
        // Cookie adapter reports removal failed (returns false)...
        harnessCookieScope.failClear = true
        harnessTransport.enqueue(webSessionRule())
        harnessTransport.enqueue(Rule(method = "POST", urlContains = "/revoke", respond = json(200, "{}")))

        val vm = newViewModel()
        vm.disconnect()
        vm.awaitState { !it.busy }

        assertEquals(Screen.WELCOME, vm.ui.value.screen)
        assertTrue("cleanup unconfirmed state is surfaced", vm.ui.value.cleanupUnconfirmed)
        assertEquals(listOf("https://fleet.example.com"), vm.ui.value.cleanupOrigins)
        assertEquals(true, vm.ui.value.cleanupRemoteSucceeded)
        val message = vm.ui.value.message
        assertNotNull(message)
        assertTrue(message!!.isError)
        assertTrue("remote outcome rendered independently", message.text.contains("Disconnected from the server"))
        assertFalse("must never claim 'Local data cleared' when cleanup is unconfirmed",
            message.text.contains("Local data cleared"))
        assertTrue("cookie is retained when the adapter refused removal",
            harnessCookieScope.hasCookie("https://fleet.example.com"))
        // Origin marker persisted so a relaunch can still retry.
        assertEquals(listOf("https://fleet.example.com"), harnessStore.cleanupPending)

        // Adapter recovers -> the concrete retry action finishes the cleanup.
        harnessCookieScope.failClear = false
        vm.retryCleanup()
        vm.awaitState { !it.busy }

        assertFalse(vm.ui.value.cleanupUnconfirmed)
        assertFalse(harnessCookieScope.hasCookie("https://fleet.example.com"))
        assertEquals(emptyList<String>(), harnessStore.cleanupPending)
        assertFalse("successful retry message is not an error", vm.ui.value.message?.isError ?: true)
        assertTrue("retry success notes the device stays revoked",
            vm.ui.value.message?.text?.contains("stays revoked on the server") ?: false)
    }

    @Test
    fun disconnectWithThrowingCookieClearReportsBothOutcomesAndRetryRecovers() {
        harness()
        seedCompletedPairing("https://fleet.example.com", "host-7", "TOKEN_1", "GRANT_1")
        // Cookie adapter throws, and the server is unreachable too.
        harnessCookieScope.throwOnClear = Exception("cookie manager exploded")
        harnessTransport.enqueue(
            Rule(
                method = "POST",
                urlContains = "/web-session",
                failWith = ApiFailure.Network(ApiFailure.Network.CauseKind.CONNECT, Exception("offline")),
            ),
        )

        val vm = newViewModel()
        vm.disconnect()
        vm.awaitState { !it.busy }

        assertEquals(Screen.WELCOME, vm.ui.value.screen)
        assertTrue(vm.ui.value.cleanupUnconfirmed)
        assertEquals(false, vm.ui.value.cleanupRemoteSucceeded)
        assertEquals(listOf("https://fleet.example.com"), vm.ui.value.cleanupOrigins)
        val message = vm.ui.value.message
        assertNotNull(message)
        assertTrue(message!!.isError)
        assertTrue("remote failure is reported", message.text.contains("remote revocation could not be completed"))
        assertTrue("desktop-side recovery guidance is offered",
            message.text.contains("Revoke this device from the desktop server UI"))
        assertFalse("no successful-local claim", message.text.contains("Local data cleared"))
        assertTrue("no exchange ever ran", harnessTransport.requests.none { it.url.contains("/exchange") })
        assertTrue("no revoke was attempted without a live session",
            harnessTransport.requests.none { it.url.contains("/revoke") })
        assertEquals("unconfirmed origin persisted for a later retry",
            listOf("https://fleet.example.com"), harnessStore.cleanupPending)

        harnessCookieScope.throwOnClear = null
        vm.retryCleanup()
        vm.awaitState { !it.busy }

        assertFalse(vm.ui.value.cleanupUnconfirmed)
        assertFalse(harnessCookieScope.hasCookie("https://fleet.example.com"))
        assertEquals(emptyList<String>(), harnessStore.cleanupPending)
        assertTrue("retry success still tells the user the remote side is open",
            vm.ui.value.message?.text?.contains("Remote revocation was not completed") ?: false)
    }

    @Test
    fun repairToBIsGatedWhileACookieCleanupIsUnconfirmedAndRetryCompletes() {
        harness()
        seedCompletedPairing("https://fleet-a.example.com", "host-a", "TOKEN_A", "GRANT_A", "enr_A")
        // A's cookie removal cannot be confirmed.
        harnessCookieScope.failClear = true

        val vm = newViewModel()
        vm.initialize()
        assertEquals(Screen.MANAGE, vm.ui.value.screen)

        // User scans origin B and confirms; re-pair must wipe A's cookie
        // BEFORE B's exchange.
        vm.onQrScanned(qrJson("https://fleet-b.example.com", "enr_B"))
        vm.confirmEnrollment("Pixel")
        vm.awaitState { it.screen == Screen.CONFIRM && !it.busy }

        assertFalse("B is not offered as a resume of A's binding", vm.ui.value.pendingResume)
        val message = vm.ui.value.message
        assertTrue("cleanup failure message names origin A",
            message?.text?.contains("fleet-a.example.com") ?: false)
        assertTrue("B's exchange must not start while A's cleanup is unconfirmed",
            harnessTransport.requests.none { it.url.contains("/exchange") })
        assertTrue("no request reached B at all",
            harnessTransport.requests.none { it.url.contains("fleet-b.example.com") })
        // A's pairing records and cleanup state survive for the retry.
        assertEquals("https://fleet-a.example.com", harnessStore.registration?.origin)
        assertEquals("TOKEN_A", harnessVault.native?.value)
        assertEquals("https://fleet-a.example.com", harnessStore.binding?.origin)
        assertTrue(harnessCookieScope.hasCookie("https://fleet-a.example.com"))

        // Adapter recovers: confirming again wipes A, then pairs B normally.
        harnessCookieScope.failClear = false
        harnessTransport.enqueue(exchangeRule("host-b", "TOKEN_B", "GRANT_B"))
        harnessTransport.enqueue(meRule("host-b"))
        harnessTransport.enqueue(webSessionRule())
        harnessTransport.enqueue(Rule(method = "POST", urlContains = "/check-in", respond = json(200, "{}")))
        vm.confirmEnrollment("Pixel")
        vm.awaitState { it.screen == Screen.MANAGE && it.checkInOk == true }

        assertEquals("https://fleet-b.example.com", vm.ui.value.registration?.origin)
        assertEquals("TOKEN_B", harnessVault.native?.value)
        assertEquals("https://fleet-b.example.com", harnessStore.binding?.origin)
        assertFalse("A's cookie was finally removed before B activated",
            harnessCookieScope.hasCookie("https://fleet-a.example.com"))
        val bRequests = harnessTransport.requests.filter { it.url.contains("fleet-b.example.com") }
        assertTrue(bRequests.isNotEmpty())
        for (wire in bRequests.map { transportWire(it) }) {
            assertFalse("A's native token must never reach B", wire.contains("TOKEN_A"))
            assertFalse("A's web grant must never reach B", wire.contains("GRANT_A"))
        }
        assertEquals("exactly one exchange with B", 1, bRequests.count { it.url.contains("/exchange") })
    }

    @Test
    fun staleCleanupForADisappearsWhenBBecomesThePendingEnrollment() {
        harness()
        seedCompletedPairing("https://fleet-a.example.com", "host-a", "TOKEN_A", "GRANT_A", "enr_A")
        harnessCookieScope.failClear = true
        harnessTransport.enqueue(webSessionRule())
        harnessTransport.enqueue(Rule(method = "POST", urlContains = "/revoke", respond = json(200, "{}")))

        val vm = newViewModel()
        vm.disconnect()
        vm.awaitState { !it.busy }
        assertTrue(vm.ui.value.cleanupUnconfirmed)

        // B starts only after A's old cookie is confirmed removed. B then
        // stops at identity, leaving a recoverable EXCHANGED enrollment.
        harnessCookieScope.failClear = false
        harnessTransport.enqueue(exchangeRule("host-b", "TOKEN_B", "GRANT_B"))
        harnessTransport.enqueue(meRule("host-b", status = 503))
        vm.onLaunchFromWelcome()
        vm.onQrScanned(qrJson("https://fleet-b.example.com", "enr_B"))
        vm.confirmEnrollment("Pixel B")
        vm.awaitState { it.screen == Screen.CONFIRM && !it.busy }
        assertEquals("TOKEN_B", harnessVault.native?.value)
        assertTrue(harnessStore.cleanupPending.isEmpty())

        vm.onConfirmBack()
        vm.onScannerBack()
        assertNotNull("B remains resumable", vm.ui.value.pendingEnrollment)
        assertFalse("A's obsolete retry action must be removed", vm.ui.value.cleanupUnconfirmed)
        assertEquals("TOKEN_B", harnessVault.native?.value)
        assertEquals("https://fleet-b.example.com", harnessStore.binding?.origin)
    }

    @Test
    fun disconnectSuccessClearsEverythingAndReportsRemoteSuccess() {
        harness()
        seedCompletedPairing("https://fleet.example.com", "host-7", "TOKEN_1", "GRANT_1")
        harnessTransport.enqueue(webSessionRule())
        harnessTransport.enqueue(Rule(method = "POST", urlContains = "/revoke", respond = json(200, "{}")))

        val vm = newViewModel()
        vm.disconnect()
        vm.awaitState { !it.busy }

        assertEquals(Screen.WELCOME, vm.ui.value.screen)
        assertFalse("clean state on a fully successful disconnect", vm.ui.value.cleanupUnconfirmed)
        assertFalse("success message is not an error", vm.ui.value.message?.isError ?: true)
        assertTrue(vm.ui.value.message?.text?.contains("Disconnected. This device was revoked on the server.") ?: false)
        assertNull(harnessStore.registration)
        assertNull(harnessVault.native)
        assertFalse(harnessCookieScope.hasCookie("https://fleet.example.com"))
        assertEquals(emptyList<String>(), harnessStore.cleanupPending)
    }

    private fun transportWire(request: HttpRequest): String =
        request.headers.entries.joinToString("\n") { "${it.key}: ${it.value}" } +
            "\n" + (request.body?.toString(Charsets.UTF_8).orEmpty())
}
