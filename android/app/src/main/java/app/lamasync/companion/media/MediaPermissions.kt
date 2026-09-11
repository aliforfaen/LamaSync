package app.lamasync.companion.media

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import app.lamasync.companion.media.MediaCollection.IMAGES
import app.lamasync.companion.media.MediaCollection.VIDEOS

/**
 * LAMA-296 stage 2 — media permission scope, checked LIVE (per scan, per
 * resume) exactly as the official docs require — never trusted from stored
 * state, because the user can switch full/partial/denied access in settings
 * without the app knowing (auto-reset, hibernation, settings changes,
 * partial-access expiry).
 *
 * Scope semantics (Android 14+ partial photo/video access):
 *  - Scope is AUTHORITATIVE PER COLLECTION. `READ_MEDIA_IMAGES` grants
 *    FULL authority over the IMAGES collection only; `READ_MEDIA_VIDEO`
 *    grants FULL authority over the VIDEOS collection only. If photos are
 *    granted but videos denied (or vice-versa) while BOTH sources are
 *    enabled, the denied collection must NOT be scanned, must NOT be
 *    declared deleted, and must NOT count as covered — otherwise the worker
 *    would silently scan hidden videos and the UI would claim full camera
 *    coverage it does not have.
 *  - PARTIAL: only `READ_MEDIA_VISUAL_USER_SELECTED` granted — queries are
 *    restricted to the user-selected subset for BOTH collections; coverage
 *    claims are scoped to whatever is actually queried, and the UI asks for
 *    full access.
 *  - NOT_GRANTED: discovery pauses with an actionable waiting reason.
 */
enum class MediaPermissionScope { NOT_GRANTED, PARTIAL, FULL }

object MediaPermissions {

    const val PERM_IMAGES = Manifest.permission.READ_MEDIA_IMAGES
    const val PERM_VIDEO = Manifest.permission.READ_MEDIA_VIDEO
    const val PERM_SELECTED = Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
    const val PERM_EXTERNAL = Manifest.permission.READ_EXTERNAL_STORAGE

    /**
     * Per-collection scope derivation — fully JVM-testable. [granted] are the
     * runtime permissions the app currently holds; [sdkInt] selects the tier.
     *
     * - API ≥ 33: the collection's OWN read permission grants FULL for it.
     *   Selected-photos access (`READ_MEDIA_VISUAL_USER_SELECTED`, API ≥ 34)
     *   grants PARTIAL for both collections.
     * - API ≤ 32: `READ_EXTERNAL_STORAGE` grants FULL for both collections.
     */
    fun scopeForCollection(
        collection: MediaCollection,
        granted: Set<String>,
        sdkInt: Int,
    ): MediaPermissionScope {
        if (sdkInt >= Build.VERSION_CODES.TIRAMISU) {
            val specific = if (collection == IMAGES) PERM_IMAGES else PERM_VIDEO
            if (specific in granted) return MediaPermissionScope.FULL
            if (sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && PERM_SELECTED in granted) {
                return MediaPermissionScope.PARTIAL
            }
            return MediaPermissionScope.NOT_GRANTED
        }
        return if (PERM_EXTERNAL in granted) MediaPermissionScope.FULL else MediaPermissionScope.NOT_GRANTED
    }

    /**
     * Live per-collection scope for every collection the app can scan.
     * Defensive: returns NOT_GRANTED for any collection not present.
     */
    fun currentScopes(context: Context): Map<MediaCollection, MediaPermissionScope> {
        val granted = currentlyGranted(context)
        val sdk = Build.VERSION.SDK_INT
        return MediaCollection.entries.associateWith { scopeForCollection(it, granted, sdk) }
    }

    /** True when ANY enabled collection is currently accessible. */
    fun anyAccessible(
        granted: Set<String>,
        sdkInt: Int,
        photosEnabled: Boolean,
        videosEnabled: Boolean,
        screenshotsEnabled: Boolean,
    ): Boolean {
        val needsImages = photosEnabled || screenshotsEnabled
        val needsVideos = videosEnabled || screenshotsEnabled
        if (needsImages && scopeForCollection(IMAGES, granted, sdkInt) != MediaPermissionScope.NOT_GRANTED) return true
        if (needsVideos && scopeForCollection(VIDEOS, granted, sdkInt) != MediaPermissionScope.NOT_GRANTED) return true
        return false
    }

    /**
     * Pure [scopeOf] retained for single-collection/legacy callers: returns
     * FULL when EITHER images or video read is granted (API ≤32:
     * READ_EXTERNAL_STORAGE). Prefer [scopeForCollection] for discovery.
     */
    fun scopeOf(granted: Set<String>, sdkInt: Int): MediaPermissionScope {
        if (sdkInt >= Build.VERSION_CODES.TIRAMISU) {
            if (PERM_IMAGES in granted || PERM_VIDEO in granted) return MediaPermissionScope.FULL
            if (sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && PERM_SELECTED in granted) {
                return MediaPermissionScope.PARTIAL
            }
            return MediaPermissionScope.NOT_GRANTED
        }
        return if (PERM_EXTERNAL in granted) MediaPermissionScope.FULL else MediaPermissionScope.NOT_GRANTED
    }

    /** Live check against the platform's current grant state. */
    fun current(context: Context): MediaPermissionScope =
        scopeOf(currentlyGranted(context), Build.VERSION.SDK_INT)

    private fun currentlyGranted(context: Context): Set<String> {
        val granted = mutableSetOf<String>()
        if (ContextCompat.checkSelfPermission(context, PERM_IMAGES) == PackageManager.PERMISSION_GRANTED) granted += PERM_IMAGES
        if (ContextCompat.checkSelfPermission(context, PERM_VIDEO) == PackageManager.PERMISSION_GRANTED) granted += PERM_VIDEO
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            ContextCompat.checkSelfPermission(context, PERM_SELECTED) == PackageManager.PERMISSION_GRANTED
        ) {
            granted += PERM_SELECTED
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, PERM_EXTERNAL) == PackageManager.PERMISSION_GRANTED
        ) {
            granted += PERM_EXTERNAL
        }
        return granted
    }

    /** The runtime permissions to request in ONE system dialog (per docs). */
    fun requestList(sdkInt: Int): Array<String> = when {
        sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
            arrayOf(PERM_IMAGES, PERM_VIDEO, PERM_SELECTED)
        sdkInt >= Build.VERSION_CODES.TIRAMISU ->
            arrayOf(PERM_IMAGES, PERM_VIDEO)
        else -> arrayOf(PERM_EXTERNAL)
    }

    /**
     * The runtime permissions to request, limited to what the ENABLED sources
     * actually need. Requesting videos permission while only camera photos
     * are enabled (or vice-versa) would prompt for a collection the app is
     * told not to scan — so we ask only for the collections the user turned
     * on. Selected-photos access is offered only on API ≥ 34, and only when
     * at least one collection is enabled.
     */
    fun requestList(
        sdkInt: Int,
        photosEnabled: Boolean,
        videosEnabled: Boolean,
    ): Array<String> {
        if (sdkInt >= Build.VERSION_CODES.TIRAMISU) {
            val list = mutableListOf<String>()
            if (photosEnabled) list += PERM_IMAGES
            if (videosEnabled) list += PERM_VIDEO
            if (sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && list.isNotEmpty()) {
                list += PERM_SELECTED
            }
            return list.toTypedArray()
        }
        return arrayOf(PERM_EXTERNAL)
    }

    /** Human guidance for the scope state shown in the setup surface. */
    fun guidance(scope: MediaPermissionScope): String = when (scope) {
        MediaPermissionScope.FULL -> "Full media access granted."
        MediaPermissionScope.PARTIAL ->
            "Only the photos and videos you selected are accessible. For the whole camera roll, " +
                "choose “Allow all” in the next prompt or in App settings."
        MediaPermissionScope.NOT_GRANTED ->
            "Media access is required to protect your camera. Grant access when prompted."
    }
}