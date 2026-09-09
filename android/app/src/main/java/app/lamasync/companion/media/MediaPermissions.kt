package app.lamasync.companion.media

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * LAMA-296 stage 2 — media permission scope, checked LIVE (per scan, per
 * resume) exactly as the official docs require — never trusted from stored
 * state, because the user can switch full/partial/denied access in settings
 * without the app knowing (auto-reset, hibernation, settings changes,
 * partial-access expiry).
 *
 * Scope semantics (Android 14+ partial photo/video access):
 *  - FULL: READ_MEDIA_IMAGES or READ_MEDIA_VIDEO granted (API ≤32:
 *    READ_EXTERNAL_STORAGE) — the collection queries see the whole library.
 *  - PARTIAL: only READ_MEDIA_VISUAL_USER_SELECTED granted — queries are
 *    restricted to the user-selected subset; coverage claims are scoped to
 *    whatever is actually queried, and the UI asks for full access.
 *  - NOT_GRANTED: discovery pauses with an actionable waiting reason.
 */
enum class MediaPermissionScope { NOT_GRANTED, PARTIAL, FULL }

object MediaPermissions {

    const val PERM_IMAGES = Manifest.permission.READ_MEDIA_IMAGES
    const val PERM_VIDEO = Manifest.permission.READ_MEDIA_VIDEO
    const val PERM_SELECTED = Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
    const val PERM_EXTERNAL = Manifest.permission.READ_EXTERNAL_STORAGE

    /**
     * Pure scope derivation — fully JVM-testable. [granted] are the runtime
     * permissions the app currently holds; [sdkInt] selects the tier.
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