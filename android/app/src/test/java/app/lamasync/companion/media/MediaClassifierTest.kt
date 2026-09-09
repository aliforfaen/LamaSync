package app.lamasync.companion.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Camera/screenshot classification from RELATIVE_PATH (API 29+) and DATA
 *  (API ≤28 fallback), plus source assignment. */
class MediaClassifierTest {

    private fun classify(rel: String?, data: String?): MediaClassifier.Classification =
        MediaClassifier.classify(rel, data)

    @Test
    fun cameraPathsUnderDcimCameraClassifyAsCamera() {
        assertTrue(classify("DCIM/Camera", null).isCamera)
        assertTrue(classify("DCIM/Camera/IMG_0001.jpg", null).isCamera)
        assertTrue(classify("DCIM/Camera/VID_0001.mp4", null).isCamera)
        assertFalse(classify("DCIM/CameraX", null).isCamera)
        assertFalse(classify("DCIM/Other", null).isCamera)
    }

    @Test
    fun cameraFallbackMatchesAbsoluteDataPath() {
        assertTrue(classify(null, "/storage/emulated/0/DCIM/Camera/IMG_0001.jpg").isCamera)
        assertTrue(classify(null, "/storage/emulated/0/DCIM/Camera/VID_0001.mp4").isCamera)
        assertFalse(classify(null, "/storage/emulated/0/Pictures/IMG_0001.jpg").isCamera)
    }

    @Test
    fun screenshotsMatchAnyScreenshotsDirectorySegment() {
        assertTrue(classify("Pictures/Screenshots/Screenshot_001.png", null).isScreenshot)
        assertTrue(classify("DCIM/Screenshots/s.png", null).isScreenshot)
        assertFalse(classify("Pictures/ScrEenshotsInternal", null).isScreenshot)
        assertTrue(classify(null, "/storage/emulated/0/Pictures/Screenshots/s.png").isScreenshot)
    }

    @Test
    fun relPathWinsOverDataPath() {
        // A row that moved is classified by RELATIVE_PATH (authoritative).
        val c = classify("DCIM/Camera/x.jpg", "/storage/emulated/0/Downloads/x.jpg")
        assertTrue(c.isCamera)
    }

    @Test
    fun sourceAssignmentRespectsEnabledTogglesAndCollection() {
        val cameraPhoto = classify("DCIM/Camera/p.jpg", null)
        val cameraVideo = classify("DCIM/Camera/v.mp4", null)
        val shot = classify("Pictures/Screenshots/s.png", null)

        fun src(cl: MediaClassifier.Classification, col: MediaCollection, photo: Boolean, video: Boolean, shot: Boolean): AutoSource? =
            MediaClassifier.sourceOf(cl, col, photo, video, shot)

        // Photos enabled only: camera images belong; camera videos do not.
        assertEquals(AutoSource.CAMERA_PHOTOS, src(cameraPhoto, MediaCollection.IMAGES, true, false, false))
        assertNull(src(cameraVideo, MediaCollection.VIDEOS, true, false, false))
        assertNull(src(cameraPhoto, MediaCollection.IMAGES, false, true, false))

        // Videos enabled: camera videos belong.
        assertEquals(AutoSource.CAMERA_VIDEOS, src(cameraVideo, MediaCollection.VIDEOS, false, true, false))

        // Screenshots (other toggle off / on).
        assertNull(src(shot, MediaCollection.IMAGES, true, true, false))
        assertEquals(AutoSource.SCREENSHOTS, src(shot, MediaCollection.IMAGES, true, true, true))
        // A screenshot-with-camera-path oddity: camera wins (it IS in Camera).
        assertEquals(AutoSource.CAMERA_PHOTOS, src(classify("DCIM/Camera/Screenshot_001.png", null), MediaCollection.IMAGES, true, false, true))
    }

    @Test
    fun unknownPathsAreNeverClaimed() {
        val c = classify("Documents/notes.pdf", null)
        assertFalse(c.isCamera)
        assertFalse(c.isScreenshot)
    }
}