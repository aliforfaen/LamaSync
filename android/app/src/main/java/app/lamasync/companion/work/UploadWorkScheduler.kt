package app.lamasync.companion.work

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import app.lamasync.companion.data.UploadPolicy
import app.lamasync.companion.data.UploadQueueStore
import java.util.concurrent.TimeUnit

/**
 * LAMA-296 stage 1 — WorkManager scheduling for the upload queue.
 *
 * Current Android guidance (verified against the SDK 35 docs): WorkManager
 * is the persistent scheduling API for user-initiated/deferred work that
 * must survive process death and reboot; constraints (network type,
 * charging) gate execution. Deferred execution is accepted — no promise of
 * immediate background transfer; the app enqueues whenever the queue gains
 * items and re-enqueues after policy changes.
 *
 * LAMA-296 stage-1 correction (R6): a POLICY CHANGE must actually replace
 * the scheduled work's constraints. `enqueueUniqueWork(..., KEEP, ...)`
 * keeps the ORIGINAL request when work already exists, so the toggle could
 * leave transfers stuck on an obsolete unmetered/connected requirement.
 * Ordinary enqueues use KEEP (no duplicate drainer); `rescheduleWithPolicy`
 * uses REPLACE, which cancels the existing work (running or pending) and
 * enqueues a fresh request carrying the new constraint — offset/resume
 * durability makes the cancel harmless, and a re-enqueue re-runs any
 * remaining items under the new policy. Verified for BOTH transitions
 * (CONNECTED ↔ UNMETERED) by the on-device regression test.
 */
object UploadWorkScheduler {

    const val UPLOAD_QUEUE_WORK_NAME = "lamasync:upload-queue"

    /** Separate drainer for AUTOMATIC media items so the Auto Protect
     *  screen's transfer conditions cannot delay explicit user shares (and
     *  vice-versa). Both drainers run the same durable [UploadWorker] with a
     *  kind-scoped item filter. */
    const val AUTO_UPLOAD_QUEUE_WORK_NAME = "lamasync:auto-upload-queue"

    /** Which pending items a drainer pass owns. ALL is the backward-
     *  compatible default; the manual and automatic UI paths never use it. */
    enum class UploadItemKind { ALL, AUTO, MANUAL }

    /** Enqueue (or keep) the draining worker. KEEP avoids duplicate workers;
     *  when the worker runs it re-evaluates pendingItems() fresh, so a
     *  previous run that ended early is picked up by the next enqueue. */
    fun scheduleUploads(
        context: Context,
        policy: UploadPolicy = UploadPolicy(),
        kind: UploadItemKind = UploadItemKind.ALL,
    ) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            UPLOAD_QUEUE_WORK_NAME,
            ExistingWorkPolicy.KEEP,
            requestFor(policy, kind),
        )
    }

    /** Rebuild the scheduled work after a policy change (e.g. the unmetered
     *  toggle): REPLACE cancels the stale request and enqueues one carrying
     *  the NEW constraint — both policy transitions actually take effect. */
    fun rescheduleWithPolicy(
        context: Context,
        policy: UploadPolicy,
        kind: UploadItemKind = UploadItemKind.ALL,
    ) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            UPLOAD_QUEUE_WORK_NAME,
            ExistingWorkPolicy.REPLACE,
            requestFor(policy, kind),
        )
    }

    /** Automatic items: dedicated drainer with the AUTOMATIC policy.
     *  REPLACE so a policy change on the Auto Protect screen takes effect. */
    fun scheduleAutoUploads(context: Context, policy: UploadPolicy) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            AUTO_UPLOAD_QUEUE_WORK_NAME,
            ExistingWorkPolicy.REPLACE,
            requestFor(policy, UploadItemKind.AUTO),
        )
    }

    /** A durable local cancellation must get a worker pass even when the
     * previous unique request is in its completion window. REPLACE also stops
     * an active transfer before the reconciliation worker contacts the server. */
    fun scheduleCancellationReconciliation(
        context: Context,
        policy: UploadPolicy = UploadPolicy(),
        kind: UploadItemKind = UploadItemKind.ALL,
    ) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            UPLOAD_QUEUE_WORK_NAME,
            ExistingWorkPolicy.REPLACE,
            requestFor(policy, kind),
        )
    }

    /** One drainer request carrying the policy's network + charging
     *  constraints and the item-kind scope (stage 2 adds charging and the
     *  automatic/manual split; transitions are REPLACEd on policy change). */
    fun requestFor(
        policy: UploadPolicy,
        kind: UploadItemKind = UploadItemKind.ALL,
    ): OneTimeWorkRequest {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(
                if (policy.unmeteredOnly) NetworkType.UNMETERED else NetworkType.CONNECTED,
            )
            .setRequiresCharging(policy.chargingOnly)
            .build()
        return OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(constraints)
            .setInputData(workDataOf(UploadWorker.KEY_KIND to kind.name))
            .setBackoffCriteria(
                androidx.work.BackoffPolicy.EXPONENTIAL,
                30,
                TimeUnit.SECONDS,
            )
            .build()
    }

    /** True when any transferable item remains (UI gate for buttons). */
    fun hasPendingWork(context: Context): Boolean =
        UploadQueueStore(context).pendingItems().isNotEmpty()
}
