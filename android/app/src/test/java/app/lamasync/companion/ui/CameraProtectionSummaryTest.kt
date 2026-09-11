package app.lamasync.companion.ui

import app.lamasync.companion.media.AutoProtectSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LAMA-329 — the Settings screen's camera-protection summary.
 *
 * Settings must not claim more than the stores know: "off" has to be said out
 * loud, and a pending count must only appear when there really is one.
 */
class CameraProtectionSummaryTest {

    private fun state(
        photos: Boolean = false,
        videos: Boolean = false,
        screenshots: Boolean = false,
        pending: Long = 0L,
    ) = AutoProtectViewModel.AutoProtectUiState(
        settings = AutoProtectSettings(
            cameraPhotosEnabled = photos,
            cameraVideosEnabled = videos,
            screenshotsEnabled = screenshots,
        ),
        pendingAutoCount = pending,
    )

    @Test
    fun `nothing enabled says so instead of implying protection`() {
        assertEquals(
            "Off — nothing is being protected automatically",
            cameraProtectionSummary(state()),
        )
    }

    @Test
    fun `the summary lists only the enabled sources`() {
        assertEquals("On for photos", cameraProtectionSummary(state(photos = true)))
        assertEquals(
            "On for photos, screenshots",
            cameraProtectionSummary(state(photos = true, screenshots = true)),
        )
        assertEquals(
            "On for photos, videos, screenshots",
            cameraProtectionSummary(state(photos = true, videos = true, screenshots = true)),
        )
    }

    @Test
    fun `a pending count is reported only when there is one`() {
        assertEquals(
            "On for videos",
            cameraProtectionSummary(state(videos = true, pending = 0L)),
        )
        assertEquals(
            "On for videos · 1 item pending",
            cameraProtectionSummary(state(videos = true, pending = 1L)),
        )
        assertEquals(
            "On for videos · 4 items pending",
            cameraProtectionSummary(state(videos = true, pending = 4L)),
        )
    }

    @Test
    fun `a pending count cannot leak into the disabled summary`() {
        // Nothing is enabled, so a stale count must not be presented as work
        // that is in progress.
        val summary = cameraProtectionSummary(state(pending = 9L))
        assertTrue(summary.startsWith("Off"))
        assertTrue(!summary.contains("9"))
    }
}
