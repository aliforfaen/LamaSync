package app.lamasync.companion.data

import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** In-memory [QueueStorage] for JVM tests. */
class MemoryQueueStorage : QueueStorage {
    private val map = mutableMapOf<String, String>()
    override fun read(key: String): String? = map[key]
    override fun write(key: String, value: String) {
        map[key] = value
    }
}

/**
 * LAMA-296 stage 1 — queue durability: persistence across store instances
 * (process-death analog), binding identity at intake, terminal-state
 * management, and refusal to re-submit work under a new identity.
 *
 * Stage-1 corrections: R1 — process-wide serialization (concurrent writers
 * across instances never lose updates) and snapshot-flow observation; R2 —
 * durable cancellation can never be overwritten by a stale worker write and
 * survives a restart, while the server-authoritative CANCELLED → DONE
 * reconciliation stays possible.
 */
class UploadQueueStoreTest {

    @Test(expected = java.io.IOException::class)
    fun failedDurableWriteIsNotReportedAsSuccess() {
        val store = UploadQueueStore(object : QueueStorage {
            override fun read(key: String): String? = null
            override fun write(key: String, value: String) {
                throw java.io.IOException("disk full")
            }
        })

        store.add(item())
    }

    private fun item(
        origin: String = "https://fleet.example.com",
        hostId: String = "mob-host-1",
        status: UploadStatus = UploadStatus.PENDING,
    ): UploadQueueItem = UploadQueueItem(
        id = "item-$origin-$hostId",
        origin = origin,
        hostId = hostId,
        sourceUri = "content://authority/doc",
        displayName = "doc.pdf",
        destinationId = "mdst-1",
        destinationRelPath = "Mobile/$hostId/Inbox",
        idempotencyKey = "up-12345678",
        staged = true,
        status = status,
        createdAtEpochMillis = 1L,
        updatedAtEpochMillis = 1L,
    )

    @Test
    fun persistsAcrossStoreInstancesLikeProcessDeath() {
        val storage = MemoryQueueStorage()
        UploadQueueStore(storage).add(item())
        val reloaded = UploadQueueStore(storage).load().items
        assertEquals(1, reloaded.size)
        assertEquals("doc.pdf", reloaded.first().displayName)
        assertEquals("mob-host-1", reloaded.first().hostId)
    }

    @Test
    fun itemsBindToTheEnrollmentIdentityAndOrigin() {
        val storage = MemoryQueueStorage()
        UploadQueueStore(storage).add(item())
        val loaded = UploadQueueStore(storage).load().items.single()
        // The transfer executor checks these two fields against the CURRENT
        // registration — re-pairing at the same origin (new hostId) blocks
        // the item instead of redirecting it.
        assertEquals("https://fleet.example.com", loaded.origin)
        assertEquals("mob-host-1", loaded.hostId)
    }

    @Test
    fun pendingItemsFiltersOutTerminalState() {
        val storage = MemoryQueueStorage()
        val store = UploadQueueStore(storage)
        store.add(item(status = UploadStatus.PENDING))
        store.add(item(hostId = "mob-host-2", status = UploadStatus.DONE))
        store.add(item(hostId = "mob-host-3", status = UploadStatus.CANCELLED))
        assertEquals(1, store.pendingItems().size)
    }

    @Test
    fun updateMatchesByIdAndKeepsOrder() {
        val storage = MemoryQueueStorage()
        val store = UploadQueueStore(storage)
        val first = item()
        val second = item(hostId = "mob-host-2")
        store.add(first)
        store.add(second)
        store.update(first.copy(status = UploadStatus.UPLOADING, uploadedBytes = 99))
        val items = store.load().items
        assertEquals(UploadStatus.UPLOADING, items.first { it.id == first.id }.status)
        assertEquals(99L, items.first { it.id == first.id }.uploadedBytes)
        assertEquals("mob-host-2", items.first { it.id == second.id }.hostId)
    }

    @Test
    fun corruptSerializationFailsSafeToEmpty() {
        val storage = MemoryQueueStorage()
        storage.write("queue_v1", "{not json")
        val store = UploadQueueStore(storage)
        assertTrue(store.load().items.isEmpty())
    }

    @Test
    fun removeAndClear() {
        val storage = MemoryQueueStorage()
        val store = UploadQueueStore(storage)
        store.add(item())
        store.remove("item-https://fleet.example.com-mob-host-1")
        assertTrue(store.load().items.isEmpty())
        store.add(item(hostId = "mob-host-9"))
        store.clear()
        assertTrue(store.load().items.isEmpty())
    }

    // ---- R1: process-wide serialization + live observation ----

    @Test
    fun concurrentMutationsAcrossInstancesNeverLoseUpdates() {
        val storage = MemoryQueueStorage()
        val store = UploadQueueStore(storage)
        store.add(item())
        // Several "actors" (worker progress writer, UI add/cancel/remove)
        // storm the same queue through SEPARATE store instances; the global
        // mutation lock must serialize every read-modify-write so nothing is
        // lost and each item keeps its LAST update.
        val writers = (0 until 8).map { t ->
            Thread {
                val mine = item(hostId = "mob-$t")
                store.add(mine)
                for (round in 0 until 20) {
                    store.update(
                        mine.copy(
                            status = UploadStatus.UPLOADING,
                            uploadedBytes = round.toLong() * 10,
                            updatedAtEpochMillis = 1L + round,
                        ),
                    )
                }
            }
        }
        writers.forEach { it.start() }
        writers.forEach { it.join() }

        val items = store.load().items
        assertEquals("all nine items survive the storm", 9, items.size)
        for (t in 0 until 8) {
            val mine = items.first { it.hostId == "mob-$t" }
            assertEquals("no update lost for mob-$t", 190L, mine.uploadedBytes)
        }
        assertEquals(UploadStatus.UPLOADING, items.first { it.hostId == "mob-3" }.status)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun snapshotsFlowEmitsEveryMutationForLiveUi() = runTest {
        val store = UploadQueueStore(MemoryQueueStorage())
        val seen = mutableListOf<Int>()
        // Unconfined collector: every store mutation synchronously propagates
        // to the UI-side collector (the mechanism that makes worker progress
        // live without any Activity recreation).
        val job = launch(UnconfinedTestDispatcher(testScheduler)) {
            store.snapshots.collect { seen += it.items.size }
        }
        store.add(item())
        store.add(item(hostId = "mob-2"))
        store.remove("item-https://fleet.example.com-mob-2")
        store.update(item().copy(status = UploadStatus.UPLOADING))
        job.cancel()
        // Cold collector receives the initial snapshot, then every mutation.
        assertEquals(listOf(0, 1, 2, 1, 1), seen)
    }

    // ---- R2: durable cancellation + terminal-state guard ----

    @Test
    fun cancelledItemsAreImmuneToStaleWorkerWrites() {
        val store = UploadQueueStore(MemoryQueueStorage())
        store.add(item())
        store.update(item().copy(status = UploadStatus.CANCELLED))
        // The worker holds a pre-cancel object: UPLOADING/FAILED/BLOCKED
        // writes from it must NOT resurrect the item (the ONLY sanctioned
        // CANCELLED → non-CANCELLED write is the server-authoritative DONE
        // reconciliation, covered separately).
        store.update(item().copy(status = UploadStatus.UPLOADING, uploadedBytes = 10))
        store.update(item().copy(status = UploadStatus.FAILED, error = "lost source"))
        store.update(item().copy(status = UploadStatus.BLOCKED, error = "re-pair required"))
        val survive = store.load().items.single()
        assertEquals(UploadStatus.CANCELLED, survive.status)
        assertEquals(null, survive.error)
    }

    @Test
    fun cancelledStateSurvivesStoreRecreationLikeProcessRestart() {
        val storage = MemoryQueueStorage()
        UploadQueueStore(storage).add(item())
        UploadQueueStore(storage).update(item().copy(status = UploadStatus.CANCELLED))
        // "Process restart": a fresh store instance reads the durable
        // cancel straight back.
        val reloaded = UploadQueueStore(storage).load().items.single()
        assertEquals(UploadStatus.CANCELLED, reloaded.status)
    }

    @Test
    fun authoritativeDoneReconciliationIsAllowedOverCancelled() {
        val store = UploadQueueStore(MemoryQueueStorage())
        store.add(item())
        store.update(item().copy(status = UploadStatus.CANCELLED))
        val receipt = UploadReceipt(
            uploadId = "mup-1",
            fileName = "doc.pdf",
            finalRelPath = "Mobile/mob-host-1/Inbox/doc.pdf",
            browsePath = "Mobile/mob-host-1/Inbox/doc.pdf",
            sizeBytes = 10,
            sha256 = "a".repeat(64),
            finalizedAtEpochMillis = 1L,
        )
        // A cancel that lost the race to finalize must reconcile to DONE with
        // the receipt (the file IS protected) — the one sanctioned
        // CANCELLED → non-CANCELLED transition.
        store.update(item().copy(status = UploadStatus.DONE, receipt = receipt))
        val done = store.load().items.single()
        assertEquals(UploadStatus.DONE, done.status)
        assertEquals("mup-1", done.receipt?.uploadId)
    }

    @Test
    fun doneItemsAreNeverResurrectedByStaleWrites() {
        val store = UploadQueueStore(MemoryQueueStorage())
        store.add(item())
        store.update(item().copy(status = UploadStatus.DONE))
        store.update(item().copy(status = UploadStatus.FAILED, error = "stale"))
        store.update(item().copy(status = UploadStatus.PENDING))
        assertEquals(UploadStatus.DONE, store.load().items.single().status)
    }
}
