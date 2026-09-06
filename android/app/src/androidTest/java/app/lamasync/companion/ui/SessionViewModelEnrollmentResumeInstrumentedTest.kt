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
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * ViewModel state-transition regressions on a real device with fakes injected
 * through the SessionViewModel test seam (review findings 1 and 5). These
 * drive the actual confirmEnrollment/retryEnrollment state machine, not just
 * repository calls:
 *
 *  - finding 5: after exchange+identity succeed and the bootstrap fails once,
 *    the UI Retry must resume from the REGISTERED stage — re-bootstrapping
 *    from the saved grant with exactly one exchange and an unchanged native
 *    credential.
 *  - finding 1: after an interrupted enrollment at origin A, scanning origin B
 *    must run B's own exchange — no A credential may reach B.
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

        override fun clear() {
            registration = null
            binding = null
        }
    }

    private class MemCookieScope : WebCookieScope {
        private val cookies = mutableMapOf<String, String>()

        override suspend fun installSessionCookie(origin: String, setCookieHeader: String): Boolean {
            cookies[origin] = WebSessionBroker.cookiePair(setCookieHeader)
            return true
        }

        override fun readSessionCookie(origin: String): String? = cookies[origin]

        override suspend fun clearSessionCookie(origin: String): Boolean {
            cookies.remove(origin)
            return true
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
        val repo = CompanionRepository(
            api = MobileApiClient(transport),
            broker = WebSessionBroker(transport),
            vault = vault,
            registrationStore = store,
            cookieScope = MemCookieScope(),
        )
        harnessRepo = repo
        harnessTransport = transport
        harnessVault = vault
        harnessStore = store
        return Triple(transport, vault, store)
    }

    private lateinit var harnessRepo: CompanionRepository
    private lateinit var harnessTransport: ScriptedTransport
    private lateinit var harnessVault: MemVault
    private lateinit var harnessStore: MemStore

    private fun newViewModel(): SessionViewModel = SessionViewModel(app, harnessRepo)

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

    private fun transportWire(request: HttpRequest): String =
        request.headers.entries.joinToString("\n") { "${it.key}: ${it.value}" } +
            "\n" + (request.body?.toString(Charsets.UTF_8).orEmpty())
}
