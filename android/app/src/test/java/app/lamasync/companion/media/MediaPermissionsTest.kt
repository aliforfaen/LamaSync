package app.lamasync.companion.media

import android.os.Build
import org.junit.Assert.assertEquals
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
}