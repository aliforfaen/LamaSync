package app.lamasync.companion.media

import kotlinx.serialization.Serializable

/**
 * LAMA-296 stage 2 — durable models for automatic media protection.
 *
 * Everything here is Android-LOCAL state; stage 1's wire contract is reused
 * unchanged. Identity is `collection:<mediaId>@<volume>` — NEVER a file path
 * — so it stays stable across process death, reboot, storage-path changes,
 * and re-scans. See docs/spec-296-stage-2-auto-protection.md.
 */

/** A protectable media source (camera photos/videos, optional screenshots). */
@Serializable
enum class AutoSource {
    CAMERA_PHOTOS,
    CAMERA_VIDEOS,
    SCREENSHOTS,
}

/** Initial scope decision: protect the existing camera history or only new
 *  media captured after the first scan's boundary. */
@Serializable
enum class ScopeMode { NEW_ONLY, EXISTING_HISTORY }

/** Durable per-item lifecycle. DISCOVERED → STAGED → PROTECTED, with honest
 *  terminal/actionable states: LOCALLY_DELETED (satisfied, nothing to do),
 *  UNREADABLE (source vanished/permission changed — actionable), FAILED. */
@Serializable
enum class MediaRecordStatus {
    DISCOVERED,
    STAGED,
    PROTECTED,
    LOCALLY_DELETED,
    UNREADABLE,
    FAILED,
}

/** Outcome of the last discovery scan (persisted for the status UI). */
@Serializable
enum class ScanStatus { OK, PARTIAL, NOT_GRANTED, INTERRUPTED }

/**
 * Why automatic protection is (or is not) progressing right now. Derived
 * from honest, observable state on every worker run — never guessed. NONE
 * means the pipeline is healthy (items may still wait on transfer policy).
 */
@Serializable
enum class AutoWaitReason {
    NONE,
    UNPAIRED,
    CREDENTIAL_LOST,
    PERMISSION_DENIED,
    PERMISSION_PARTIAL,
    NO_CAMERA_DESTINATION,
    DESTINATION_REVOKED,
    REVOKED,
    NETWORK,
}

/** MediaStore collections we scan (one cursor per collection+volume). */
@Serializable
enum class MediaCollection { IMAGES, VIDEOS }

/**
 * One durable discovered/protected media item.
 *
 * @param queueItemId deterministic queue item id for this content revision
 *   (`auto-<identity>#<sha12>`), linking the receipts in the upload queue
 *   back into this registry.
 * @param previousProtectedPaths bounded provenance of earlier protected
 *   revisions of the same identity, so an edited file never hides that an
 *   older copy was already protected.
 */
@Serializable
data class MediaRecord(
    val identityKey: String,
    val mediaId: Long,
    val volume: String,
    val collection: MediaCollection,
    val source: AutoSource,
    val uri: String,
    val displayName: String,
    val sizeBytes: Long? = null,
    val mimeType: String? = null,
    val relativePath: String? = null,
    val dateAddedSeconds: Long = 0L,
    val dateTakenMillis: Long? = null,
    val sha256: String? = null,
    val status: MediaRecordStatus = MediaRecordStatus.DISCOVERED,
    val queueItemId: String? = null,
    val receiptPath: String? = null,
    val previousProtectedPaths: List<String> = emptyList(),
    val error: String? = null,
    val discoveredAtEpochMillis: Long = 0L,
    val stagedAtEpochMillis: Long? = null,
    val protectedAtEpochMillis: Long? = null,
    val updatedAtEpochMillis: Long = 0L,
)

/** Discovery cursor for one (collection, volume). Durable so process death
 *  mid-scan resumes instead of skipping or re-importing. */
@Serializable
data class MediaCursorState(
    val collection: MediaCollection,
    val volume: String,
    val scopeMode: ScopeMode = ScopeMode.NEW_ONLY,
    /** New-only boundary (captured BEFORE the first import query): rows
     *  strictly newer than `(watermarkDateAdded, watermarkId)` are new. */
    val watermarkDateAdded: Long? = null,
    val watermarkId: Long? = null,
    /** Keyset cursor of the existing-history walk (resume point). */
    val fullScanCompleted: Boolean = false,
    val updatedAtEpochMillis: Long = 0L,
)

/** Just enough information about one queried row for reconciliation. */
@Serializable
data class KnownRowMeta(
    val mediaId: Long,
    val sizeBytes: Long? = null,
    val dateModifiedSeconds: Long? = null,
)

/**
 * Durable automatic-protection configuration + honesty summaries.
 *
 * The permission GRANT itself is never stored (official guidance: check it
 * live); [lastScanScope] is only the OBSERVED scope at scan time, reported
 * for the status UI and refreshed on every scan/resume.
 */
@Serializable
data class AutoProtectSettings(
    val cameraPhotosEnabled: Boolean = false,
    val cameraVideosEnabled: Boolean = false,
    val screenshotsEnabled: Boolean = false,
    val scopeMode: ScopeMode = ScopeMode.NEW_ONLY,
    val unmeteredOnly: Boolean = false,
    val chargingOnly: Boolean = false,
    /** Resolved server-approved Camera destination (label/slug "Camera"). */
    val cameraDestinationId: String? = null,
    val cameraDestinationLabel: String? = null,
    val cameraDestinationRelPath: String? = null,
    /** Honest status summaries (see spec). */
    val lastSuccessfulProtectionEpochMillis: Long? = null,
    val lastWaitingReason: AutoWaitReason = AutoWaitReason.NONE,
    val waitingReasonUpdatedAtEpochMillis: Long? = null,
    val lastScanAtEpochMillis: Long? = null,
    val lastScanStatus: ScanStatus = ScanStatus.OK,
    val lastScanScope: MediaPermissionScope = MediaPermissionScope.NOT_GRANTED,
    val updatedAtEpochMillis: Long = 0L,
) {
    /** Any source enabled at all? */
    val anySourceEnabled: Boolean
        get() = cameraPhotosEnabled || cameraVideosEnabled || screenshotsEnabled
}