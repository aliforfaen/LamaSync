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
        observedScope: MediaPermissionScope,
    ): DiscoverySummary {
        val snapshot = recordStore.load()
        val cursors = snapshot.cursors.associateBy { MediaDiscoveryEngine.CursorKey(it.collection, it.volume) }
        val records = snapshot.records.associateBy { it.identityKey }
        val outcome = MediaDiscoveryEngine(library).scan(settings, cursors, records, observedScope)

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
        val scanStatus = when {
            observedScope == MediaPermissionScope.NOT_GRANTED -> ScanStatus.NOT_GRANTED
            observedScope == MediaPermissionScope.PARTIAL -> ScanStatus.PARTIAL
            outcome.interrupted -> ScanStatus.INTERRUPTED
            else -> ScanStatus.OK
        }
        val nextSettings = settings.copy(
            lastScanAtEpochMillis = now(),
            lastScanStatus = scanStatus,
            lastScanScope = observedScope,
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
        }
        val snapshot = recordStore.load()

        var staged = 0
        var stagedBytes = 0L
        var unreadable = 0
        val updates = mutableListOf<MediaRecord>()

        for (record in snapshot.records) {
            if (record.status != MediaRecordStatus.DISCOVERED &&
                record.status != MediaRecordStatus.FAILED &&
                record.status != MediaRecordStatus.UNREADABLE
            ) {
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
                    DestinationResolution.Ready(
                        camera,
                        DestinationState.READY,
                        settings,
                    )
                } else {
                    DestinationResolution.Missing(DestinationState.MISSING, settings)
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
                DestinationResolution.Missing(DestinationState.REVOKED, settings)
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
        fun sourceLabel(source: AutoSource): String = when (source) {
            AutoSource.CAMERA_PHOTOS -> "Camera photos"
            AutoSource.CAMERA_VIDEOS -> "Camera videos"
            AutoSource.SCREENSHOTS -> "Screenshots"
        }
    }
}

/** Deterministic queue identity per content revision — idempotent across
 *  scans, restarts and retries; a changed revision gets a new hash suffix. */
object AutoQueueKeys {
    private fun volumeHash(identityKey: String): String {
        val volume = identityKey.substringAfter('@', "")
        return Integer.toHexString(volume.hashCode())
    }

    fun queueItemId(identityKey: String, sha256: String): String {
        val sha12 = sha256.take(12)
        val id = identityKey.substringAfter(':', "").substringBefore('@')
        val vol = volumeHash(identityKey)
        val src = identityKey.substringBefore(':', "")
        return "autoq:$src:$id@$vol:$sha12"
    }

    fun idempotencyKey(identityKey: String, sha256: String): String {
        val sha12 = sha256.take(12)
        val id = identityKey.substringAfter(':', "").substringBefore('@')
        val vol = volumeHash(identityKey)
        val src = identityKey.substringBefore(':', "")
        return "autop:$src:$id@$vol:$sha12"
    }
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
            "Only the photos and videos you selected are being protected. Grant full access for the whole camera roll."
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