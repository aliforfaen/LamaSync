package app.lamasync.companion.data

import kotlinx.serialization.Serializable

/**
 * LAMA-296 stage 1 — durable queue item for one manual upload intent.
 *
 * Binding invariant: every item records the ENROLLMENT IDENTITY (origin +
 * server-issued hostId) it was created under. The transfer executor refuses
 * to run an item whose (origin, hostId) does not match the CURRENT
 * registration, so a disconnect or re-pair NEVER redirects old uploads to a
 * new device/server — including re-pairing at the same origin (new hostId).
 * The item then fails with a clear "re-pair required" message and the user
 * decides (retry only after re-enrolling the same identity).
 */
@Serializable
data class UploadQueueItem(
    val id: String,
    /** Enrollment origin at intake (canonical https origin). */
    val origin: String,
    /** Server-issued host id at intake. */
    val hostId: String,
    /** Source content URI (authority + path only; scheme is content). */
    val sourceUri: String,
    /** Human display name (e.g. document title or file name). */
    val displayName: String,
    /** MIME type from the share/document, when provided. */
    val mimeType: String? = null,
    /** Declared size in bytes, or null when unknown at intake. */
    val sizeBytes: Long? = null,
    /** Destructive path label for the chosen destination (e.g. "Inbox"). */
    val destinationId: String,
    /** Destination rel path prefix shown in receipts (e.g. Mobile/<hostId>/Inbox). */
    val destinationRelPath: String,
    /** Client-generated idempotency key (one per intent, stable across retries). */
    val idempotencyKey: String,
    /** Client-computed SHA-256 hex of the staged bytes, when known. */
    val sha256: String? = null,
    /** LAMA-296 stage 2: stable automatic-media identity (when present) so
     *  receipts link back to the protection registry. Null for manual. */
    val mediaIdentity: String? = null,
    /** LAMA-296 stage 2: human source label ("Camera photos", …). */
    val sourceLabel: String? = null,
    /** LAMA-296 stage 2: how many versioned-name retries this automatic item
     *  has already consumed (repeated-name collision handling). Deterministic
     *  resume: a restart continues at the same attempt instead of creating
     *  abandoned upload rows. 0 for manual items. */
    val autoNameAttempt: Int = 0,
    /** Private staging file (filesDir/uploads/) once staged, else null. */
    val stagedFileName: String? = null,
    /** True once the staged bytes were durably retained in app storage. */
    val staged: Boolean = false,
    /** Server-issued upload id once creation succeeded, else null. */
    val serverUploadId: String? = null,
    /** Bytes durably accepted by the server (client mirror of offset). */
    val uploadedBytes: Long = 0L,
    /** Latest server-reported status (mirror; the server is authoritative). */
    val serverStatus: String? = null,
    val status: UploadStatus = UploadStatus.PENDING,
    val error: String? = null,
    /** Last server-reported offset used for resume, when known. */
    val serverBytesReceived: Long? = null,
    /** Set when the upload was durably finalized server-side. */
    val receipt: UploadReceipt? = null,
    val createdAtEpochMillis: Long,
    val updatedAtEpochMillis: Long,
)

/** Client-side lifecycle mirror. PENDING → UPLOADING → DONE (or FAILED /
 *  CANCELLED / BLOCKED / WAITING). The server row is authoritative for
 *  offsets/status; this enum drives UI rendering only. */
enum class UploadStatus {
    /** Queued, not yet transferred. */
    PENDING,
    /** Actively transferring (chunk loop). */
    UPLOADING,
    /** Waiting on a recoverable condition (network/tailnet, policy, unpaired). */
    WAITING,
    /** Cannot proceed without user action (e.g. destination revoked on server). */
    BLOCKED,
    /** Transient failure — retryable. */
    FAILED,
    /** User-cancelled before completion. */
    CANCELLED,
    /** Durable verified completion. */
    DONE,
}

/** Server completion receipt (see core MobileUploadReceipt). */
@Serializable
data class UploadReceipt(
    val uploadId: String,
    val fileName: String,
    val finalRelPath: String,
    val browsePath: String,
    val sizeBytes: Long,
    val sha256: String,
    val finalizedAtEpochMillis: Long,
)

/** Serialized envelope persisted in SharedPreferences (excluded from backup). */
@Serializable
data class UploadQueueSnapshot(
    val items: List<UploadQueueItem> = emptyList(),
)

/** Milestone/user preference: upload policy (stage 1 defaults, user-tunable). */
@Serializable
data class UploadPolicy(
    /** Only transfer on unmetered networks (WorkManager constraint). */
    val unmeteredOnly: Boolean = false,
    /** Only transfer while charging (stage 2; WorkManager constraint). */
    val chargingOnly: Boolean = false,
)

/**
 * LAMA-296 stage 2 — deterministic versioned-name retries when the server
 * rejects a final name because a file with that name already exists (e.g. a
 * camera reset its counters, or an edited file keeps its display name). The
 * server copy is never overwritten; the retried revision gets `name (n).ext`
 * and a DERIVED idempotency key (same base, attempt suffix), so retries,
 * restarts and duplicate scans all converge on ONE upload row per attempt.
 */
object UploadNaming {
    /** ``IMG_0001.jpg`` + attempt 1 → ``IMG_0001 (2).jpg``; attempt 2 → ``IMG_0001 (3).jpg``. */
    fun versionedName(original: String, attemptIndex: Int): String {
        val n = attemptIndex + 1
        val dot = original.lastIndexOf('.')
        return if (dot > 0) {
            original.substring(0, dot) + " ($n)" + original.substring(dot)
        } else {
            "$original ($n)"
        }
    }

    /** Deterministic per-attempt key: `base#v<attempt>` (bounded for the
     *  server's 128-char idempotency-key limit). */
    fun derivedKey(baseIdempotencyKey: String, attemptIndex: Int): String {
        val suffix = "#v$attemptIndex"
        return baseIdempotencyKey.take(MAX_KEY - suffix.length) + suffix
    }

    const val MAX_KEY = 128
}