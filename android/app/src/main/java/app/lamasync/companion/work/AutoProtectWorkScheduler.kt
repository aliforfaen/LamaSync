package app.lamasync.companion.work

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequest
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import app.lamasync.companion.data.UploadPolicy
import app.lamasync.companion.media.AutoProtectSettings
import app.lamasync.companion.media.MediaProtectionStore
import java.util.concurrent.TimeUnit

/**
 * LAMA-296 stage 2 — WorkManager scheduling for automatic protection.
 *
 * Two work lanes, both durable across process death and reboot:
 *  - prompt discovery (`auto-protect-discovery`): unique ONE-TIME work,
 *    deliberately unconstrained — discovery and bounded LOCAL staging need
 *    no network; the worker schedules the constrained drainer afterwards.
 *    Enqueued on app start/resume, boot, source/policy changes, and whenever
 *    the scanner runs, so new camera media gets picked up quickly when
 *    Android permits.
 *  - periodic reconciliation (`auto-protect-reconcile`): unique ~6 h
 *    PeriodicWorkRequest — the safety net for missed observer events, edits,
 *    permission changes and process death; it re-scans from the durable
 *    watermark and re-schedules the drainer.
 * The drainer itself remains the stage-1 unique upload-queue worker with
 * the policy's network + charging constraints (REPLACE on policy change).
 *
 * No exact schedule promises: PeriodicWorkRequest intervals are approximate
 * and deferred execution is accepted by design (official guidance).
 */
object AutoProtectWorkScheduler {

    const val DISCOVERY_WORK_NAME = "lamasync:auto-protect-discovery"
    const val RECONCILE_WORK_NAME = "lamasync:auto-protect-reconcile"

    /** 6 h nominal reconciliation cadence (approximate by contract). */
    private val RECONCILE_INTERVAL_HOURS = 6L

    /** Prompt discovery for newly enabled sources or app start/resume. */
    fun scheduleDiscovery(context: Context) {
        if (!sourcesEnabled(context)) return
        WorkManager.getInstance(context).enqueueUniqueWork(
            DISCOVERY_WORK_NAME,
            ExistingWorkPolicy.KEEP,
            discoveryRequest(),
        )
    }

    /**
     * Policy/source change: REPLACE the prompted discovery work so the next
     * run carries the NEW configuration (stage-1 R6 pattern). The periodic
     * reconciliation is kept (its constraints never encode policy).
     */
    fun rescheduleAfterConfigChange(context: Context) {
        if (!sourcesEnabled(context)) {
            WorkManager.getInstance(context).cancelUniqueWork(DISCOVERY_WORK_NAME)
            return
        }
        WorkManager.getInstance(context).enqueueUniqueWork(
            DISCOVERY_WORK_NAME,
            ExistingWorkPolicy.REPLACE,
            discoveryRequest(),
        )
        ensurePeriodic(context)
    }

    /** (Re)create the periodic reconciliation with the CURRENT cadence. */
    fun ensurePeriodic(context: Context) {
        if (!sourcesEnabled(context)) {
            WorkManager.getInstance(context).cancelUniqueWork(RECONCILE_WORK_NAME)
            return
        }
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            RECONCILE_WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            reconcileRequest(),
        )
    }

    /** Boot recovery: all durable state survives, work is re-registered. */
    fun onBootCompleted(context: Context) {
        if (!sourcesEnabled(context)) return
        ensurePeriodic(context)
        scheduleDiscovery(context)
    }

    /** Discovery is local-only (no network/charging constraint) so it can run
     *  promptly; transfers are constrained by the drainer's policy. */
    fun discoveryRequest(): OneTimeWorkRequest = OneTimeWorkRequestBuilder<AutoProtectWorker>()
        .setConstraints(Constraints.Builder().build())
        .setBackoffCriteria(
            androidx.work.BackoffPolicy.EXPONENTIAL,
            15,
            TimeUnit.SECONDS,
        )
        .build()

    fun reconcileRequest(): PeriodicWorkRequest =
        PeriodicWorkRequestBuilder<AutoProtectWorker>(RECONCILE_INTERVAL_HOURS, TimeUnit.HOURS)
            .setConstraints(Constraints.Builder().build())
            .build()

    private fun sourcesEnabled(context: Context): Boolean {
        val store = MediaProtectionStore(context)
        val settings = store.load().settings
        return settings.anySourceEnabled
    }
}

/**
 * BOOT_COMPLETED receiver: re-registers periodic + prompt work after a
 * reboot (the periodic work alone covers the cadence; the prompt work makes
 * the first pass happen promptly when Android permits).
 */
class AutoProtectBootReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: android.content.Intent) {
        if (intent.action == android.content.Intent.ACTION_BOOT_COMPLETED) {
            AutoProtectWorkScheduler.onBootCompleted(context)
        }
    }
}