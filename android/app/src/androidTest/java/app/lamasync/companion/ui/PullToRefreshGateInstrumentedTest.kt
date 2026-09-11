package app.lamasync.companion.ui

import android.app.Activity
import android.content.Context
import android.webkit.WebView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lamasync.companion.web.HardenedWebView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-329 — the pull-to-refresh acceptance gate, against a real WebView.
 *
 * The gate is "pull-to-refresh cannot fire while a nested page is scrolled away
 * from top". Compose's `Modifier.pullToRefresh` cannot express that for a
 * WebView (it is nested-scroll driven, and an `AndroidView` host dispatches no
 * nested scroll), which is why the Manage destination uses
 * `SwipeRefreshLayout.setOnChildScrollUpCallback`. That wiring is only
 * meaningful if the callback is consulted and actually reports the page
 * position, so both halves are checked here through the production helper
 * (`bindToWebView`), not a replica of it.
 */
@RunWith(AndroidJUnit4::class)
class PullToRefreshGateInstrumentedTest {

    /** Widens the protected hook so the container's own answer can be read. */
    private class Probe(context: Context) : SwipeRefreshLayout(context) {
        override fun canChildScrollUp(): Boolean = super.canChildScrollUp()
    }

    private class LoadListener : HardenedWebView.Listener {
        val settled = CountDownLatch(1)
        override fun onOpenExternally(url: String) = Unit
        override fun onBlockedNavigation(url: String) = Unit
        override fun onBlockedSsl(url: String) = Unit
        override fun onPageTitle(title: String?) = Unit
        override fun onWebStateChanged(canGoBack: Boolean, loading: Boolean) {
            // onPageFinished / doUpdateVisitedHistory arrive with loading = false.
            if (!loading) settled.countDown()
        }
    }

    private class Fixture {
        lateinit var webView: WebView
        lateinit var probe: Probe
        val listener = LoadListener()
        var refreshRequested = false
    }

    /**
     * Builds the production container/WebView pair. `body` runs OUTSIDE
     * `onActivity` so the test thread never blocks the main thread — a latch
     * counted down by a main-thread WebView callback would otherwise deadlock.
     */
    private fun withWiredWebView(body: (ActivityScenario<Activity>, Fixture) -> Unit) {
        ActivityScenario.launch(Activity::class.java).use { scenario ->
            val fixture = Fixture()
            scenario.onActivity { activity ->
                val webView = HardenedWebView.create(
                    context = activity,
                    canonicalOrigin = ORIGIN,
                    debugAllowWebContentsDebugging = false,
                    listener = fixture.listener,
                )
                val probe = Probe(activity).apply {
                    bindToWebView(webView) { fixture.refreshRequested = true }
                }
                activity.setContentView(probe)
                fixture.webView = webView
                fixture.probe = probe
            }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            body(scenario, fixture)
        }
    }

    private fun loadTallPage(scenario: ActivityScenario<Activity>, fixture: Fixture) {
        scenario.onActivity {
            fixture.webView.loadDataWithBaseURL(
                "$ORIGIN/",
                "<html><body style=\"margin:0\">" +
                    "<div style=\"height:6000px;background:#123456\"></div>" +
                    "</body></html>",
                "text/html",
                "utf-8",
                null,
            )
        }
        assertTrue(
            "the tall fixture page never finished loading",
            fixture.listener.settled.await(20, TimeUnit.SECONDS),
        )
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    private fun mainThreadAnswer(scenario: ActivityScenario<Activity>, read: () -> Boolean): Boolean {
        var answer = false
        scenario.onActivity { answer = read() }
        return answer
    }

    @Test
    fun aPageAtTheTopMayBePulled() {
        withWiredWebView { _, fixture ->
            assertTrue(webViewAtScrollTop(fixture.webView))
            assertFalse(
                "the container must allow a pull when the page is at the top",
                fixture.probe.canChildScrollUp(),
            )
        }
    }

    @Test
    fun aPageScrolledDownRefusesThePull() {
        withWiredWebView { scenario, fixture ->
            loadTallPage(scenario, fixture)

            // Scroll the document away from the top. A WebView scrolls itself,
            // so its `scrollY` IS the page position. The retry loop absorbs the
            // frame or two the tall content needs before it becomes scrollable.
            val scrolled = pollUntil(timeoutMillis = 5_000) {
                scenario.onActivity { fixture.webView.scrollTo(0, 800) }
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                !mainThreadAnswer(scenario) { webViewAtScrollTop(fixture.webView) }
            }
            assertTrue("the fixture never managed to scroll the page", scrolled)

            assertTrue(
                "the container must refuse a pull while the page is scrolled down",
                mainThreadAnswer(scenario) { fixture.probe.canChildScrollUp() },
            )
            assertFalse(
                "refusing the pull must not have fired a refresh",
                fixture.refreshRequested,
            )
        }
    }

    private companion object {
        const val ORIGIN = "https://fleet.example.com"

        fun pollUntil(timeoutMillis: Long, condition: () -> Boolean): Boolean {
            val deadline = System.currentTimeMillis() + timeoutMillis
            while (System.currentTimeMillis() < deadline) {
                if (condition()) return true
                Thread.sleep(50)
            }
            return condition()
        }
    }
}
