package app.lamasync.companion.ui

import android.content.Context
import android.view.MotionEvent
import android.webkit.WebView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/**
 * LAMA-334 — a pull-to-refresh container that cannot steal a list gesture.
 *
 * [SwipeRefreshLayout] decides whether a drag may become a pull by asking
 * `canChildScrollUp()`. Around a WebView that answer can only see the
 * DOCUMENT's scroll position, so a touch inside a fixed overlay that owns its
 * own scroller — the phone layout's "More" sheet is exactly that — reads as
 * "the page is at the top" and the drag is stolen from the list. The report is
 * precise: dragging *down* inside the More list (which scrolls the list *up*)
 * started a refresh instead of scrolling.
 *
 * Native code cannot hit-test the DOM, and this app deliberately has no
 * JavaScript bridge (`web/HardenedWebView.kt`), so the question is answered
 * with the two facts the container can observe:
 *
 *  1. the document must be at scroll top ([webViewAtScrollTop]) — unchanged
 *     from LAMA-329; and
 *  2. the gesture must BEGIN in the top strip of the view ([pullStartZonePx]),
 *     which is above every overlay the SPA renders. The More sheet is
 *     `max-height: 82dvh` and bottom-anchored, so its top edge sits at 18% of
 *     the viewport and its scrollable list starts below that; the strip is
 *     capped at 16% so the two cannot meet even if a future sheet grows.
 *
 * A pull that starts lower is refused, which is what lets an inner scroller
 * receive the drag. See `docs/android-mobile-ux-plan.md` (decision 17) for the
 * alternatives that were considered and why this one shipped.
 *
 * The gate is a pure function ([pullMayStart]) so it is unit-testable, and the
 * layout records the gesture's down position before consulting it, so the
 * answer is never computed from a previous gesture's coordinates.
 */
internal class PullToRefreshLayout(context: Context) : SwipeRefreshLayout(context) {

    /** Where the current gesture began, in view coordinates (-1 = none yet). */
    private var gestureDownY = -1f

    /** The host's at-scroll-top test (the WebView's own document position). */
    var atScrollTop: () -> Boolean = { true }

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        // Recorded BEFORE super consults canChildScrollUp(): SwipeRefreshLayout
        // decides at ACTION_DOWN whether the gesture can ever become a pull, so
        // a stale down position would disable the next gesture too.
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) {
            gestureDownY = ev.y
        }
        return super.onInterceptTouchEvent(ev)
    }

    override fun canChildScrollUp(): Boolean =
        !pullMayStart(
            downY = gestureDownY,
            zonePx = pullStartZonePx(height, resources.displayMetrics.density),
            atScrollTop = atScrollTop(),
        )

    /** Test seam: the down position the gate will be asked about. */
    internal fun gestureDownY(): Float = gestureDownY
}

/**
 * Whether a gesture that began at [downY] may become a pull.
 *
 * Refused when the document is scrolled away from the top (the LAMA-329 rule),
 * when the position is unknown, and when the gesture began below the top strip.
 */
internal fun pullMayStart(downY: Float, zonePx: Float, atScrollTop: Boolean): Boolean {
    if (!atScrollTop) return false
    if (downY < 0f) return false
    return downY <= zonePx
}

/**
 * Height of the top strip a pull may start in: 16% of the view, capped at
 * 120dp so a tablet does not hand half its height to the gesture.
 *
 * There is deliberately NO floor. The strip's whole job is to stay above the
 * phone layout's More sheet, whose top edge is at 18% of the viewport; a dp
 * floor would win over the fraction on a short view (48dp is more than 18% of
 * a 480px-tall window at density 2.5) and the two would meet again. A cap can
 * only shrink the strip, so `zone < 0.16 * viewHeight < sheetTop` holds at
 * every height — which is what [PullToRefreshGateTest] asserts.
 */
internal fun pullStartZonePx(viewHeightPx: Int, density: Float): Float {
    if (viewHeightPx <= 0) return 0f
    return minOf(
        viewHeightPx * MAX_PULL_START_FRACTION,
        MAX_PULL_START_ZONE_DP * density,
    )
}

internal const val MAX_PULL_START_FRACTION = 0.16f
internal const val MAX_PULL_START_ZONE_DP = 120f

/**
 * Wires [webView] into this pull-to-refresh container exactly as the Manage
 * destination does.
 *
 * Extracted so the acceptance gate ("pull-to-refresh cannot fire while a
 * nested page is scrolled away from top, and never steals a list scroll") can
 * be tested against a real `SwipeRefreshLayout` and a real `WebView` rather
 * than only reasoned about.
 */
internal fun PullToRefreshLayout.bindToWebView(webView: WebView, onRefresh: () -> Unit) {
    addView(webView)
    atScrollTop = { webViewAtScrollTop(webView) }
    setOnRefreshListener(onRefresh)
}
