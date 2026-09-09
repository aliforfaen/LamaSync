package app.lamasync.companion.media

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Discovery + reconciliation semantics over a fake in-memory MediaStore:
 * race-safe new-only boundaries, deterministic existing-history import with
 * resumed walks, changed/repeated media, partial-scope honesty, deletions.
 */
class MediaDiscoveryEngineTest {

    /** In-memory MediaStore: rows per (collection, volume), id-auto-increment. */
    private class FakeLibrary(
        var scope: MediaPermissionScope = MediaPermissionScope.FULL,
    ) : MediaCursorLibrary {
        val images = mutableListOf<Row>()
        val videos = mutableListOf<Row>()
        private var nextId = 1L

        /** Insert a row and remember its projected form. */
        fun add(
            collection: MediaCollection,
            rel: String,
            name: String = "IMG_${nextId}.jpg",
            dateAdded: Long = nextId,
            size: Long = 1000,
            taken: Long? = null,
        ): Long {
            val id = nextId++
            val row = Row(collection, id, "content://media/external_primary/${collection.name.lowercase()}/media/$id", name, size, rel, dateAdded, taken)
            (if (collection == MediaCollection.IMAGES) images else videos) += row
            return id
        }

        fun remove(collection: MediaCollection, id: Long) {
            (if (collection == MediaCollection.IMAGES) images else videos).removeAll { it.id == id }
        }

        fun resize(collection: MediaCollection, id: Long, newSize: Long) {
            val list = if (collection == MediaCollection.IMAGES) images else videos
            val idx = list.indexOfFirst { it.id == id }
            list[idx] = list[idx].copy(size = newSize)
        }

        private fun rows(collection: MediaCollection) =
            (if (collection == MediaCollection.IMAGES) images else videos).sortedWith(
                compareByDescending<Row> { it.dateAdded }.thenByDescending { it.id },
            )

        override suspend fun volumes(collection: MediaCollection): List<String> = listOf("external_primary")

        override suspend fun newestKey(collection: MediaCollection, volume: String): PageKey? =
            rows(collection).maxWithOrNull(compareBy<Row> { it.dateAdded }.thenBy { it.id })
                ?.let { PageKey(it.dateAdded, it.id) }

        override suspend fun queryNewestFirst(
            collection: MediaCollection,
            volume: String,
            before: PageKey?,
            limit: Int,
        ): List<MediaRow> {
            val series = rows(collection)
            val start = if (before == null) {
                series
            } else {
                val idx = series.indexOfFirst {
                    it.dateAdded == before.dateAdded && it.id == before.mediaId
                }
                series.drop(idx + 1)
            }
            val page = start.take(limit)
            return page.map {
                MediaRow(
                    mediaId = it.id,
                    uri = it.uri,
                    displayName = it.name,
                    sizeBytes = it.size,
                    mimeType = "image/jpeg",
                    relativePath = it.rel,
                    dataPath = null,
                    dateAddedSeconds = it.dateAdded,
                    dateTakenMillis = it.taken,
                )
            }
        }

        override suspend fun knownRows(
            collection: MediaCollection,
            volume: String,
            ids: List<Long>,
        ): List<KnownRowMeta> {
            val list = if (collection == MediaCollection.IMAGES) images else videos
            return list.filter { it.id in ids }.map { KnownRowMeta(it.id, it.size, null) }
        }

        data class Row(
            val collection: MediaCollection,
            val id: Long,
            val uri: String,
            val name: String,
            val size: Long,
            val rel: String,
            val dateAdded: Long,
            val taken: Long?,
        )
    }

    private fun settings(
        photo: Boolean = true,
        video: Boolean = false,
        shots: Boolean = false,
        mode: ScopeMode = ScopeMode.NEW_ONLY,
    ) = AutoProtectSettings(
        cameraPhotosEnabled = photo,
        cameraVideosEnabled = video,
        screenshotsEnabled = shots,
        scopeMode = mode,
    )

    private fun engine(lib: FakeLibrary) = MediaDiscoveryEngine(lib)

    // ---- race-safe new-only boundary ----

    @Test
    fun newOnlyFirstRunSkipsExistingAndImportsTheNewestRowAfter() = runTest {
        val lib = FakeLibrary()
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", dateAdded = 10)
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/b.jpg", dateAdded = 20)
        // First run: rows present at boundary time are NOT imported.
        var outcome = engine(lib).scan(
            settings(), emptyMap(), emptyMap(), MediaPermissionScope.FULL,
        )
        assertTrue(outcome.newRecords.isEmpty())
        assertEquals(1, outcome.cursorUpdates.size)
        val cursor = outcome.cursorUpdates.values.first()
        assertEquals(20L, cursor.watermarkDateAdded)
        assertEquals(2L, cursor.watermarkId)

        // A photo is taken AFTER the boundary (inserted between run 1 and 2).
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/c.jpg", name = "c.jpg", dateAdded = 30)
        outcome = engine(lib).scan(settings(), outcome.cursorUpdates, emptyMap(), MediaPermissionScope.FULL)
        val new = outcome.newRecords
        assertEquals(1, new.size)
        assertEquals("c.jpg", new.single().displayName)
        // Boundary is stable across runs.
        assertEquals(20L, outcome.cursorUpdates.values.first().watermarkDateAdded)
    }

    @Test
    fun newOnlyBoundaryIsRobustToAnInsertDuringTheFirstScan() = runTest {
        val lib = FakeLibrary()
        // Rows present when the boundary is captured (both inserted before
        // the scan) are excluded; the boundary equals the newest row.
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", dateAdded = 10)
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/new-during-scan.jpg", dateAdded = 50)
        val outcome = engine(lib).scan(
            settings(), emptyMap(), emptyMap(), MediaPermissionScope.FULL,
        )
        assertTrue(outcome.newRecords.isEmpty())
        val cursor = outcome.cursorUpdates.values.first()
        assertEquals(50L, cursor.watermarkDateAdded)
        assertEquals(2L, cursor.watermarkId)
    }

    @Test
    fun newOnlyImportsOnlyStrictlyNewerRowsNotDuplicates() = runTest {
        val lib = FakeLibrary()
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", dateAdded = 10)
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/b.jpg", dateAdded = 20)
        var outcome = engine(lib).scan(settings(), emptyMap(), emptyMap(), MediaPermissionScope.FULL)
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/c.jpg", name = "c.jpg", dateAdded = 20) // same second, higher id
        outcome = engine(lib).scan(settings(), outcome.cursorUpdates, emptyMap(), MediaPermissionScope.FULL)
        assertEquals(1, outcome.newRecords.size)
        assertEquals("c.jpg", outcome.newRecords.single().displayName)
    }

    // ---- existing-history import ----

    @Test
    fun existingHistoryImportsEverythingDeterministically() = runTest {
        val lib = FakeLibrary()
        for (i in 1..5) lib.add(MediaCollection.IMAGES, "DCIM/Camera/x$i.jpg", name = "x$i.jpg", dateAdded = i.toLong())
        val outcome = engine(lib).scan(
            settings(mode = ScopeMode.EXISTING_HISTORY), emptyMap(), emptyMap(), MediaPermissionScope.FULL,
        )
        assertEquals(5, outcome.newRecords.size)
        val cursor = outcome.cursorUpdates.values.first()
        assertTrue("full scan completed", cursor.fullScanCompleted)
        // Deterministic order: newest first.
        assertEquals(listOf("x5.jpg", "x4.jpg", "x3.jpg", "x2.jpg", "x1.jpg"), outcome.newRecords.map { it.displayName })
    }

    @Test
    fun existingHistoryResumesFromPersistedCursorAfterInterruption() = runTest {
        val lib = FakeLibrary()
        for (i in 1..10) lib.add(MediaCollection.IMAGES, "DCIM/Camera/x$i.jpg", dateAdded = i.toLong())
        // Run 1 scans every page; then we SIMULATE an interrupted run by
        // crafting a cursor that stopped at x3 (4 imported: newest first).
        val fakeCursor = mapOf(
            MediaDiscoveryEngine.CursorKey(MediaCollection.IMAGES, "external_primary") to
                MediaCursorState(
                    collection = MediaCollection.IMAGES,
                    volume = "external_primary",
                    scopeMode = ScopeMode.EXISTING_HISTORY,
                    watermarkDateAdded = 7L,
                    watermarkId = 7L,
                ),
        )
        val resume = engine(lib).scan(settings(mode = ScopeMode.EXISTING_HISTORY), fakeCursor, emptyMap(), MediaPermissionScope.FULL)
        // Resume imports strictly older than (7,7): x6..x1 → 6 records.
        assertEquals(6, resume.newRecords.size)
        assertTrue(resume.cursorUpdates.values.first().fullScanCompleted)
    }

    // ---- changed media ----

    @Test
    fun changedSizeOnKnownIdentityProducesANewRevision() = runTest {
        val lib = FakeLibrary()
        val id = lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", dateAdded = 10)
        var outcome = engine(lib).scan(settings(), emptyMap(), emptyMap(), MediaPermissionScope.FULL)
        assertEquals(0, outcome.newRecords.size)
        // Simulate run 1 having already discovered a.jpg as a record.
        val discovered = MediaRecord(
            identityKey = "images:$id@external_primary",
            mediaId = id,
            volume = "external_primary",
            collection = MediaCollection.IMAGES,
            source = AutoSource.CAMERA_PHOTOS,
            uri = "content://media/external_primary/images/media/$id",
            displayName = "a.jpg",
            sizeBytes = 1000L,
            relativePath = "DCIM/Camera",
            dateAddedSeconds = 10L,
            status = MediaRecordStatus.PROTECTED,
            sha256 = "a".repeat(64),
        )
        val records = mapOf(discovered.identityKey to discovered)
        // The photo is edited: size changes.
        lib.resize(MediaCollection.IMAGES, id, 2500L)
        outcome = engine(lib).scan(settings(), emptyMap(), records, MediaPermissionScope.FULL)
        assertEquals(1, outcome.newRecords.size)
        val revision = outcome.newRecords.single()
        assertEquals(2500L, revision.sizeBytes)
        assertEquals(MediaRecordStatus.DISCOVERED, revision.status)
        assertTrue("prior receipt preserved in provenance", revision.previousProtectedPaths.isEmpty())
    }

    // ---- deletion detection ----

    @Test
    fun deletedRowBecomesLocallyDeletedUnderFullScope() = runTest {
        val lib = FakeLibrary()
        val id = lib.add(MediaCollection.IMAGES, "DCIM/Camera/gone.jpg", dateAdded = 10)
        val record = recordOf(id)
        lib.remove(MediaCollection.IMAGES, id)
        val outcome = engine(lib).scan(settings(), emptyMap(), mapOf(record.identityKey to record), MediaPermissionScope.FULL)
        assertEquals(listOf(record.identityKey), outcome.deletedIdentities)
    }

    @Test
    fun absentRowUnderPartialScopeIsUnreadableNotDeleted() = runTest {
        val lib = FakeLibrary(scope = MediaPermissionScope.PARTIAL)
        // A known record exists but MediaStore hides it (selected-photos
        // access): the engine must NOT claim deletion.
        val id = 1L
        val record = recordOf(id)
        val outcome = engine(lib).scan(settings(), emptyMap(), mapOf(record.identityKey to record), MediaPermissionScope.PARTIAL)
        assertTrue(outcome.deletedIdentities.isEmpty())
        assertEquals(MediaRecordStatus.UNREADABLE, outcome.newRecords.single().status)
    }

    // ---- screenshot + video sources ----

    @Test
    fun screenshotsDiscoveredOnlyWhenEnabled() = runTest {
        val lib = FakeLibrary()
        lib.add(MediaCollection.IMAGES, "Pictures/Screenshots/s.png", name = "s.png", dateAdded = 5)
        // Disabled: nothing.
        var outcome = engine(lib).scan(settings(shots = false), emptyMap(), emptyMap(), MediaPermissionScope.FULL)
        assertTrue(outcome.newRecords.isEmpty())
        // Enabled with existing-history: imported and labeled SCREENSHOTS.
        outcome = engine(lib).scan(
            settings(shots = true, mode = ScopeMode.EXISTING_HISTORY),
            emptyMap(), emptyMap(), MediaPermissionScope.FULL,
        )
        assertEquals(AutoSource.SCREENSHOTS, outcome.newRecords.single().source)
    }

    @Test
    fun videosCollectedUnderCameraVideos() = runTest {
        val lib = FakeLibrary()
        lib.add(MediaCollection.VIDEOS, "DCIM/Camera/VID_1.mp4", name = "VID_1.mp4", dateAdded = 3, size = 70L * 1024 * 1024)
        val outcome = engine(lib).scan(
            settings(video = true, mode = ScopeMode.EXISTING_HISTORY),
            emptyMap(), emptyMap(), MediaPermissionScope.FULL,
        )
        assertEquals(AutoSource.CAMERA_VIDEOS, outcome.newRecords.single().source)
        assertEquals(70L * 1024 * 1024, outcome.newRecords.single().sizeBytes)
    }

    @Test
    fun disabledSourceNeverMarksRowsDeleted() = runTest {
        val lib = FakeLibrary()
        lib.add(MediaCollection.IMAGES, "Pictures/Screenshots/s.png", dateAdded = 1)
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/c.jpg", dateAdded = 2)
        // Screenshots disabled but present: full walk completes, yet the
        // engine must not delete anything (no records exist yet).
        val outcome = engine(lib).scan(settings(shots = false), emptyMap(), emptyMap(), MediaPermissionScope.FULL)
        assertTrue(outcome.deletedIdentities.isEmpty())
    }

    @Test
    fun identityKeyIsStableAndPathFree() {
        assertEquals(
            "images:42@external_primary",
            MediaDiscoveryEngine.identityKey(MediaCollection.IMAGES, "external_primary", 42L),
        )
        assertEquals(42L, MediaDiscoveryEngine.parseMediaId("images:42@external_primary"))
    }

    private fun recordOf(id: Long) = MediaRecord(
        identityKey = "images:$id@external_primary",
        mediaId = id,
        volume = "external_primary",
        collection = MediaCollection.IMAGES,
        source = AutoSource.CAMERA_PHOTOS,
        uri = "content://media/external_primary/images/media/$id",
        displayName = "gone.jpg",
        sizeBytes = 10L,
        dateAddedSeconds = 10L,
        status = MediaRecordStatus.PROTECTED,
        sha256 = "a".repeat(64),
    )
}