package app.lamasync.companion.media

import android.os.Build
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Permission scope derivation — live-check semantics across API tiers. */
class MediaPermissionsTest {

    private fun scopeAt(granted: Set<String>, sdk: Int) = MediaPermissions.scopeOf(granted, sdk)

    @Test
    fun api35FullRequiresImagesOrVideo() {
        assertEquals(MediaPermissionScope.FULL, scopeAt(setOf(MediaPermissions.PERM_IMAGES), 35))
        assertEquals(MediaPermissionScope.FULL, scopeAt(setOf(MediaPermissions.PERM_VIDEO), 35))
        assertEquals(MediaPermissionScope.FULL, scopeAt(setOf(MediaPermissions.PERM_IMAGES, MediaPermissions.PERM_VIDEO), 35))
    }

    @Test
    fun api34PartialOnlyWithSelectedPermission() {
        val sdk = Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        assertEquals(MediaPermissionScope.FULL, scopeAt(setOf(MediaPermissions.PERM_IMAGES), sdk))
        assertEquals(
            MediaPermissionScope.PARTIAL,
            scopeAt(setOf(MediaPermissions.PERM_SELECTED), sdk),
        )
        // Both partial and full: full wins.
        assertEquals(
            MediaPermissionScope.FULL,
            scopeAt(setOf(MediaPermissions.PERM_SELECTED, MediaPermissions.PERM_IMAGES), sdk),
        )
    }

    @Test
    fun api33NoPartialConcept() {
        val sdk = Build.VERSION_CODES.TIRAMISU
        assertEquals(MediaPermissionScope.NOT_GRANTED, scopeAt(setOf(MediaPermissions.PERM_SELECTED), sdk))
        assertEquals(MediaPermissionScope.NOT_GRANTED, scopeAt(emptySet(), sdk))
    }

    @Test
    fun api32UsesExternalStorage() {
        val sdk = Build.VERSION_CODES.S_V2
        assertEquals(MediaPermissionScope.FULL, scopeAt(setOf(MediaPermissions.PERM_EXTERNAL), sdk))
        assertEquals(MediaPermissionScope.NOT_GRANTED, scopeAt(setOf(MediaPermissions.PERM_IMAGES), sdk))
    }

    @Test
    fun deniedIsNeverFull() {
        assertEquals(MediaPermissionScope.NOT_GRANTED, scopeAt(emptySet(), 35))
        assertEquals(MediaPermissionScope.NOT_GRANTED, scopeAt(emptySet(), 33))
        assertEquals(MediaPermissionScope.NOT_GRANTED, scopeAt(emptySet(), 29))
    }

    @Test
    fun requestListIsOneDialogPerTier() {
        assertEquals(3, MediaPermissions.requestList(35).size)
        assertEquals(2, MediaPermissions.requestList(33).size)
        assertEquals(1, MediaPermissions.requestList(29).size)
    }

    // ---- P0-3: authority is PER COLLECTION, not global ----

    private fun perCollection(granted: Set<String>, sdk: Int) = MediaPermissions.scopeForCollection(granted = granted, sdkInt = sdk, collection = MediaCollection.IMAGES) to
        MediaPermissions.scopeForCollection(granted = granted, sdkInt = sdk, collection = MediaCollection.VIDEOS)

    @Test
    fun imagesOnlyGrantGivesFullImagesButNotVideos() {
        val sdk = Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        val (images, videos) = perCollection(setOf(MediaPermissions.PERM_IMAGES), sdk)
        assertEquals(MediaPermissionScope.FULL, images)
        assertEquals(MediaPermissionScope.NOT_GRANTED, videos)
    }

    @Test
    fun videosOnlyGrantGivesFullVideosButNotImages() {
        val sdk = Build.VERSION_CODES.TIRAMISU
        val (images, videos) = perCollection(setOf(MediaPermissions.PERM_VIDEO), sdk)
        assertEquals(MediaPermissionScope.NOT_GRANTED, images)
        assertEquals(MediaPermissionScope.FULL, videos)
    }

    @Test
    fun bothGrantsGiveFullForBoth() {
        val sdk = Build.VERSION_CODES.TIRAMISU
        val (images, videos) = perCollection(setOf(MediaPermissions.PERM_IMAGES, MediaPermissions.PERM_VIDEO), sdk)
        assertEquals(MediaPermissionScope.FULL, images)
        assertEquals(MediaPermissionScope.FULL, videos)
    }

    @Test
    fun selectedPhotosAccessIsPartialForBothCollections() {
        val sdk = Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        val (images, videos) = perCollection(setOf(MediaPermissions.PERM_SELECTED), sdk)
        assertEquals(MediaPermissionScope.PARTIAL, images)
        assertEquals(MediaPermissionScope.PARTIAL, videos)
        // Partial + one specific grant: that collection becomes FULL, the
        // other stays PARTIAL (selected access still covers it).
        val (images2, videos2) = perCollection(setOf(MediaPermissions.PERM_SELECTED, MediaPermissions.PERM_VIDEO), sdk)
        assertEquals(MediaPermissionScope.PARTIAL, images2)
        assertEquals(MediaPermissionScope.FULL, videos2)
    }

    @Test
    fun revokedTransitionsReturnToNotGrantedPerCollection() {
        val sdk = Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        // Revoked entirely: both denied.
        assertEquals(MediaPermissionScope.NOT_GRANTED to MediaPermissionScope.NOT_GRANTED, perCollection(emptySet(), sdk))
        // Videos revoked but photos kept.
        assertEquals(MediaPermissionScope.FULL to MediaPermissionScope.NOT_GRANTED, perCollection(setOf(MediaPermissions.PERM_IMAGES), sdk))
    }

    @Test
    fun pre33ExternalStorageGrantsBothCollections() {
        val sdk = Build.VERSION_CODES.S_V2
        assertEquals(
            MediaPermissionScope.FULL to MediaPermissionScope.FULL,
            perCollection(setOf(MediaPermissions.PERM_EXTERNAL), sdk),
        )
        assertEquals(
            MediaPermissionScope.NOT_GRANTED to MediaPermissionScope.NOT_GRANTED,
            perCollection(emptySet(), sdk),
        )
    }

    @Test
    fun requestListOnlyAsksForEnabledSources() {
        val sdk = Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        // Photos only: no video permission requested.
        val photosOnly = MediaPermissions.requestList(sdk, photosEnabled = true, videosEnabled = false)
        assertTrue(MediaPermissions.PERM_IMAGES in photosOnly)
        assertFalse(MediaPermissions.PERM_VIDEO in photosOnly)
        assertTrue(MediaPermissions.PERM_SELECTED in photosOnly)
        // Videos only.
        val videosOnly = MediaPermissions.requestList(sdk, photosEnabled = false, videosEnabled = true)
        assertTrue(MediaPermissions.PERM_VIDEO in videosOnly)
        assertFalse(MediaPermissions.PERM_IMAGES in videosOnly)
        // Both enabled: both requested (plus selected access).
        val both = MediaPermissions.requestList(sdk, photosEnabled = true, videosEnabled = true)
        assertEquals(3, both.size)
    }

    @Test
    fun anyAccessibleReflectsEnabledSources() {
        val sdk = Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        val granted = setOf(MediaPermissions.PERM_IMAGES)
        // Photos+screenshots enabled: images grant is enough.
        assertTrue(
            MediaPermissions.anyAccessible(granted, sdk, photosEnabled = true, videosEnabled = true, screenshotsEnabled = false),
        )
        // Videos-only app with no video permission: nothing accessible.
        assertFalse(
            MediaPermissions.anyAccessible(granted, sdk, photosEnabled = false, videosEnabled = true, screenshotsEnabled = false),
        )
    }
}