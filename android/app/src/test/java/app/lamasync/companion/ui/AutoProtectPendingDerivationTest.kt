package app.lamasync.companion.ui

import app.lamasync.companion.data.UploadQueueItem
import app.lamasync.companion.data.UploadStatus
import app.lamasync.companion.media.MediaCollection
import app.lamasync.companion.media.MediaRecordStatus
import app.lamasync.companion.media.AutoSource
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * P1: the pending figure must be a NON-double-counting total derived from
 * the media records PLUS the queue's live progress, with the actionable
 * unreadable count kept separate. Queue-only counting shows 0 pending while
 * records wait on a destination/space/readability problem; record+queue
 * union by media identity fixes that.
 */
class AutoProtectPendingDerivationTest {

    private fun record(
        id: Long,
        status: MediaRecordStatus,
        size: Long? = 1000L,
        collection: MediaCollection = MediaCollection.IMAGES,
    ) = app.lamasync.companion.media.MediaRecord(
        identityKey = "${collection.name.lowercase()}:$id@external_primary",
        mediaId = id,
        volume = "external_primary",
        collection = collection,
        source = AutoSource.CAMERA_PHOTOS,
        uri = "content://media/x/$id",
        displayName = "IMG_$id.jpg",
        sizeBytes = size,
        status = status,
    )

    private fun item(
        id: String,
        identity: String?,
        status: UploadStatus,
        size: Long? = 1000L,
    ) = UploadQueueItem(
        id = id,
        origin = "https://fleet.example.com",
        hostId = "mob-1",
        sourceUri = "content://x",
        displayName = "f.jpg",
        destinationId = "mdst-1",
        destinationRelPath = "Mobile/mob-1/Camera",
        idempotencyKey = "k-$id",
        sizeBytes = size,
        mediaIdentity = identity,
        status = status,
        createdAtEpochMillis = 1L,
        updatedAtEpochMillis = 1L,
    )

    @Test
    fun stagedRecordWithLiveQueueItemCountsOnce() {
        val rec = record(1L, MediaRecordStatus.STAGED)
        val pending = AutoProtectViewModel.derivePending(
            listOf(rec),
            listOf(item("q1", rec.identityKey, UploadStatus.PENDING, size = 1200L)),
        )
        assertEquals(1L, pending.pendingCount)
        assertEquals(1200L, pending.pendingBytes) // the queue item's staged size wins
    }

    @Test
    fun discoveredRecordWithoutQueueItemStillCountsPending() {
        // Blocked by a missing destination/space/readability — never reached
        // the queue, so a queue-only count would wrongly show 0 pending.
        val pending = AutoProtectViewModel.derivePending(
            listOf(record(1L, MediaRecordStatus.DISCOVERED, size = 700L)),
            emptyList(),
        )
        assertEquals(1L, pending.pendingCount)
        assertEquals(700L, pending.pendingBytes)
    }

    @Test
    fun unreadableIsCountedPendingAndReportedSeparately() {
        val pending = AutoProtectViewModel.derivePending(
            listOf(
                record(1L, MediaRecordStatus.UNREADABLE, size = 42L),
                record(2L, MediaRecordStatus.PROTECTED),
            ),
            emptyList(),
        )
        assertEquals(1L, pending.pendingCount)
        assertEquals(1L, pending.unreadableCount)
        assertEquals(42L, pending.pendingBytes)
    }

    @Test
    fun doneAndCancelledQueueItemsDoNotCount() {
        val rec = record(1L, MediaRecordStatus.PROTECTED)
        val pending = AutoProtectViewModel.derivePending(
            listOf(rec),
            listOf(item("q1", rec.identityKey, UploadStatus.DONE)),
        )
        assertEquals(0L, pending.pendingCount)
        assertEquals(0L, pending.pendingBytes)
    }

    @Test
    fun mixedRecordsAndQueueItemsUnionWithoutDuplication() {
        val staged = record(1L, MediaRecordStatus.STAGED)
        val failed = record(2L, MediaRecordStatus.FAILED, size = 300L)
        val protected = record(3L, MediaRecordStatus.PROTECTED)
        val locallyDeleted = record(4L, MediaRecordStatus.LOCALLY_DELETED)
        val pending = AutoProtectViewModel.derivePending(
            listOf(staged, failed, protected, locallyDeleted),
            listOf(
                item("q1", staged.identityKey, UploadStatus.UPLOADING, size = 1500L),
                item("q2", failed.identityKey, UploadStatus.FAILED, size = 300L),
                // DONE item for an unknown identity: ignored.
                item("q3", "images:99@external_primary", UploadStatus.DONE, size = 5000L),
            ),
        )
        // staged + failed = 2 identities; protected/deleted excluded.
        assertEquals(2L, pending.pendingCount)
        assertEquals(1500L + 300L, pending.pendingBytes)
        assertEquals(0L, pending.unreadableCount)
    }
}
