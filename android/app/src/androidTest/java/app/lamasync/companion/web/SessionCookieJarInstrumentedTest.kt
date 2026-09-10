package app.lamasync.companion.web

import android.app.Activity
import android.webkit.CookieManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.data.CompanionRepository
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.RegistrationStoreImpl
import app.lamasync.companion.data.WebGrant
import app.lamasync.companion.network.HttpRequest
import app.lamasync.companion.network.HttpResponse
import app.lamasync.companion.network.HttpTransport
import app.lamasync.companion.network.MobileApiClient
import app.lamasync.companion.network.WebSessionBroker
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real CookieManager lifecycle (review finding 3). The production cookie is
 * `__Host-…`, so BOTH the install header and the expiry header must carry the
 * attributes the platform's prefix validation requires (Secure, host-only,
 * Path=/) — otherwise the expiry is silently rejected and the old admin
 * session cookie survives. These tests exercise the actual SessionCookieJar
 * against the platform cookie store: install, clear (immediate + after a
 * fresh wrapper/reload), and the offline-disconnect teardown path.
 */
@RunWith(AndroidJUnit4::class)
class SessionCookieJarInstrumentedTest {

    private val originA = "https://fleet-a.example.com"
    private val originB = "https://fleet-b.example.com"
    private val productionForm =
        "__Host-lamasync-mobile=session-value-1; Path=/; Secure; HttpOnly; SameSite=Strict"

    private class NoopListener : HardenedWebView.Listener {
        override fun onOpenExternally(url: String) = Unit
        override fun onBlockedNavigation(url: String) = Unit
        override fun onBlockedSsl(url: String) = Unit
        override fun onPageTitle(title: String?) = Unit
        override fun onWebStateChanged(canGoBack: Boolean, loading: Boolean) = Unit
    }

    @Before
    fun ensureWebViewProvider() {
        // CookieManager is backed by the WebView provider; create a real
        // WebView on the main thread first so the store is usable (mirrors
        // WebViewNavigationInstrumentedTest).
        ActivityScenario.launch(Activity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                HardenedWebView.create(
                    context = activity,
                    canonicalOrigin = "https://fleet.example.com",
                    debugAllowWebContentsDebugging = false,
                    listener = NoopListener(),
                )
            }
        }
    }

    @Test
    fun productionFormCookieInstallsAndIsReadable() = runBlocking {
        val jar = SessionCookieJar()
        try {
            val installed = jar.installSessionCookie(originA, productionForm)
            assertTrue("platform must accept the production-form cookie", installed)
            assertEquals(
                "__Host-lamasync-mobile=session-value-1",
                jar.readSessionCookie(originA),
            )
        } finally {
            jar.clearSessionCookie(originA)
        }
    }

    @Test
    fun expiryWithSecureHostOnlyPathRemovesCookieImmediatelyAndAfterReload() = runBlocking {
        val jar = SessionCookieJar()
        try {
            assertTrue(jar.installSessionCookie(originA, productionForm))
            assertEquals("__Host-lamasync-mobile=session-value-1", jar.readSessionCookie(originA))

            // The pre-fix expiry omitted Secure and was rejected for the
            // __Host- prefix; the fix must report a confirmed removal.
            val cleared = jar.clearSessionCookie(originA)
            assertTrue("platform must accept the __Host- compliant expiry cookie", cleared)
            assertNull("cookie must be gone immediately after the expiry completes", jar.readSessionCookie(originA))

            // "After reload": a fresh jar wrapper over the same platform store
            // (plus a flush cycle) must still observe absence, and installing
            // a cookie for a different origin must not resurrect it.
            val reloaded = SessionCookieJar()
            CookieManager.getInstance().flush()
            assertNull("cookie must still be absent after reload", reloaded.readSessionCookie(originA))

            assertTrue(
                reloaded.installSessionCookie(originB, productionForm.replace("session-value-1", "session-value-2")),
            )
            assertNull("cleared cookie must not resurrect", reloaded.readSessionCookie(originA))
            assertEquals(
                "__Host-lamasync-mobile=session-value-2",
                reloaded.readSessionCookie(originB),
            )
        } finally {
            // Keep the shared store tidy for sibling tests.
            SessionCookieJar().clearSessionCookie(originA)
            SessionCookieJar().clearSessionCookie(originB)
        }
    }

    @Test
    fun offlineDisconnectExpiresTheRealCookie() = runBlocking {
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        val vault = KeystoreCredentialVault(context)
        val store = RegistrationStoreImpl(context)
        val jar = SessionCookieJar()
        vault.clear()
        store.clear()
        try {
            vault.saveCredentials(NativeToken.of("TOKEN_1"), WebGrant.of("GRANT_1"))
            store.save(
                Registration(
                    origin = originA,
                    hostId = "host-1",
                    displayName = "Phone",
                    enrolledAtEpochMillis = 1L,
                ),
            )
            assertTrue("seed a real production cookie before disconnect", jar.installSessionCookie(originA, productionForm))

            val failingTransport = object : HttpTransport {
                override suspend fun execute(request: HttpRequest): HttpResponse =
                    throw ApiFailure.Network(ApiFailure.Network.CauseKind.CONNECT, Exception("offline"))
            }
            val repository = CompanionRepository(
                api = MobileApiClient(failingTransport),
                broker = WebSessionBroker(failingTransport),
                vault = vault,
                registrationStore = store,
                cookieScope = jar,
            )

            val result = repository.disconnect()

            assertTrue(result.remoteAttempted)
            assertFalse("offline: remote revocation cannot succeed", result.remoteSucceeded)
            assertTrue("offline teardown must report success when the cookie is really gone", result.localCleared)
            assertNull("the real admin cookie must be expired even while offline", jar.readSessionCookie(originA))
        } finally {
            jar.clearSessionCookie(originA)
            vault.clear()
            store.clear()
        }
    }
}
