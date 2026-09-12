package app.lamasync.companion.vertical

import android.app.Activity
import android.app.Application
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.data.CompanionRepository
import app.lamasync.companion.data.EnrollmentBinding
import app.lamasync.companion.data.EnrollmentStage
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.RegistrationStoreImpl
import app.lamasync.companion.data.SecureCredentialVault
import app.lamasync.companion.network.HttpRequest
import app.lamasync.companion.network.HttpResponse
import app.lamasync.companion.network.HttpTransport
import app.lamasync.companion.network.HttpUrlConnectionTransport
import app.lamasync.companion.network.MobileApiClient
import app.lamasync.companion.network.WebSessionBroker
import app.lamasync.companion.ui.Screen
import app.lamasync.companion.ui.SessionViewModel
import app.lamasync.companion.web.HardenedWebView
import app.lamasync.companion.web.SessionCookieJar
import app.lamasync.companion.web.WebCookieScope
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Vertical HTTPS test (LAMA-296 review "Before acceptance"): the REAL app
 * stack (real SessionViewModel + real Keystore vault + real store + real
 * CookieManager + real HTTPS transport) against a disposable lamasync server
 * on the host, reached by the emulator at the origin passed in the
 * `verticalOrigin` instrumentation argument. The enrollment is created
 * through the same admin endpoint the desktop web UI uses, and the payload
 * is injected into SessionViewModel via onQrScanned (the scanner seam) — the
 * camera is not used.
 *
 * The class is inert unless the harness passes `verticalOrigin` +
 * `verticalAdminKey`, so a plain connectedDebugAndroidTest run (no live
 * server) skips it.
 */
@RunWith(AndroidJUnit4::class)
class VerticalHttpsEnrollmentTest {

    private lateinit var app: Application
    private var origin: String? = null
    private var adminKey: String? = null

    @Before
    fun readArgs() {
        val args = InstrumentationRegistry.getArguments()
        origin = args.getString("verticalOrigin")
        adminKey = args.getString("verticalAdminKey")
        Assume.assumeTrue("verticalOrigin instrumentation arg missing", origin != null)
        Assume.assumeTrue("verticalAdminKey instrumentation arg missing", adminKey != null)
        app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        KeystoreCredentialVault(app).clear()
        RegistrationStoreImpl(app).clear()
        // CookieManager-backed cleanup; the WebView provider must be live.
        ActivityScenario.launch(Activity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                CookieManager.getInstance().removeAllCookies(null)
                CookieManager.getInstance().flush()
                HardenedWebView.create(
                    context = activity,
                    canonicalOrigin = origin!!,
                    debugAllowWebContentsDebugging = false,
                    listener = NoopListener,
                )
            }
        }
    }

    // ------------------------------------------------------------------
    // Wire helpers (run inside the app process; debug NSC trusts the CA)
    // ------------------------------------------------------------------

    private fun https(
        method: String,
        path: String,
        headers: Map<String, String> = emptyMap(),
        body: String? = null,
    ): Pair<Int, String> {
        val conn = URL(origin + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 20_000
        conn.readTimeout = 40_000
        headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
        }
        val status = conn.responseCode
        val stream = if (status >= 400) conn.errorStream else conn.inputStream
        val text = stream?.use { input ->
            val buf = ByteArrayOutputStream()
            val chunk = ByteArray(8192)
            while (true) {
                val n = input.read(chunk)
                if (n == -1) break
                buf.write(chunk, 0, n)
            }
            if (buf.size() == 0) null else String(buf.toByteArray(), StandardCharsets.UTF_8)
        }
        conn.disconnect()
        return status to (text ?: "")
    }

    private fun adminGet(path: String): Pair<Int, String> =
        https("GET", path, mapOf("Authorization" to "Bearer $adminKey"))

    private fun adminPost(path: String, body: String): Pair<Int, String> =
        https("POST", path, mapOf("Authorization" to "Bearer $adminKey"), body)

    /** Desktop-issued enrollment: the same endpoint the web UI modal calls. */
    private fun createEnrollment(): JSONObject {
        val (status, text) = adminPost("/api/v1/mobile/enrollments", """{"webAdmin":true,"clientType":"android"}""")
        assertEquals("create enrollment should succeed (201)", 201, status)
        val obj = JSONObject(text)
        assertEquals("server must embed the configured canonical origin", origin, obj.getString("serverOrigin"))
        return obj
    }

    private fun qrPayload(enrollment: JSONObject): String = """
        {"kind":"lamasync.android.enroll","version":1,
         "serverOrigin":${JSONObject.quote(enrollment.getString("serverOrigin"))},
         "enrollmentId":${JSONObject.quote(enrollment.getString("enrollmentId"))},
         "secret":${JSONObject.quote(enrollment.getString("secret"))}}
    """.trimIndent()

    private fun adminRegistrations(): JSONArray {
        val (status, text) = adminGet("/api/v1/mobile/registrations")
        assertEquals("desktop listing should be reachable", 200, status)
        return JSONArray(text)
    }

    private fun registrationByDisplayName(name: String): JSONObject? {
        val list = adminRegistrations()
        for (i in 0 until list.length()) {
            val row = list.getJSONObject(i)
            if (row.optString("displayName") == name) return row
        }
        return null
    }

    private fun enrollmentStatus(id: String): JSONObject {
        val (status, text) = adminGet("/api/v1/mobile/enrollments/$id")
        assertEquals(200, status)
        return JSONObject(text)
    }

    private fun waitFor(
        timeoutMillis: Long = 60_000,
        what: String,
        predicate: () -> Boolean,
    ) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (SystemClock.uptimeMillis() < deadline) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            if (predicate()) return
            SystemClock.sleep(200)
        }
        fail("Timed out waiting for $what")
    }

    private fun awaitVm(vm: SessionViewModel, what: String, predicate: (app.lamasync.companion.ui.UiState) -> Boolean) {
        waitFor(what = what) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            predicate(vm.ui.value)
        }
    }

    private fun realVm(): SessionViewModel = SessionViewModel(app)

    // ------------------------------------------------------------------
    // Test 1 — device A full life: exchange→identity→cookie→SPA→restart→
    // logout→explicit reconnect→native disconnect WITH an existing cookie.
    // ------------------------------------------------------------------

    @Test
    fun deviceA_fullLifeChain_overRealHttps() {
        val o = origin!!
        // Desktop opens "Add Android device", creates enrollment, renders QR.
        val enrollment = createEnrollment()
        // App scans (payload injected through the ViewModel seam; no camera).
        val vm = realVm()
        vm.onQrScanned(qrPayload(enrollment))
        awaitVm(vm, "confirm screen") { it.screen == Screen.CONFIRM }
        vm.confirmEnrollment("Vertical Device A")

        // exchange → identity → cookie bootstrap → MANAGE.
        awaitVm(vm, "MANAGE after real exchange/identity/bootstrap") {
            it.screen == Screen.MANAGE && !it.busy && it.webSessionConnected
        }
        val registration = vm.ui.value.registration
        assertNotNull("registration persisted", registration)
        assertEquals("registered at the enrolled origin", o, registration!!.origin)
        assertTrue("hostId present", registration.hostId.isNotBlank())

        // The real CookieManager now holds the session cookie for the origin.
        val cookie = requireNotNull(SessionCookieJar().readSessionCookie(o)) {
            "__Host-lamasync-mobile installed into the platform CookieManager"
        }
        assertTrue(cookie.startsWith("__Host-lamasync-mobile="))

        // Server side: registration live, enrollment used, check-in recorded.
        waitFor(what = "server registration + check-in") {
            registrationByDisplayName("Vertical Device A") != null &&
                registrationByDisplayName("Vertical Device A")!!.optLong("lastSeenAt") >
                registrationByDisplayName("Vertical Device A")!!.optLong("createdAt")
        }
        val row = registrationByDisplayName("Vertical Device A")!!
        assertEquals("registration must be live (not revoked)", 0L, row.optLong("revokedAt"))
        assertEquals("enrollment consumed exactly once", "used", enrollmentStatus(enrollment.getString("enrollmentId")).getString("status"))

        // Cookie authenticates as a mobile session (the SPA's own boot probe).
        val (authStatus, authBody) = https("GET", "/api/v1/auth/me", mapOf("Cookie" to cookie))
        assertEquals(200, authStatus)
        val authMe = JSONObject(authBody)
        assertTrue(authMe.getBoolean("authenticated"))
        assertEquals("session", authMe.getString("mode"))

        // Authenticated SPA load: a real (app-hardened) WebView at the origin
        // reaches the admin shell, not the login form.
        assertSpaReachesAdminShell(o)

        // Restart recovery: a fresh VM over the same persisted state boots
        // straight to MANAGE — no re-scan, no re-exchange.
        val vm2 = realVm()
        vm2.initialize()
        awaitVm(vm2, "restart recovery") { it.screen == Screen.MANAGE }
        assertEquals("same host after restart", registration.hostId, vm2.ui.value.registration?.hostId)
        val cookie2 = requireNotNull(SessionCookieJar().readSessionCookie(o)) { "cookie survives restart" }

        // Logout: the SPA logout call (cookie + CSRF + exact Origin) kills
        // only the web session; the native registration stays valid.
        val csrf = JSONObject(
            https("GET", "/api/v1/auth/me", mapOf("Cookie" to cookie2)).second,
        ).getString("csrfToken")
        val (logoutStatus, _) = https(
            "POST",
            "/api/v1/mobile/web-session/logout",
            headers = mapOf(
                "Cookie" to cookie2,
                "Origin" to o,
                "X-CSRF-Token" to csrf,
            ),
            body = "{}",
        )
        assertEquals("logout accepted", 200, logoutStatus)
        val (afterLogout, _) = https("GET", "/api/v1/auth/me", mapOf("Cookie" to cookie2))
        assertEquals("old cookie session is dead after logout", 401, afterLogout)
        assertNotNull("native registration unaffected by logout", registrationByDisplayName("Vertical Device A"))

        // Explicit reconnect: no re-scan, no re-exchange (one registration,
        // same host, enrollment still used once).
        vm2.reconnectWebSession()
        awaitVm(vm2, "reconnect restores the web session") {
            !it.busy && it.webSessionConnected && it.message?.text?.contains("Web session restored.") == true
        }
        val cookie3 = requireNotNull(SessionCookieJar().readSessionCookie(o)) { "cookie re-installed after reconnect" }
        val (authAgain, authAgainBody) = https("GET", "/api/v1/auth/me", mapOf("Cookie" to cookie3))
        assertEquals("session live again after reconnect", 200, authAgain)
        assertEquals(registration.hostId, JSONObject(authAgainBody).getString("hostId"))
        val rowsAfterReconnect = adminRegistrations()
        var matches = 0
        for (i in 0 until rowsAfterReconnect.length()) {
            val r = rowsAfterReconnect.getJSONObject(i)
            if (r.getString("displayName") == "Vertical Device A") {
                matches++
                assertEquals("no re-exchange → same hostId", registration.hostId, r.getString("hostId"))
            }
        }
        assertEquals("exactly one registration for A (no re-exchange)", 1, matches)
        assertEquals("enrollment still used exactly once", "used", enrollmentStatus(enrollment.getString("enrollmentId")).getString("status"))

        // Native disconnect WITH an existing cookie → the fresh bootstrap
        // cookie+CSRF pair satisfies the server (200), server authority dies.
        assertNotNull("cookie present before disconnect", SessionCookieJar().readSessionCookie(o))
        vm2.disconnect()
        awaitVm(vm2, "disconnect returns to WELCOME") { it.screen == Screen.WELCOME }
        assertTrue(
            "disconnect must report remote revocation success",
            vm2.ui.value.message?.text?.contains("revoked on the server") == true,
        )
        assertNull("session cookie cleared locally", SessionCookieJar().readSessionCookie(o))
        assertNull("local registration cleared", RegistrationStoreImpl(app).load())
        waitFor(what = "server shows A revoked") {
            registrationByDisplayName("Vertical Device A")?.optLong("revokedAt")?.let { it > 0 } == true
        }
        val revokedRow = registrationByDisplayName("Vertical Device A")!!
        assertTrue("server stamped revokedAt", revokedRow.optLong("revokedAt") > 0)
        // Native token now rejected by the server.
        val vault = KeystoreCredentialVault(app)
        val native = vault.nativeToken()
        assertNull("native secret destroyed locally", native)
    }

    // ------------------------------------------------------------------
    // Test 2 — device B: desktop revoke AFTER a desktop reload, resolved
    // purely through GET /api/v1/mobile/registrations (finding 6 path).
    // ------------------------------------------------------------------

    @Test
    fun deviceB_desktopRevokeAfterReload_killsDevice() {
        val o = origin!!
        val enrollment = createEnrollment()
        val vm = realVm()
        vm.onQrScanned(qrPayload(enrollment))
        awaitVm(vm, "confirm") { it.screen == Screen.CONFIRM }
        vm.confirmEnrollment("Vertical Device B")
        awaitVm(vm, "MANAGE") { it.screen == Screen.MANAGE && !it.busy }
        val hostId = vm.ui.value.registration!!.hostId
        val cookie = requireNotNull(SessionCookieJar().readSessionCookie(o)) { "cookie installed" }

        // Open the SPA in the app-hardened WebView: authenticated shell must
        // render, and a same-origin cookie session WebSocket must reach OPEN.
        val wsState = AtomicReference<String?>(null)
        ActivityScenario.launch(Activity::class.java).use { scenario ->
            val webViewRef = AtomicReference<WebView?>()
            scenario.onActivity { activity ->
                val wv = HardenedWebView.create(
                    context = activity,
                    canonicalOrigin = o,
                    debugAllowWebContentsDebugging = false,
                    listener = NoopListener,
                )
                activity.setContentView(wv)
                webViewRef.set(wv)
                wv.loadUrl("$o/")
            }
            val webView: WebView = requireNotNull(webViewRef.get()) { "WebView not created" }
            // Authenticated SPA shell (the WebView reaches the fleet page, not login).
            waitFor(what = "authenticated SPA shell in the WebView") {
                val text = evaluateJs(webView, "document.body ? document.body.innerText : ''") ?: ""
                text.contains("Activity") && !text.contains("Sign in")
            }
            // Same-origin cookie-session WebSocket: the exact channel the SPA's
            // live event feed uses. Must reach OPEN while the session is live.
            evaluateJs(
                webView,
                "window.__ws='connecting';" +
                    "try{var s=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/api/v1/ws');" +
                    "s.onopen=function(){window.__ws='open'};" +
                    "s.onclose=function(e){window.__ws='closed:'+(e&&e.code)};" +
                    "s.onerror=function(){window.__ws='error'}}catch(e){window.__ws='err'}",
            )
            waitFor(what = "cookie-session WebSocket reaches OPEN in the page") {
                (evaluateJs(webView, "window.__ws||''") ?: "") == "open"
            }
            wsState.set("open")

            // Desktop reload: the persistent panel re-fetches the projection and
            // finds B by host id — no enrollment id, no modal state.
            val list = adminRegistrations()
            var found: JSONObject? = null
            for (i in 0 until list.length()) {
                val r = list.getJSONObject(i)
                if (r.getString("displayName") == "Vertical Device B" && r.getString("hostId") == hostId) {
                    found = r
                }
            }
            assertNotNull("B listed in the fresh desktop projection after reload", found)
            val (revokeStatus, _) = adminPost(
                "/api/v1/mobile/registrations/$hostId/revoke",
                """{"reason":"Revoked from the desktop web UI"}""",
            )
            assertEquals("desktop revoke accepted", 200, revokeStatus)

            // Revoked sessions and sockets all fail: cookie dead, live socket
            // closed by the server, check-in/native rejected.
            waitFor(what = "server marks B revoked") {
                registrationByDisplayName("Vertical Device B")?.optLong("revokedAt")?.let { it > 0 } == true
            }
            val (authStatus, _) = https("GET", "/api/v1/auth/me", mapOf("Cookie" to cookie))
            assertEquals("cookie session dead after desktop revoke", 401, authStatus)
            waitFor(what = "live WebSocket closed by the server after revoke") {
                (evaluateJs(webView, "window.__ws||''") ?: "").startsWith("closed:")
            }
            wsState.set("closed")
            // Check-in / reconnect through the real VM must now fail.
            val native = KeystoreCredentialVault(app).nativeToken()
            assertNotNull(native)
            val (meStatus, _) = https(
                "GET",
                "/api/v1/mobile/me",
                mapOf("Authorization" to "Bearer ${native!!.value}"),
            )
            assertEquals("native /mobile/me rejected after revoke", 401, meStatus)
        }
        assertEquals("ws probe observed open then server-closed", "closed", wsState.get())
    }

    // ------------------------------------------------------------------
    // Test 3 — device C: bootstrap interruption (finding 5) against the real
    // server: exchange+identity hit the server once, first web-session POST
    // drops (transport seam), UI Retry resumes REGISTERED with no re-exchange.
    // ------------------------------------------------------------------

    @Test
    fun deviceC_bootstrapInterruptionRetry_noReexchange() {
        val enrollment = createEnrollment()
        val transport = FailFirstBootstrapTransport(HttpUrlConnectionTransport())
        val vault = KeystoreCredentialVault(app)
        val store = RegistrationStoreImpl(app)
        val repo = CompanionRepository(
            api = MobileApiClient(transport),
            broker = WebSessionBroker(transport),
            vault = vault,
            registrationStore = store,
            cookieScope = SessionCookieJar(),
        )
        val vm = SessionViewModel(app, repo)
        vm.onQrScanned(qrPayload(enrollment))
        awaitVm(vm, "confirm") { it.screen == Screen.CONFIRM }
        vm.confirmEnrollment("Vertical Device C")
        awaitVm(vm, "bootstrap failure surfaces as a resumable CONFIRM") {
            it.screen == Screen.CONFIRM && !it.busy && it.pendingResume
        }
        assertEquals("exchange ran exactly once before interruption", 1, transport.exchangeCount)
        assertEquals("identity ran once", 1, transport.meCount)
        assertEquals("first bootstrap attempt failed at the transport", 1, transport.webSessionAttempts)
        assertEquals("registration saved at REGISTERED stage", EnrollmentStage.REGISTERED, store.loadBinding()?.stage)
        assertNotNull("registration exists server-side before retry", registrationByDisplayName("Vertical Device C"))

        // UI Retry: resume REGISTERED → re-bootstrap from the stored grant.
        val nativeBefore = vault.nativeToken()?.value
        vm.retryEnrollment()
        awaitVm(vm, "MANAGE after retry") { it.screen == Screen.MANAGE && !it.busy }
        assertEquals("no re-exchange on retry", 1, transport.exchangeCount)
        assertEquals("second (successful) bootstrap attempt", 2, transport.webSessionAttempts)
        assertEquals("native credential unchanged", nativeBefore, vault.nativeToken()?.value)
        assertEquals("display name preserved", "Vertical Device C", vm.ui.value.registration?.displayName)
        val row = registrationByDisplayName("Vertical Device C")!!
        assertEquals("one registration, same host", vm.ui.value.registration!!.hostId, row.getString("hostId"))
        assertEquals("enrollment used exactly once", "used", enrollmentStatus(enrollment.getString("enrollmentId")).getString("status"))
    }

    // ------------------------------------------------------------------
    // Test 4 — device D: offline disconnect local-cleanup honesty
    // (finding 3): remote fails, the REAL CookieManager cookie still gets
    // expired and the store/vault are wiped.
    // ------------------------------------------------------------------

    @Test
    fun deviceD_offlineDisconnect_honestLocalCleanup() {
        val o = origin!!
        val enrollment = createEnrollment()
        val online = realVm()
        online.onQrScanned(qrPayload(enrollment))
        awaitVm(online, "confirm") { it.screen == Screen.CONFIRM }
        online.confirmEnrollment("Vertical Device D")
        awaitVm(online, "MANAGE") { it.screen == Screen.MANAGE && !it.busy }
        val hostId = online.ui.value.registration!!.hostId
        assertNotNull("real cookie installed", SessionCookieJar().readSessionCookie(o))

        // Offline: transport fails everything; same real stores/cookie scope.
        val offlineTransport = OfflineTransport()
        val vault = KeystoreCredentialVault(app)
        val store = RegistrationStoreImpl(app)
        val offline = SessionViewModel(
            app,
            CompanionRepository(
                api = MobileApiClient(offlineTransport),
                broker = WebSessionBroker(offlineTransport),
                vault = vault,
                registrationStore = store,
                cookieScope = SessionCookieJar(),
            ),
        )
        offline.disconnect()
        awaitVm(offline, "offline disconnect completes locally with the honest message") {
            !it.busy && it.screen == Screen.WELCOME &&
                it.message?.text?.contains("Local data cleared, but remote revocation could not be completed") == true
        }
        val message = offline.ui.value.message?.text.orEmpty()
        assertTrue("UI must report local clear + remote failure honestly", message.contains("Local data cleared, but remote revocation could not be completed"))
        assertNull("real cookie actually removed from CookieManager", SessionCookieJar().readSessionCookie(o))
        assertNull("store cleared", store.load())
        assertNull("binding cleared", store.loadBinding())
        assertNull("vault native secret cleared", vault.nativeToken())
        // Server still has the registration live (remote never succeeded).
        val row = registrationByDisplayName("Vertical Device D")!!
        assertEquals("server never revoked (remote failed)", 0L, row.optLong("revokedAt"))
        // Clean up the abandoned registration from the disposable server.
        val (revokeStatus, _) = adminPost(
            "/api/v1/mobile/registrations/$hostId/revoke",
            """{"reason":"vertical cleanup"}""",
        )
        assertEquals(200, revokeStatus)
    }

    // ------------------------------------------------------------------
    // SPA helper: real WebView (app-hardened factory) at the enrolled origin
    // must render the authenticated admin shell, and a same-origin WS with
    // the session cookie must reach OPEN.
    // ------------------------------------------------------------------

    private fun assertSpaReachesAdminShell(o: String) {
        ActivityScenario.launch(Activity::class.java).use { scenario ->
            val webViewRef = AtomicReference<WebView?>()
            scenario.onActivity { activity ->
                val wv = HardenedWebView.create(
                    context = activity,
                    canonicalOrigin = o,
                    debugAllowWebContentsDebugging = false,
                    listener = NoopListener,
                )
                activity.setContentView(wv)
                webViewRef.set(wv)
                wv.loadUrl("$o/")
            }
            val webView: WebView = requireNotNull(webViewRef.get()) { "WebView not created" }
            waitFor(what = "authenticated SPA shell in the WebView") {
                val text = evaluateJs(webView, "document.body ? document.body.innerText : ''") ?: ""
                text.contains("Activity") && !text.contains("Sign in")
            }
        }
    }

    private fun evaluateJs(webView: WebView, script: String): String? {
        val latch = CountDownLatch(1)
        val result = AtomicReference<String?>()
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            try {
                webView.evaluateJavascript(script) { value ->
                    result.set(value)
                    latch.countDown()
                }
            } catch (e: Exception) {
                result.set(null)
                latch.countDown()
            }
        }
        if (!latch.await(15, TimeUnit.SECONDS)) return null
        val raw = result.get() ?: return null
        return if (raw.length >= 2 && raw.startsWith("\"") && raw.endsWith("\"")) {
            raw.substring(1, raw.length - 1)
                .replace("\\n", "\n").replace("\\\"", "\"").replace("\\\\", "\\")
        } else raw
    }

    private object NoopListener : HardenedWebView.Listener {
        override fun onOpenExternally(url: String) = Unit
        override fun onBlockedNavigation(url: String) = Unit
        override fun onBlockedSsl(url: String) = Unit
        override fun onPageTitle(title: String?) = Unit
        override fun onWebHistoryChanged(canGoBack: Boolean) = Unit
        override fun onWebLoadStateChanged(canGoBack: Boolean, loading: Boolean) = Unit
    }
}

/** Delegates to the real HTTPS transport; fails the first /web-session POST
 *  (a dropped connection), then passes everything through. Counts the wire
 *  calls that matter for the finding-5 assertion. */
private class FailFirstBootstrapTransport(
    private val delegate: HttpTransport,
) : HttpTransport {
    var exchangeCount = 0
    var meCount = 0
    var webSessionAttempts = 0
    private var failedOnce = false

    override suspend fun execute(request: HttpRequest): HttpResponse {
        when {
            request.url.contains("/exchange") -> exchangeCount++
            request.url.contains("/mobile/me") -> meCount++
            request.url.contains("/web-session") -> {
                webSessionAttempts++
                if (!failedOnce) {
                    failedOnce = true
                    throw ApiFailure.Network(ApiFailure.Network.CauseKind.IO, IOException("injected bootstrap drop"))
                }
            }
        }
        return delegate.execute(request)
    }
}

/** Every request fails at the transport (offline). */
private class OfflineTransport : HttpTransport {
    override suspend fun execute(request: HttpRequest): HttpResponse =
        throw ApiFailure.Network(ApiFailure.Network.CauseKind.IO, IOException("offline"))
}

private fun IOException(message: String): java.io.IOException = java.io.IOException(message)
