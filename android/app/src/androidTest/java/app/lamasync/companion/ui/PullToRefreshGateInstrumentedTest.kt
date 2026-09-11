package app.lamasync.companion.ui

import android.app.Activity
import android.content.Context
import android.os.SystemClock
import android.view.MotionEvent
import android.webkit.WebView
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
 * LAMA-329 / LAMA-334 — the pull-to-refresh acceptance gate, against a real
 * WebView and a real container.
 *
 * Two rules have to hold at once:
 *
 *  1. "pull-to-refresh cannot fire while the page is scrolled away from top"
 *     (LAMA-329), and
 *  2. "it never steals a list gesture" (LAMA-334): a drag that begins low on
 *     the view is refused so an inner scroller — the phone layout's More sheet
 *     — receives it.
 *
 * Compose's `Modifier.pullToRefresh` cannot express either for a WebView (it is
 * nested-scroll driven, and an `AndroidView` host dispatches no nested scroll),
 * which is why the Manage destination uses [PullToRefreshLayout]. Both halves
 * are checked here through the production helper (`bindToWebView`), not a
 * replica of it.
 */
@RunWith(AndroidJUnit4::class)
class PullToRefreshGateInstrumentedTest {

    /** Widens the protected hook so the container's own answer can be read. */
    private class Probe(context: Context) : PullToRefreshLayout(context) {
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

    /**
     * Sends a real DOWN → MOVE… → UP gesture starting at [startY], as the
     * platform would, and returns whether the container ever claimed it. The
     * events are dispatched to the container so both the container's own
     * interception and the child's consuming behaviour are exercised.
     */
    private fun drag(
        scenario: ActivityScenario<Activity>,
        fixture: Fixture,
        startY: Float,
        distance: Float = 400f,
    ) {
        scenario.onActivity {
            val downTime = SystemClock.uptimeMillis()
            val x = fixture.probe.width / 2f
            fun event(action: Int, y: Float, offsetMs: Long) = MotionEvent.obtain(
                downTime,
                downTime + offsetMs,
                action,
                x,
                y,
                0,
            )
            fixture.probe.dispatchTouchEvent(event(MotionEvent.ACTION_DOWN, startY, 0))
            // Several moves: SwipeRefreshLayout only commits once the drag
            // passes the touch slop.
            for (step in 1..6) {
                val y = startY + distance * step / 6f
                fixture.probe.dispatchTouchEvent(event(MotionEvent.ACTION_MOVE, y, step * 16L))
            }
            fixture.probe.dispatchTouchEvent(event(MotionEvent.ACTION_UP, startY + distance, 120))
        }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
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

    // ---------------------------------------------------- LAMA-334 item 3

    @Test
    fun aGestureStartingInTheTopStripMayPull() {
        withWiredWebView { scenario, fixture ->
            val zone = mainThreadAnswerHeight(scenario, fixture, ::pullStartZone)
            assertTrue("the container must have been laid out", zone > 0f)

            scenario.onActivity {
                fixture.probe.dispatchTouchEvent(
                    MotionEvent.obtain(
                        SystemClock.uptimeMillis(),
                        SystemClock.uptimeMillis(),
                        MotionEvent.ACTION_DOWN,
                        fixture.probe.width / 2f,
                        zone / 2f,
                        0,
                    ),
                )
            }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()

            assertFalse(
                "a gesture that begins in the top strip must be able to become a pull",
                mainThreadAnswer(scenario) { fixture.probe.canChildScrollUp() },
            )
        }
    }

    @Test
    fun aGestureStartingBelowTheTopStripIsRefusedSoTheListKeepsIt() {
        withWiredWebView { scenario, fixture ->
            val zone = mainThreadAnswerHeight(scenario, fixture, ::pullStartZone)
            assertTrue("the container must have been laid out", zone > 0f)
            val startY = zone + 80f
            assertTrue(
                "the fixture must be tall enough to gesture below the strip",
                mainThreadAnswer(scenario) { fixture.probe.height.toFloat() } > startY,
            )
            assertTrue("the fixture page should start at the top", webViewAtScrollTop(fixture.webView))

            drag(scenario, fixture, startY = startY)

            assertFalse(
                "a drag that began below the top strip must not fire a refresh",
                fixture.refreshRequested,
            )
        }
    }

    @Test
    fun aGestureStartingInTheTopStripActuallyRefreshes() {
        withWiredWebView { scenario, fixture ->
            val zone = mainThreadAnswerHeight(scenario, fixture, ::pullStartZone)
            assertTrue("the container must have been laid out", zone > 0f)

            drag(scenario, fixture, startY = zone / 2f, distance = fixture.probePullDistance(scenario))

            assertTrue(
                "a long drag from the top strip must reach the refresh listener",
                fixture.refreshRequested,
            )
        }
    }

    private fun Fixture.probePullDistance(scenario: ActivityScenario<Activity>): Float {
        var distance = 400f
        scenario.onActivity {
            distance = (probe.height * 0.6f).coerceAtLeast(400f)
        }
        return distance
    }

    private fun mainThreadAnswerHeight(
        scenario: ActivityScenario<Activity>,
        fixture: Fixture,
        compute: (Int, Float) -> Float,
    ): Float {
        var answer = 0f
        scenario.onActivity {
            answer = compute(fixture.probe.height, fixture.probe.resources.displayMetrics.density)
        }
        return answer
    }

    private companion object {
        const val ORIGIN = "https://fleet.example.com"

        fun pullStartZone(heightPx: Int, density: Float): Float =
            app.lamasync.companion.ui.pullStartZonePx(heightPx, density)

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
