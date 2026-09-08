package app.lamasync.companion.work

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.NetworkType
import androidx.work.WorkManager
import app.lamasync.companion.data.UploadPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-296 stage-1 correction R6 — policy changes must actually REPLACE the
 * scheduled work's constraints. With ExistingWorkPolicy.KEEP a toggle would
 * leave the ORIGINAL constraint in place (transfers stuck on an obsolete
 * unmetered/connected requirement); rescheduleWithPolicy uses REPLACE, which
 * cancels the stale request and enqueues one carrying the NEW constraint.
 * Verified on the REAL WorkManager for BOTH transitions.
 */
@RunWith(AndroidJUnit4::class)
class UploadWorkSchedulerPolicyTest {

    private lateinit var app: Application
    private lateinit var workManager: WorkManager

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        workManager = WorkManager.getInstance(app)
        // Clean slate: no leftover unique upload-queue work between tests.
        workManager.cancelUniqueWork(UploadWorkScheduler.UPLOAD_QUEUE_WORK_NAME).result.get()
    }

    @After
    fun tearDown() {
        workManager.cancelUniqueWork(UploadWorkScheduler.UPLOAD_QUEUE_WORK_NAME).result.get()
    }

    @Test
    fun unmeteredToggleActuallyReplacesBothPolicyDirections() {
        // Direction 1: default (CONNECTED) → unmetered (UNMETERED).
        UploadWorkScheduler.scheduleUploads(app, UploadPolicy(unmeteredOnly = false))
        awaitConstraint(NetworkType.CONNECTED)

        UploadWorkScheduler.rescheduleWithPolicy(app, UploadPolicy(unmeteredOnly = true))
        awaitConstraint(NetworkType.UNMETERED)

        // Direction 2: unmetered → connected (toggle back while queued).
        UploadWorkScheduler.rescheduleWithPolicy(app, UploadPolicy(unmeteredOnly = false))
        awaitConstraint(NetworkType.CONNECTED)
    }

    /** Wait until the unique work's request actually carries [expected]. */
    private fun awaitConstraint(expected: NetworkType) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            val infos = workManager.getWorkInfosForUniqueWork(
                UploadWorkScheduler.UPLOAD_QUEUE_WORK_NAME,
            ).get()
            // With REPLACE the list may transiently hold the cancelled old
            // request too — match one whose constraint is already the target.
            if (infos.any { it.constraints.requiredNetworkType == expected }) return
            Thread.sleep(50)
        }
        val infos = workManager.getWorkInfosForUniqueWork(
            UploadWorkScheduler.UPLOAD_QUEUE_WORK_NAME,
        ).get()
        val states = infos.joinToString { it.state.name + ":" + it.constraints.requiredNetworkType.name }
        throw AssertionError("constraint never became $expected (work: $states)")
    }
}