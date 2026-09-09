package app.lamasync.companion.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Coverage derivation honesty: "protected through" advances only over a
 * CONTIGUOUS chain of satisfied (PROTECTED / LOCALLY_DELETED) records; any
 * pending/unreadable item stops it, and pending bytes/counts are truthful.
 */
class MediaCoverageTest {

    private fun record(
        mediaId: Long,
        status: MediaRecordStatus,
        dateAdded: Long = mediaId,
        size: Long? = 1000L,
        taken: Long? = null,
        source: AutoSource = AutoSource.CAMERA_PHOTOS,
    ) = MediaRecord(
        identityKey = "images:$mediaId@external_primary",
        mediaId = mediaId,
        volume = "external_primary",
        collection = MediaCollection.IMAGES,
        source = source,
        uri = "content://media/external_primary/images/media/$mediaId",
        displayName = "IMG_$mediaId.jpg",
        sizeBytes = size,
        dateAddedSeconds = dateAdded,
        dateTakenMillis = taken,
        status = status,
    )

    @Test
    fun allProtectedGivesFullContiguousBoundary() {
        val snap = MediaCoverage.of(
            listOf(
                record(1, MediaRecordStatus.PROTECTED, dateAdded = 100, taken = 100_000L),
                record(2, MediaRecordStatus.PROTECTED, dateAdded = 200, taken = 200_000L),
                record(3, MediaRecordStatus.PROTECTED, dateAdded = 300, taken = 300_000L),
            ),
        )
        assertEquals(300_000L, snap.protectedThroughEpochMillis)
        assertEquals(3L, snap.contiguousProtectedCount)
        assertEquals(0L, snap.pendingCount)
        assertEquals(0L, snap.pendingBytes)
    }

    @Test
    fun locallyDeletedIsSatisfiedAndKeepsTheChain() {
        val snap = MediaCoverage.of(
            listOf(
                record(1, MediaRecordStatus.PROTECTED, dateAdded = 100),
                record(2, MediaRecordStatus.LOCALLY_DELETED, dateAdded = 200),
                record(3, MediaRecordStatus.PROTECTED, dateAdded = 300),
            ),
        )
        assertEquals(3L, snap.contiguousProtectedCount)
        assertEquals(0L, snap.pendingCount)
        assertEquals(300_000L, snap.protectedThroughEpochMillis)
        assertEquals(0L, snap.pendingCount)
    }

    @Test
    fun pendingItemBreaksTheChainNoMatterWhatComesAfter() {
        val snap = MediaCoverage.of(
            listOf(
                record(1, MediaRecordStatus.PROTECTED, dateAdded = 100),
                record(2, MediaRecordStatus.STAGED, dateAdded = 200, size = 500L),
                record(3, MediaRecordStatus.PROTECTED, dateAdded = 300),
            ),
        )
        // Boundary stops AT item 1 — item 2 pending, item 3 does NOT extend.
        assertEquals(100_000L, snap.protectedThroughEpochMillis)
        assertEquals(1L, snap.contiguousProtectedCount)
        assertEquals(1L, snap.pendingCount)
        assertEquals(500L, snap.pendingBytes)
    }

    @Test
    fun unreadableCountsAsPendingAndActionable() {
        val snap = MediaCoverage.of(
            listOf(
                record(1, MediaRecordStatus.UNREADABLE, dateAdded = 100, size = 42L),
                record(2, MediaRecordStatus.PROTECTED, dateAdded = 200),
            ),
        )
        assertEquals(null, snap.protectedThroughEpochMillis)
        assertEquals(1L, snap.pendingCount)
        assertEquals(42L, snap.pendingBytes)
        assertEquals(1L, snap.unreadableCount)
    }

    @Test
    fun orderingIsByCaptureTimeThenMediaIdNotDiscoveryOrder() {
        // Discovered out of order; coverage must order by capture time.
        val snap = MediaCoverage.of(
            listOf(
                record(3, MediaRecordStatus.PROTECTED, dateAdded = 300),
                record(1, MediaRecordStatus.PROTECTED, dateAdded = 100),
                record(2, MediaRecordStatus.STAGED, dateAdded = 200),
            ),
        )
        assertEquals(100_000L, snap.protectedThroughEpochMillis)
        assertEquals(1L, snap.contiguousProtectedCount)
    }

    @Test
    fun emptyRegistryIsNullBoundary() {
        val snap = MediaCoverage.of(emptyList())
        assertNull(snap.protectedThroughEpochMillis)
        assertEquals(0L, snap.contiguousProtectedCount)
    }

    @Test
    fun fallbackToDateAddedSecondsWhenNoTaken() {
        val snap = MediaCoverage.of(listOf(record(1, MediaRecordStatus.PROTECTED, dateAdded = 7)))
        assertEquals(7_000L, snap.protectedThroughEpochMillis)
    }

    @Test
    fun captureKeyPrefersDateTaken() {
        val r = record(1, MediaRecordStatus.PROTECTED, dateAdded = 100, taken = 999_000L)
        assertEquals(999_000L, MediaCoverage.captureKey(r))
    }
}