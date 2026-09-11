package app.lamasync.companion.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LAMA-334 item 3 — the pull-to-refresh arming gate, off-device.
 *
 * The reported defect is a stolen gesture: dragging DOWN inside the phone
 * layout's "More" sheet scrolls the sheet UP, and the container read that as a
 * pull because the document underneath was at scroll top. These cases pin the
 * two facts the gate is allowed to use, and the margin that keeps the sheet's
 * list outside the strip a gesture may start in.
 */
class PullToRefreshGateTest {

    private val density = 2.5f

    @Test
    fun `a gesture that starts at the top of an at-top page may pull`() {
        assertTrue(
            pullMayStart(downY = 0f, zonePx = pullStartZonePx(900, density), atScrollTop = true),
        )
        assertTrue(
            pullMayStart(downY = 40f, zonePx = pullStartZonePx(900, density), atScrollTop = true),
        )
    }

    @Test
    fun `a gesture that starts lower on the page never pulls, even at scroll top`() {
        val zone = pullStartZonePx(900, density)
        // The More sheet's list lives well below the strip; this is the case
        // that used to be intercepted and must now scroll the list instead.
        assertFalse(pullMayStart(downY = zone + 1f, zonePx = zone, atScrollTop = true))
        assertFalse(pullMayStart(downY = 700f, zonePx = zone, atScrollTop = true))
    }

    @Test
    fun `a page scrolled away from the top never pulls, wherever the gesture starts`() {
        assertFalse(pullMayStart(downY = 0f, zonePx = 200f, atScrollTop = false))
        assertFalse(pullMayStart(downY = 20f, zonePx = 200f, atScrollTop = false))
    }

    @Test
    fun `an unknown down position is refused rather than assumed`() {
        // -1 means "no gesture has begun"; treating it as 0 would arm a pull
        // for a touch we know nothing about.
        assertFalse(pullMayStart(downY = -1f, zonePx = 200f, atScrollTop = true))
    }

    @Test
    fun `the strip is a fraction of the view, capped on a tablet`() {
        // Fractional at phone heights: 16% of the view.
        assertEquals(960f * MAX_PULL_START_FRACTION, pullStartZonePx(960, density), 0.01f)
        // Capped so a tablet does not get half the screen.
        assertEquals(MAX_PULL_START_ZONE_DP * density, pullStartZonePx(4000, density), 0.01f)
        // Degenerate views report no strip rather than a negative one, which
        // also means an unmeasured view can never arm a pull.
        assertEquals(0f, pullStartZonePx(0, density), 0.01f)
    }

    @Test
    fun `the strip stays above the sheet that owns the list gesture`() {
        // The phone layout's More sheet is `max-height: 82dvh` and bottom
        // anchored, so its top edge is at 18% of the viewport and its
        // scrollable list starts below its head. The strip must stay strictly
        // above that at EVERY view height, which is why it has no dp floor.
        for (heightPx in intArrayOf(200, 480, 640, 800, 915, 1080, 1440, 2200, 4000)) {
            val zone = pullStartZonePx(heightPx, density)
            val sheetTop = heightPx * 0.18f
            assertTrue(
                "strip $zone must stay above the sheet top $sheetTop at ${heightPx}px",
                zone < sheetTop,
            )
        }
    }
}
