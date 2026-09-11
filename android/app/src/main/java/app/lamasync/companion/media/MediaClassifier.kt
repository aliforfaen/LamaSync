package app.lamasync.companion.media

/**
 * LAMA-296 stage 2 — pure media classification. Camera media lives under
 * `DCIM/Camera` (the Android camera contract: Google Camera, Samsung Camera
 * and OEM variants all land there); screenshots live under `Pictures/
 * Screenshots` (with OEM variants such as `DCIM/Screenshots`). Pre-API-29
 * devices have no RELATIVE_PATH column, so the absolute DATA path is the
 * fallback (documented primary-volume-only caveat in the spec).
 *
 * Classification is deliberately conservative and documented: it matches on
 * path segments, never guesses from MIME only, and unknown paths are never
 * claimed by a source.
 */
object MediaClassifier {

    data class Classification(
        val isCamera: Boolean = false,
        val isScreenshot: Boolean = false,
    )

    /** True when [relativePath] or [dataPath] denotes the camera directory. */
    fun isCamera(relativePath: String?, dataPath: String?): Boolean {
        if (!relativePath.isNullOrBlank()) {
            val p = relativePath.trim().trimEnd('/')
            return p == "DCIM/Camera" || p.startsWith("DCIM/Camera/")
        }
        if (!dataPath.isNullOrBlank()) {
            return dataPath.replace('\\', '/').contains("/DCIM/Camera/")
        }
        return false
    }

    /** True when [relativePath] or [dataPath] denotes a screenshots dir. */
    fun isScreenshot(relativePath: String?, dataPath: String?): Boolean {
        if (!relativePath.isNullOrBlank()) {
            return relativePath.split('/').any { it.equals("Screenshots", ignoreCase = true) }
        }
        if (!dataPath.isNullOrBlank()) {
            return dataPath.replace('\\', '/').contains("/Screenshots/")
        }
        return false
    }

    /** Combine both signals for one row. */
    fun classify(relativePath: String?, dataPath: String?): Classification =
        Classification(
            isCamera = isCamera(relativePath, dataPath),
            isScreenshot = isScreenshot(relativePath, dataPath),
        )

    /** The source a row belongs to, or null when no enabled source claims it. */
    fun sourceOf(
        classification: Classification,
        collection: MediaCollection,
        cameraPhotosEnabled: Boolean,
        cameraVideosEnabled: Boolean,
        screenshotsEnabled: Boolean,
    ): AutoSource? = when {
        classification.isScreenshot -> if (screenshotsEnabled) AutoSource.SCREENSHOTS else null
        classification.isCamera ->
            if (collection == MediaCollection.IMAGES) {
                if (cameraPhotosEnabled) AutoSource.CAMERA_PHOTOS else null
            } else {
                if (cameraVideosEnabled) AutoSource.CAMERA_VIDEOS else null
            }
        else -> null
    }
}