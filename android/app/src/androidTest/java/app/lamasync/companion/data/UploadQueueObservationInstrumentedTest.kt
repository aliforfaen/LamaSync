package app.lamasync.companion.data

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-296 stage-1 correction R1 — LIVE queue observation on real Android
 * machinery: worker-style progress and completion written through the shared
 * process-wide store instance MUST appear on a continuously-collecting flow
 * (an already-open Uploads screen) with NO Activity recreation and NO
 * unrelated UI action. Also proves simultaneous two-instance writers (UI +
 * worker) never lose a whole-snapshot update.
 */
@RunWith(AndroidJUnit4::class)
class UploadQueueObservationInstrumentedTest {

    private lateinit var app: Application

    private fun item(status: UploadStatus, id: String = "obs-1"): UploadQueueItem =
        UploadQueueItem(
            id = id,
            origin = "https://fleet.example.com",
            hostId = "mob-obs-1",
            sourceUri = "content://authority/doc",
            displayName = "doc.pdf",
            destinationId = "mdst-1",
            destinationRelPath = "Mobile/mob-obs-1/Inbox",
            idempotencyKey = "up-00000001",
            staged = true,
            stagedFileName = "stage-obs",
            status = status,
            createdAtEpochMillis = 1L,
            updatedAtEpochMillis = 1L,
        )

    private val receipt = UploadReceipt(
        uploadId = "mup-1",
        fileName = "doc.pdf",
        finalRelPath = "Mobile/mob-obs-1/Inbox/doc.pdf",
        browsePath = "Mobile/mob-obs-1/Inbox/doc.pdf",
        sizeBytes = 300,
        sha256 = "a".repeat(64),
        finalizedAtEpochMillis = 99L,
    )

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        UploadQueueStore.getInstance(app).clear()
    }

    @After
    fun tearDown() {
        UploadQueueStore.getInstance(app).clear()
    }

    @Test
    fun workerProgressAndCompletionAppearLiveWithoutRecreation() = runBlocking {
        val store = UploadQueueStore.getInstance(app)
        val seen = mutableListOf<UploadStatus>()
        // The collector stands in for the open Uploads screen: it observes
        // the shared flow continuously; nothing ever re-initializes it.
        val job = launch(Dispatchers.Default) {
            store.snapshots.collect { snap ->
                snap.items.firstOrNull()?.let { seen += it.status }
            }
        }

        // Intake (UI actor) enqueues...
        store.add(item(UploadStatus.PENDING))
        // Worker actor reports durable progress...
        store.update(
            item(UploadStatus.UPLOADING).copy(
                serverUploadId = "mup-1",
                uploadedBytes = 111,
                updatedAtEpochMillis = 2L,
            ),
        )
        // Worker actor reports durable completion...
        store.update(
            item(UploadStatus.DONE).copy(
                serverUploadId = "mup-1",
                serverStatus = "finalized",
                receipt = receipt,
                uploadedBytes = 300,
                updatedAtEpochMillis = 3L,
            ),
        )
        delay(250) // allow the async collector to process every emission
        job.cancel()

        // The UI would have rendered the full lifecycle — no recreation.
        assertEquals(listOf(UploadStatus.PENDING, UploadStatus.UPLOADING, UploadStatus.DONE), seen)
    }

    @Test
    fun concurrentUiAndWorkerWritersNeverLoseASnapshotUpdate() = runBlocking {
        val store = UploadQueueStore.getInstance(app)
        store.add(item(UploadStatus.PENDING, id = "keep-me"))
        val other = item(UploadStatus.PENDING, id = "hot")
        store.add(other)

        val workers = List(6) { i ->
            launch(Dispatchers.Default) {
                for (round in 0 until 25) {
                    store.update(
                        item(UploadStatus.UPLOADING, id = "hot").copy(
                            uploadedBytes = (round + i).toLong(),
                            updatedAtEpochMillis = round.toLong(),
                        ),
                    )
                }
            }
        }
        // UI actor keeps mutating a DIFFERENT item at the same time.
        val ui = launch(Dispatchers.Default) {
            for (round in 0 until 25) {
                store.update(
                    item(UploadStatus.UPLOADING, id = "keep-me").copy(
                        uploadedBytes = round.toLong(),
                        updatedAtEpochMillis = round.toLong(),
                    ),
                )
            }
        }
        workers.forEach { it.join() }
        ui.join()

        val items = store.load().items
        assertEquals(2, items.size)
        val hot = items.first { it.id == "hot" }
        val keep = items.first { it.id == "keep-me" }
        // The UI actor's last write on keep-me survived (sequential, exact);
        // the hot item kept SOME last-writer-wins progress (never a reset to
        // 0 or a lost entire update).
        assertEquals(24L, keep.uploadedBytes)
        assertTrue("hot progress never regressed", hot.uploadedBytes >= 24L)
        assertTrue(hot.status == UploadStatus.UPLOADING)
        assertTrue(keep.status == UploadStatus.UPLOADING)
    }
}