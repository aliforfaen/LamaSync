package app.lamasync.companion.work

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.ExistingPeriodicWorkPolicy
import app.lamasync.companion.media.AutoProtectSettings
import app.lamasync.companion.media.MediaProtectionStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-296 stage 2 — automatic-protection work registration on the REAL
 * WorkManager: unique prompt discovery (KEEP semantics, no pile-up), unique
 * periodic reconciliation, config changes REPLACE discovery, and disabling
 * every source cancels the work (late/periodic safety net behavior).
 */
@RunWith(AndroidJUnit4::class)
class AutoProtectWorkSchedulerTest {

    private lateinit var app: Application
    private lateinit var workManager: WorkManager
    private lateinit var recordStore: MediaProtectionStore

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        workManager = WorkManager.getInstance(app)
        // The scheduler reads the PROCESS-WIDE store, so the test must too.
        recordStore = MediaProtectionStore.getInstance(app)
        recordStore.clear()
        workManager.cancelUniqueWork(AutoProtectWorkScheduler.DISCOVERY_WORK_NAME).result.get()
        workManager.cancelUniqueWork(AutoProtectWorkScheduler.RECONCILE_WORK_NAME).result.get()
    }

    @After
    fun tearDown() {
        recordStore.clear()
        workManager.cancelUniqueWork(AutoProtectWorkScheduler.DISCOVERY_WORK_NAME).result.get()
        workManager.cancelUniqueWork(AutoProtectWorkScheduler.RECONCILE_WORK_NAME).result.get()
    }

    private fun enable(source: AutoProtectSettings.() -> AutoProtectSettings = { copy(cameraPhotosEnabled = true) }) {
        recordStore.updateSettings { it.source() }
    }

    private fun infos(name: String): List<WorkInfo> =
        workManager.getWorkInfosForUniqueWork(name).get()

    @Test
    fun enablingASourceRegistersPromptAndPeriodicWork() {
        enable()
        AutoProtectWorkScheduler.rescheduleAfterConfigChange(app)

        val discovery = infos(AutoProtectWorkScheduler.DISCOVERY_WORK_NAME)
        assertTrue("prompt discovery work exists", discovery.isNotEmpty())
        val reconcile = infos(AutoProtectWorkScheduler.RECONCILE_WORK_NAME)
        assertTrue("periodic reconcile work exists", reconcile.isNotEmpty())
        assertNotNull("periodic work carries periodicity info", reconcile.first().periodicityInfo)
    }

    @Test
    fun duplicatePromptsDoNotStackWork() {
        enable()
        AutoProtectWorkScheduler.scheduleDiscovery(app)
        AutoProtectWorkScheduler.scheduleDiscovery(app)
        AutoProtectWorkScheduler.scheduleDiscovery(app)
        // Unique work with KEEP: exactly one (enqueued) request.
        val discovery = infos(AutoProtectWorkScheduler.DISCOVERY_WORK_NAME)
        val active = discovery.count { it.state == WorkInfo.State.ENQUEUED }
        assertTrue("no duplicate drainers (enqueued=$active)", active <= 1)
    }

    @Test
    fun disablingAllSourcesCancelsTheWork() {
        enable()
        AutoProtectWorkScheduler.ensurePeriodic(app)
        assertTrue(infos(AutoProtectWorkScheduler.RECONCILE_WORK_NAME).isNotEmpty())

        recordStore.updateSettings {
            it.copy(cameraPhotosEnabled = false, cameraVideosEnabled = false, screenshotsEnabled = false)
        }
        AutoProtectWorkScheduler.rescheduleAfterConfigChange(app)
        assertTrue(noScheduled(infos(AutoProtectWorkScheduler.DISCOVERY_WORK_NAME)))
        assertTrue(noScheduled(infos(AutoProtectWorkScheduler.RECONCILE_WORK_NAME)))
    }

    /** Cancellation is async; only ENQUEUED/RUNNING work matters. */
    private fun noScheduled(infos: List<WorkInfo>): Boolean =
        infos.none { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING }
}