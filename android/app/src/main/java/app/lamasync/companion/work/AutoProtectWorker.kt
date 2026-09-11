package app.lamasync.companion.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.RegistrationStoreImpl
import app.lamasync.companion.data.UploadPolicy
import app.lamasync.companion.media.AutoWaitReason
import app.lamasync.companion.media.AutoWaitingReasons
import app.lamasync.companion.media.ContentResolverByteStager
import app.lamasync.companion.media.DestinationsResult
import app.lamasync.companion.media.DestinationState
import app.lamasync.companion.media.MediaCollection
import app.lamasync.companion.media.MediaPermissionScope
import app.lamasync.companion.media.MediaPermissions
import app.lamasync.companion.media.MediaProtectionEngine
import app.lamasync.companion.media.MediaProtectionStore
import app.lamasync.companion.media.MediaStoreCursorLibrary
import app.lamasync.companion.media.MobileCameraDestinationResolver
import app.lamasync.companion.network.HttpUrlConnectionTransport
import app.lamasync.companion.network.MobileUploadApi
import kotlinx.coroutines.CancellationException

/**
 * LAMA-296 stage 2 — automatic protection worker: honest gating → live
 * permission scope → discovery (durable records + cursors) → destination
 * resolution → bounded staging + idempotent enqueue → honest waiting reason
 * → constrained drainer schedule.
 *
 * Deferred/periodic execution is accepted by design (WorkManager contract);
 * this worker NEVER claims immediate or unrestricted background execution.
 * Outages (tailnet/server down) leave recoverable waiting state and the
 * periodic worker re-evaluates.
 *
 * Revocation: the registration gate stops discovery when the device is no
 * longer paired (or the credential is gone) with a re-pair action; local
 * queue/registry state is preserved for the user's decision.
 */
class AutoProtectWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val context = applicationContext
        val registrationStore = RegistrationStoreImpl(context)
        val vault = KeystoreCredentialVault(context)
        val registration = registrationStore.load()
        val native = vault.nativeToken()
        val recordStore = MediaProtectionStore.getInstance(context)

        val settings = recordStore.load().settings
        val now = System.currentTimeMillis()

        // --- honest gating (waits are recoverable, never terminal) ---
        if (registration == null) {
            recordStore.updateSettings {
                it.copy(
                    lastWaitingReason = AutoWaitReason.UNPAIRED,
                    waitingReasonUpdatedAtEpochMillis = now,
                    updatedAtEpochMillis = now,
                )
            }
            return Result.success()
        }
        if (native == null) {
            recordStore.updateSettings {
                it.copy(
                    lastWaitingReason = AutoWaitReason.CREDENTIAL_LOST,
                    waitingReasonUpdatedAtEpochMillis = now,
                    updatedAtEpochMillis = now,
                )
            }
            return Result.success()
        }

        // --- live per-collection permission scope (never trusted from
        // storage; P0-3: authority is per collection, not global) ---
        val scopes = MediaPermissions.currentScopes(context)
        val needsImages = settings.cameraPhotosEnabled || settings.screenshotsEnabled
        val needsVideos = settings.cameraVideosEnabled || settings.screenshotsEnabled
        val accessible = buildList {
            if (needsImages) scopes[MediaCollection.IMAGES]?.let { add(it) }
            if (needsVideos) scopes[MediaCollection.VIDEOS]?.let { add(it) }
        }.filter { it != MediaPermissionScope.NOT_GRANTED }
        if (accessible.isEmpty()) {
            recordStore.updateSettings {
                it.copy(
                    lastWaitingReason = AutoWaitReason.PERMISSION_DENIED,
                    waitingReasonUpdatedAtEpochMillis = now,
                    lastScanStatus = app.lamasync.companion.media.ScanStatus.NOT_GRANTED,
                    lastScanAtEpochMillis = now,
                    lastScanScope = MediaPermissionScope.NOT_GRANTED,
                    updatedAtEpochMillis = now,
                )
            }
            return Result.success()
        }
        // Honest reported scope: PARTIAL when ANY needed collection is
        // selected-photos-only or fully denied, even if others are FULL.
        val reportedScope = when {
            accessible.size < (if (needsImages) 1 else 0) + (if (needsVideos) 1 else 0) ||
                accessible.any { it == MediaPermissionScope.PARTIAL } -> MediaPermissionScope.PARTIAL
            else -> MediaPermissionScope.FULL
        }

        // --- discovery (local; needs no network) ---
        val library = MediaStoreCursorLibrary(context)
        val engine = MediaProtectionEngine(
            queueStore = app.lamasync.companion.data.UploadQueueStore.getInstance(context),
            recordStore = recordStore,
            stager = ContentResolverByteStager(context),
        )
        val discovery = try {
            engine.discover(library, settings, scopes)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A discovery page failure is non-terminal: record interrupted
            // scan state so the next run resumes from the last cursor.
            recordStore.updateSettings {
                it.copy(
                    lastScanStatus = app.lamasync.companion.media.ScanStatus.INTERRUPTED,
                    lastScanAtEpochMillis = now,
                    updatedAtEpochMillis = now,
                )
            }
            return Result.success()
        }

        // --- destination resolution (best-effort network; cached fallback) ---
        val resolver = MobileCameraDestinationResolver(MobileUploadApi(HttpUrlConnectionTransport()))
        val destinationsResult = try {
            resolver.resolve(registration.origin, native, settings.cameraDestinationId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            DestinationsResult.NetworkFailure(e.message)
        }

        // --- staging + idempotent enqueue ---
        val protect = try {
            engine.protectPending(
                settings = recordStore.load().settings,
                origin = registration.origin,
                hostId = registration.hostId,
                destinationsResult = destinationsResult,
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Staging failure is per-record; a systemic failure is recorded
            // as an interrupted pass (records stay DISCOVERED and retry).
            recordStore.updateSettings {
                it.copy(
                    lastScanStatus = app.lamasync.companion.media.ScanStatus.INTERRUPTED,
                    updatedAtEpochMillis = now,
                )
            }
            return Result.success()
        }

        // --- honest waiting reason + scan meta ---
        val pendingCount = app.lamasync.companion.data.UploadQueueStore.getInstance(context)
            .pendingItems()
            .count { it.mediaIdentity != null }
            .toLong()
        val reason = AutoWaitingReasons.derive(
            registrationPresent = true,
            nativePresent = true,
            scope = reportedScope,
            destinationState = protect.destinationState,
            pendingCount = pendingCount,
        )
        val latestProtection = recordStore.load().records
            .filter { it.status == app.lamasync.companion.media.MediaRecordStatus.PROTECTED }
            .maxOfOrNull { it.protectedAtEpochMillis ?: 0L }
        recordStore.updateSettings {
            it.copy(
                lastWaitingReason = reason,
                waitingReasonUpdatedAtEpochMillis = now,
                lastScanStatus = if (discovery.interrupted) {
                    app.lamasync.companion.media.ScanStatus.INTERRUPTED
                } else {
                    when (reportedScope) {
                        MediaPermissionScope.PARTIAL -> app.lamasync.companion.media.ScanStatus.PARTIAL
                        else -> app.lamasync.companion.media.ScanStatus.OK
                    }
                },
                lastScanAtEpochMillis = now,
                lastScanScope = reportedScope,
                lastSuccessfulProtectionEpochMillis = latestProtection,
                updatedAtEpochMillis = now,
            )
        }

        // --- schedule the constrained drainer if anything is pending ---
        // Automatic items drain under the AUTOMATIC transfer policy (the
        // Auto Protect screen's own conditions) — never the manual one.
        if (app.lamasync.companion.data.UploadQueueStore.getInstance(context)
                .pendingItems().any { it.mediaIdentity != null }
        ) {
            UploadWorkScheduler.scheduleAutoUploads(
                context,
                UploadPolicy(
                    unmeteredOnly = recordStore.load().settings.unmeteredOnly,
                    chargingOnly = recordStore.load().settings.chargingOnly,
                ),
            )
        }

        return Result.success()
    }
}