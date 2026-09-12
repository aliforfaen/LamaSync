package app.lamasync.companion.web

import android.app.Activity
import android.webkit.WebSettings
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * WebView hardening on a real device: verifies the actual WebViewClient
 * wiring (not just the pure policy) consumes cross-origin top-level
 * navigation before any network traffic, and that the WebView is created with
 * the hardened settings. Same-origin loads are not exercised here because
 * they require the enrolled server; the cross-origin case needs no network
 * (the override consumes it).
 */
@RunWith(AndroidJUnit4::class)
class WebViewNavigationInstrumentedTest {

    private fun createListener(latch: CountDownLatch): ListenerProbe {
        val probe = ListenerProbe(latch)
        return probe
    }

    class ListenerProbe(private val latch: CountDownLatch) : HardenedWebView.Listener {
        var external: String? = null
        var blocked: String? = null

        override fun onOpenExternally(url: String) {
            external = url
            latch.countDown()
        }

        override fun onBlockedNavigation(url: String) {
            blocked = url
            latch.countDown()
        }

        override fun onBlockedSsl(url: String) = Unit
        override fun onPageTitle(title: String?) = Unit
        override fun onWebHistoryChanged(canGoBack: Boolean) = Unit
        override fun onWebLoadStateChanged(canGoBack: Boolean, loading: Boolean) = Unit
    }

    @Test
    fun hardenedSettingsAreAppliedToTheRealWebView() {
        ActivityScenario.launch(Activity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val webView = HardenedWebView.create(
                    context = activity,
                    canonicalOrigin = "https://fleet.example.com",
                    debugAllowWebContentsDebugging = false,
                    listener = createListener(CountDownLatch(1)),
                )
                assertFalse("file access must be disabled", webView.settings.allowFileAccess)
                assertFalse("content access must be disabled", webView.settings.allowContentAccess)
                assertFalse("file URL access must be disabled", webView.settings.allowFileAccessFromFileURLs)
                assertFalse("universal file URL access must be disabled", webView.settings.allowUniversalAccessFromFileURLs)
                assertEquals(
                    "mixed content must be disabled",
                    WebSettings.MIXED_CONTENT_NEVER_ALLOW,
                    webView.settings.mixedContentMode,
                )
                assertTrue("SPA needs javascript", webView.settings.javaScriptEnabled)
                assertTrue("SPA needs dom storage", webView.settings.domStorageEnabled)
                assertNotNull(webView.webViewClient)
            }
        }
    }

    @Test
    fun crossOriginTopLevelNavigationIsConsumedByThePolicy() {
        val origin = "https://fleet.example.com"
        val latch = CountDownLatch(1)
        val probe = createListener(latch)

        ActivityScenario.launch(Activity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val webView = HardenedWebView.create(
                    context = activity,
                    canonicalOrigin = origin,
                    debugAllowWebContentsDebugging = false,
                    listener = probe,
                )
                activity.setContentView(webView)
                // Programmatic loadUrl() does not traverse
                // shouldOverrideUrlLoading on modern WebView, so drive the
                // navigation the way the SPA/user does: a same-origin
                // document that redirects itself cross-origin. The override
                // must consume it before any network traffic.
                val redirector =
                    "<html><body><script>location.replace('https://other.example.com/somewhere');</script></body></html>"
                webView.loadDataWithBaseURL(origin + "/", redirector, "text/html", "utf-8", null)
            }

            assertTrue(
                "policy must consume the cross-origin request",
                latch.await(10, TimeUnit.SECONDS),
            )
            assertEquals("https://other.example.com/somewhere", probe.external)
            assertTrue(probe.blocked == null)
        }
    }
}
