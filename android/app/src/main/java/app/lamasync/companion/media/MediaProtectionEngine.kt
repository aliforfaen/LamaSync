package app.lamasync.companion.media

import android.content.Context
import android.net.Uri
import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.data.ContentStager
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.UploadQueueItem
import app.lamasync.companion.data.UploadQueueStore
import app.lamasync.companion.data.UploadStatus
import app.lamasync.companion.network.MobileUploadApi
import app.lamasync.companion.network.MobileUploadDestinationDto
import app.lamasync.companion.network.MobileUploadService
import java.io.File
import kotlinx.coroutines.CancellationException

/**
 * LAMA-296 stage 2 — automatic-protection orchestration: discovery commit,
 * bounded staging, idempotent durable enqueue, destination resolution and
 * honest waiting-reason derivation. Android-free apart from the seams
 * ([ByteStager], [CameraDestinationResolver]) so the whole flow is JVM
 * tested; the worker wires the real implementations.
 *
 * The discovery pass and the staging pass are separate crash-safe phases:
 *  - discovery persists records (DISCOVERED) + page cursors atomically
 *    BEFORE any staging, so process death can never skip a file;
 *  - staging re-processes any DISCOVERED/FAILED record every run (idempotent
 *    by deterministic queue ids), so an interrupted staging pass resumes.
 */
class MediaProtectionEngine(
    private val queueStore: UploadQueueStore,
    private val recordStore: MediaProtectionStore,
    private val stager: ByteStager,
    private val now: () -> Long = System::currentTimeMillis,
) {

    // ---- Phase A: discovery -> durable records + cursors ----

    data class DiscoverySummary(
        val newRecords: Int,
        val deletedRecords: Int,
        val interrupted: Boolean,
    )

    suspend fun discover(
        library: MediaCursorLibrary,
        settings: AutoProtectSettings,
        scopeByCollection: Map<MediaCollection, MediaPermissionScope>,
    ): DiscoverySummary {
        val snapshot = recordStore.load()
        val cursors = snapshot.cursors.associateBy { MediaDiscoveryEngine.CursorKey(it.collection, it.volume) }
        val records = snapshot.records.associateBy { it.identityKey }
        val outcome = MediaDiscoveryEngine(library).scan(
            settings,
            cursors,
            records,
            scopeByCollection,
            onPage = { commit ->
                recordStore.commitScanPage(
                    settings = snapshot.settings,
                    cursorUpdates = listOf(commit.cursor),
                    recordUpdates = commit.newRecords,
                )
            },
        )

        // Apply records + cursors + scan meta in ONE durable commit.
        val mergedRecords = records.toMutableMap()
        outcome.deletedIdentities.forEach { id ->
            records[id]?.let { existing ->
                mergedRecords[id] = existing.copy(
                    status = MediaRecordStatus.LOCALLY_DELETED,
                    queueItemId = null,
                    error = null,
                    updatedAtEpochMillis = now(),
                )
            }
        }
        outcome.newRecords.forEach { mergedRecords[it.identityKey] = it }
        val anyAccessible = scopeByCollection.values.any { it != MediaPermissionScope.NOT_GRANTED }
        val anyPartial = scopeByCollection.values.any { it == MediaPermissionScope.PARTIAL }
        val scanStatus = when {
            !anyAccessible -> ScanStatus.NOT_GRANTED
            outcome.interrupted -> ScanStatus.INTERRUPTED
            anyPartial -> ScanStatus.PARTIAL
            else -> ScanStatus.OK
        }
        val nextSettings = settings.copy(
            lastScanAtEpochMillis = now(),
            lastScanStatus = scanStatus,
            lastScanScope = scopeByCollection.values.firstOrNull { it != MediaPermissionScope.NOT_GRANTED }
                ?: MediaPermissionScope.NOT_GRANTED,
            updatedAtEpochMillis = now(),
        )
        recordStore.commitScanPage(
            settings = nextSettings,
            cursorUpdates = outcome.cursorUpdates.values,
            recordUpdates = mergedRecords.values,
        )
        return DiscoverySummary(
            newRecords = outcome.newRecords.size,
            deletedRecords = outcome.deletedIdentities.size,
            interrupted = outcome.interrupted,
        )
    }

    // ---- Phase B: staging + enqueue ----

    data class ProtectSummary(
        val stagedCount: Int,
        val stagedBytes: Long,
        val unreadableCount: Int,
        val destinationState: DestinationState,
    )

    /**
     * Stage bytes of every record needing it and enqueue one durable upload
     * item per staged revision (deterministic ids → idempotent across
     * duplicate scans, restarts and retries).
     *
     * @param hostId the CURRENT registration's server-issued host id — every
     *   auto item binds to it (stage-1 binding invariant: disconnect/re-pair
     *   never redirects old uploads to a new identity).
     * @param destinationsResult the outcome of LISTING the device's own
     *   destinations (network best-effort by the caller): the engine merges
     *   the last-known cached destination when the server is unreachable so
     *   transfers keep their honest lifecycle.
     */
    suspend fun protectPending(
        settings: AutoProtectSettings,
        origin: String,
        hostId: String,
        destinationsResult: DestinationsResult,
    ): ProtectSummary {
        val destState = resolveDestination(settings, destinationsResult)
        val effective = destState.destination
        // Persist the effective destination (fresh or cached) so it survives
        // restarts and the next run can fall back to it while offline.
        if (effective != null) {
            recordStore.updateSettings {
                it.copy(
                    cameraDestinationId = effective.id,
                    cameraDestinationLabel = effective.label,
                    cameraDestinationRelPath = effective.relPath,
                    updatedAtEpochMillis = now(),
                )
            }
        } else if (destState.clearCachedDestination) {
            // Fresh MISSING or revocation: the cached destination is no longer
            // authoritative and must stop showing as Server-approved.
            recordStore.updateSettings {
                it.copy(
                    cameraDestinationId = null,
                    cameraDestinationLabel = null,
                    cameraDestinationRelPath = null,
                    updatedAtEpochMillis = now(),
                )
            }
        }
        val snapshot = recordStore.load()

        var staged = 0
        var stagedBytes = 0L
        var unreadable = 0
        val updates = mutableListOf<MediaRecord>()

        for (record in snapshot.records) {
            if (record.status == MediaRecordStatus.STAGED) {
                val item = record.queueItemId?.let { qid -> queueStore.load().items.firstOrNull { it.id == qid } }
                if (item != null && item.status == UploadStatus.DONE && item.receipt != null) {
                    updates += record.copy(status = MediaRecordStatus.PROTECTED, sha256 = item.sha256, receiptPath = item.receipt?.finalRelPath, protectedAtEpochMillis = item.receipt?.finalizedAtEpochMillis ?: now(), error = null, updatedAtEpochMillis = now())
                }
                continue
            }
            if (record.status != MediaRecordStatus.DISCOVERED && record.status != MediaRecordStatus.FAILED && record.status != MediaRecordStatus.UNREADABLE) {
                continue
            }
            if (effective == null) {
                // Nothing can be uploaded yet — records stay in place; the
                // waiting reason carries the actionable cause.
                continue
            }
            if (record.status == MediaRecordStatus.UNREADABLE) {
                // Retry an unreadable source: permission may have come back.
                // Reads fail fast; a lingering failure just re-records it.
            }
            val stagedOutcome = try {
                stager.stage(record.uri)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ByteStager.StageOutcome.Failed(ByteStager.FailReason.IO_ERROR, e.message)
            }
            when (stagedOutcome) {
                is ByteStager.StageOutcome.Staged -> {
                    val ok = stagedOutcome.value
                    val enqueue = enqueueStaged(
                        origin = origin,
                        hostId = hostId,
                        destination = effective,
                        record = record,
                        stagedName = ok.fileName,
                        stagedSize = ok.sizeBytes,
                        stagedSha = ok.sha256,
                    )
                    updates += enqueue.record
                    if (enqueue.isNewlyQueued) {
                        staged++
                        stagedBytes += ok.sizeBytes
                    }
                }
                is ByteStager.StageOutcome.Failed -> {
                    updates += record.copy(
                        status = MediaRecordStatus.UNREADABLE,
                        error = failableText(stagedOutcome),
                        updatedAtEpochMillis = now(),
                    )
                    unreadable++
                }
            }
        }

        recordStore.updateRecords(updates)
        return ProtectSummary(
            stagedCount = staged,
            stagedBytes = stagedBytes,
            unreadableCount = unreadable,
            destinationState = destState.state,
        )
    }

    /** [effective] destination persisted into settings (cached fallback). */
    fun resolveDestination(
        settings: AutoProtectSettings,
        result: DestinationsResult,
    ): DestinationResolution {
        return when (result) {
            is DestinationsResult.Ok -> {
                val camera = CameraDestinationResolver.pickCamera(result.destinations)
                if (camera != null) {
                    DestinationResolution.Ready(camera, DestinationState.READY, settings)
                } else {
                    // Fresh authoritative list says no Camera inbox: the cached
                    // id/label/relPath is stale and must not keep showing a
                    // Server-approved path the server no longer approves.
                    DestinationResolution.Missing(DestinationState.MISSING, settings, clearCachedDestination = true)
                }
            }
            is DestinationsResult.NetworkFailure -> {
                val cached = settings.cameraDestinationId?.let { id ->
                    settings.cameraDestinationRelPath?.let { path ->
                        MobileUploadDestinationDto(
                            id = id,
                            label = settings.cameraDestinationLabel ?: "Camera",
                            relPath = path,
                        )
                    }
                }
                if (cached != null) {
                    DestinationResolution.Ready(cached, DestinationState.CACHED, settings)
                } else {
                    DestinationResolution.Missing(DestinationState.UNREACHABLE, settings)
                }
            }
            is DestinationsResult.AuthFailure -> {
                // Revocation is authoritative: the cached Camera inbox is no
                // longer granted to this device.
                DestinationResolution.Missing(DestinationState.REVOKED, settings, clearCachedDestination = true)
            }
        }
    }

    private data class EnqueueResult(val record: MediaRecord, val isNewlyQueued: Boolean)

    private fun enqueueStaged(
        origin: String,
        hostId: String,
        destination: MobileUploadDestinationDto,
        record: MediaRecord,
        stagedName: String,
        stagedSize: Long,
        stagedSha: String,
    ): EnqueueResult {
        val queueId = AutoQueueKeys.queueItemId(record.identityKey, stagedSha)
        val idempotencyKey = AutoQueueKeys.idempotencyKey(record.identityKey, stagedSha)
        val nowMs = now()

        val existing = queueStore.load().items.firstOrNull { it.id == queueId }
        if (existing != null) {
            return when (existing.status) {
                // Durable completion: link the receipt into the registry.
                UploadStatus.DONE -> EnqueueResult(
                    record.copy(
                        status = MediaRecordStatus.PROTECTED,
                        queueItemId = queueId,
                        sha256 = stagedSha,
                        receiptPath = existing.receipt?.finalRelPath,
                        protectedAtEpochMillis = existing.receipt?.finalizedAtEpochMillis ?: nowMs,
                        error = null,
                        stagedAtEpochMillis = record.stagedAtEpochMillis ?: nowMs,
                        updatedAtEpochMillis = nowMs,
                    ),
                    isNewlyQueued = false,
                )
                // User cancelled: honor the durable decision; the record
                // stays staged and re-arms only after the user removes the
                // cancelled item (see spec: cancel never silently loses the
                // file, but a cancel means "stop this attempt").
                UploadStatus.CANCELLED -> EnqueueResult(
                    record.copy(
                        queueItemId = queueId,
                        sha256 = stagedSha,
                        error = "Cancelled — the next scan will protect this media again after you remove the cancelled item.",
                        stagedAtEpochMillis = record.stagedAtEpochMillis ?: nowMs,
                        updatedAtEpochMillis = nowMs,
                    ),
                    isNewlyQueued = false,
                )
                else -> {
                    // PENDING/UPLOADING/WAITING/FAILED/BLOCKED: the transfer
                    // worker owns it; nothing to duplicate.
                    EnqueueResult(
                        record.copy(
                            queueItemId = queueId,
                            sha256 = stagedSha,
                            stagedAtEpochMillis = record.stagedAtEpochMillis ?: nowMs,
                            updatedAtEpochMillis = nowMs,
                        ),
                        isNewlyQueued = false,
                    )
                }
            }
        }

        val item = UploadQueueItem(
            id = queueId,
            origin = origin,
            hostId = hostId,
            sourceUri = record.uri,
            displayName = record.displayName,
            mimeType = record.mimeType,
            sizeBytes = stagedSize,
            destinationId = destination.id,
            destinationRelPath = destination.relPath,
            idempotencyKey = idempotencyKey,
            sha256 = stagedSha,
            stagedFileName = stagedName,
            staged = true,
            mediaIdentity = record.identityKey,
            sourceLabel = sourceLabel(record.source),
            status = UploadStatus.PENDING,
            createdAtEpochMillis = nowMs,
            updatedAtEpochMillis = nowMs,
        )
        queueStore.add(item)
        return EnqueueResult(
            record.copy(
                status = MediaRecordStatus.STAGED,
                queueItemId = queueId,
                sha256 = stagedSha,
                stagedAtEpochMillis = nowMs,
                error = null,
                updatedAtEpochMillis = nowMs,
            ),
            isNewlyQueued = true,
        )
    }

    private fun failableText(outcome: ByteStager.StageOutcome.Failed): String = when (outcome.reason) {
        ByteStager.FailReason.UNREADABLE ->
            "This media is no longer readable (permission revoked, moved, or deleted). " +
                (outcome.detail?.let { "Detail: $it" } ?: "")
        ByteStager.FailReason.TOO_LARGE -> "This media exceeds the local staging limit."
        ByteStager.FailReason.NO_SPACE -> "Not enough free storage to stage this media."
        ByteStager.FailReason.IO_ERROR -> "Could not stage this media locally."
    }

    companion object {
        /**
         * P0-1: once an automatic upload item is durably DONE, reconcile the
         * media registry: the record becomes PROTECTED with the receipt path
         * and protection time (idempotent — re-calling is a no-op). Static so
         * the transfer worker and the cancel-race path can use it without
         * constructing a full engine. Handles versioned collision names: the
         * receipt's finalRelPath already carries the published name.
         */
        fun reconcileCompleted(recordStore: MediaProtectionStore, item: UploadQueueItem): Boolean {
            val identity = item.mediaIdentity ?: return false
            val receipt = item.receipt ?: return false
            val record = recordStore.recordFor(identity) ?: return false
            if (record.status == MediaRecordStatus.PROTECTED) return true
            recordStore.updateRecords(
                listOf(
                    record.copy(
                        status = MediaRecordStatus.PROTECTED,
                        queueItemId = item.id,
                        sha256 = item.sha256,
                        receiptPath = receipt.finalRelPath,
                        protectedAtEpochMillis = receipt.finalizedAtEpochMillis,
                        error = null,
                        updatedAtEpochMillis = System.currentTimeMillis(),
                    ),
                ),
            )
            return true
        }

        fun sourceLabel(source: AutoSource): String = when (source) {
            AutoSource.CAMERA_PHOTOS -> "Camera photos"
            AutoSource.CAMERA_VIDEOS -> "Camera videos"
            AutoSource.SCREENSHOTS -> "Screenshots"
        }
    }
}

/** Deterministic queue identity per content revision — idempotent across
 *  scans, restarts and retries; a changed revision gets a new hash suffix.
 *
 * Server contract (mobile-uploads.ts): idempotency keys must match
 * `^[A-Za-z0-9._-]+$` and be 8..128 chars — the keys below comply. */
object AutoQueueKeys {
    private fun volumeHash(identityKey: String): String {
        val volume = identityKey.substringAfter('@', "")
        return Integer.toHexString(volume.hashCode())
    }

    private fun base(identityKey: String, sha256: String): String {
        val source = identityKey.substringBefore(':', "")
        val id = identityKey.substringAfter(':', "").substringBefore('@')
        return "$source-${id}-${volumeHash(identityKey)}-${sha256.take(12)}"
    }

    fun queueItemId(identityKey: String, sha256: String): String =
        ("autoq-" + base(identityKey, sha256)).take(128)

    fun idempotencyKey(identityKey: String, sha256: String): String =
        ("autop-" + base(identityKey, sha256)).take(128)
}

/** Bounded staging seam. */
interface ByteStager {
    data class Ok(val fileName: String, val sizeBytes: Long, val sha256: String)

    sealed interface StageOutcome {
        data class Staged(val value: Ok) : StageOutcome
        data class Failed(val reason: FailReason, val detail: String? = null) : StageOutcome
    }

    enum class FailReason { UNREADABLE, TOO_LARGE, NO_SPACE, IO_ERROR }

    suspend fun stage(uri: String): StageOutcome
}

/** Device adapter: streams a content URI into bounded private storage and
 *  hashes it (stage-1 ContentStager semantics). */
class ContentResolverByteStager(
    context: Context,
    private val uploadsDir: File = File(context.filesDir, "uploads"),
) : ByteStager {
    private val inner = ContentStager(
        contentResolver = context.contentResolver,
        uploadsDir = { uploadsDir },
    )

    override suspend fun stage(uri: String): ByteStager.StageOutcome {
        return when (val r = inner.stage(Uri.parse(uri))) {
            is ContentStager.StageResult.Success -> ByteStager.StageOutcome.Staged(
                ByteStager.Ok(r.file.name, r.sizeBytes, r.sha256),
            )
            is ContentStager.StageResult.Failure -> ByteStager.StageOutcome.Failed(
                when (r.reason) {
                    ContentStager.StageFailure.UNREADABLE -> ByteStager.FailReason.UNREADABLE
                    ContentStager.StageFailure.TOO_LARGE -> ByteStager.FailReason.TOO_LARGE
                    ContentStager.StageFailure.NO_SPACE -> ByteStager.FailReason.NO_SPACE
                    ContentStager.StageFailure.IO_ERROR -> ByteStager.FailReason.IO_ERROR
                },
                r.detail,
            )
        }
    }
}

/** Outcome of listing the device's own destinations. */
sealed interface DestinationsResult {
    data class Ok(val destinations: List<MobileUploadDestinationDto>) : DestinationsResult
    data class NetworkFailure(val detail: String?) : DestinationsResult
    data class AuthFailure(val detail: String?) : DestinationsResult

    companion object {
        fun of(failure: ApiFailure): DestinationsResult = when (failure) {
            is ApiFailure.Unauthorized, is ApiFailure.Forbidden ->
                AuthFailure(failure.message)
            is ApiFailure.Network ->
                NetworkFailure(failure.message)
            else -> NetworkFailure(failure.message)
        }
    }
}

/** Effective camera destination + its waiting-state classification. */
sealed interface DestinationResolution {
    /** A destination is usable right now (fresh or last-known cached). */
    val destination: MobileUploadDestinationDto?

    /** How the destination resolution should be reported. */
    val state: DestinationState

    /** True when the CACHED destination must be cleared from settings: the
     *  fresh list is authoritative and no longer contains a Camera inbox, or
     *  upload authority was revoked. Only network unreachability retains the
     *  cached fallback. */
    val clearCachedDestination: Boolean
        get() = false

    /** A destination is usable right now (fresh or last-known cached). */
    data class Ready(
        override val destination: MobileUploadDestinationDto,
        override val state: DestinationState,
        val settings: AutoProtectSettings,
    ) : DestinationResolution

    /** No usable destination; the state explains why. */
    data class Missing(
        override val state: DestinationState,
        val settings: AutoProtectSettings,
        override val destination: MobileUploadDestinationDto? = null,
        override val clearCachedDestination: Boolean = false,
    ) : DestinationResolution
}

enum class DestinationState {
    /** Server-approved Camera destination resolved fresh. */
    READY,
    /** Last-known cached destination (server unreachable right now). */
    CACHED,
    /** Server reachable but no Camera destination is assigned. */
    MISSING,
    /** Server unreachable and no cached destination to fall back to. */
    UNREACHABLE,
    /** The device's upload authority was revoked. */
    REVOKED,
}

/** Camera destination resolution over the real mobile API. */
class MobileCameraDestinationResolver(
    private val service: MobileUploadService,
) : CameraDestinationResolver {
    override suspend fun resolve(
        origin: String,
        native: NativeToken,
        cachedId: String?,
    ): DestinationsResult {
        return try {
            DestinationsResult.Ok(service.listDestinations(origin, native))
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiFailure.Unauthorized) {
            DestinationsResult.AuthFailure("upload access revoked")
        } catch (e: ApiFailure.Forbidden) {
            DestinationsResult.AuthFailure("upload access forbidden")
        } catch (e: ApiFailure.Network) {
            DestinationsResult.NetworkFailure(e.message)
        } catch (e: ApiFailure) {
            DestinationsResult.NetworkFailure(e.message)
        }
    }
}

interface CameraDestinationResolver {
    suspend fun resolve(origin: String, native: NativeToken, cachedId: String?): DestinationsResult

    companion object {
        /**
         * Pick the server-approved Camera destination deterministically:
         * label or slug "Camera" (case-insensitive), then relPath ending in
         * `/Camera`. The operator assigns it from the desktop Android
         * devices panel; the app never invents destinations.
         */
        fun pickCamera(destinations: List<MobileUploadDestinationDto>): MobileUploadDestinationDto? {
            val sorted = destinations.sortedBy { it.createdAt }
            return sorted.firstOrNull {
                it.label.trim().equals("Camera", ignoreCase = true) ||
                    it.relPath.trimEnd('/').endsWith("/Camera", ignoreCase = true) ||
                    slugify(it.label) == "camera"
            }
        }

        /** Mirror of the server's slugFromLabel (label → slug). */
        fun slugify(label: String): String {
            val bytes = label.trim().lowercase().map {
                if (it.isLetterOrDigit()) it else '-'
            }
            return bytes.joinToString("")
                .replace(Regex("-{2,}"), "-")
                .trim('-')
        }
    }
}

/** Honest waiting-reason derivation (pure — JVM tested). */
object AutoWaitingReasons {
    fun derive(
        registrationPresent: Boolean,
        nativePresent: Boolean,
        scope: MediaPermissionScope,
        destinationState: DestinationState,
        pendingCount: Long,
    ): AutoWaitReason = when {
        !registrationPresent -> AutoWaitReason.UNPAIRED
        !nativePresent -> AutoWaitReason.CREDENTIAL_LOST
        scope == MediaPermissionScope.NOT_GRANTED -> AutoWaitReason.PERMISSION_DENIED
        destinationState == DestinationState.REVOKED -> AutoWaitReason.REVOKED
        destinationState == DestinationState.MISSING -> AutoWaitReason.NO_CAMERA_DESTINATION
        destinationState == DestinationState.UNREACHABLE -> AutoWaitReason.NETWORK
        scope == MediaPermissionScope.PARTIAL -> AutoWaitReason.PERMISSION_PARTIAL
        else -> AutoWaitReason.NONE
    }

    fun human(reason: AutoWaitReason, pendingCount: Long): String? = when (reason) {
        AutoWaitReason.NONE -> null
        AutoWaitReason.UNPAIRED ->
            "Not protected — pair this device with a QR code to start automatic protection."
        AutoWaitReason.CREDENTIAL_LOST ->
            "Not protected — this device's credential is missing. Re-pair to start."
        AutoWaitReason.PERMISSION_DENIED ->
            "Media access is needed to protect your camera. Grant access in the setup panel."
        AutoWaitReason.PERMISSION_PARTIAL ->
            "Only part of your media is accessible — a photo or video permission is missing, or " +
                "only selected items are allowed. Grant full access in App settings to protect " +
                "the whole camera roll."
        AutoWaitReason.NO_CAMERA_DESTINATION ->
            "An administrator must assign a “Camera” inbox in Admin → Android devices."
        AutoWaitReason.DESTINATION_REVOKED ->
            "The Camera inbox was revoked by an administrator. Ask them to re-assign it."
        AutoWaitReason.REVOKED ->
            "This device's upload access was revoked. Re-pair to resume protection."
        AutoWaitReason.NETWORK ->
            "The server is unreachable. Protection resumes automatically when it is back."
    }
}