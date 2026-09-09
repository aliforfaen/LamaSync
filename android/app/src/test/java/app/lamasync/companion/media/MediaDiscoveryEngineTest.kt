package app.lamasync.companion.media

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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
            modified: Long? = null,
        ): Long {
            val id = nextId++
            val row = Row(
                collection, id,
                "content://media/external_primary/${collection.name.lowercase()}/media/$id",
                name, size, rel, dateAdded, modified ?: dateAdded, taken,
            )
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

        /** Edit the row's date_modified (e.g. a same-size re-encode). */
        fun redate(collection: MediaCollection, id: Long, newModified: Long) {
            val list = if (collection == MediaCollection.IMAGES) images else videos
            val idx = list.indexOfFirst { it.id == id }
            list[idx] = list[idx].copy(modified = newModified)
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
                    dateModifiedSeconds = it.modified,
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
            return list.filter { it.id in ids }.map { KnownRowMeta(it.id, it.size, it.modified) }
        }

        data class Row(
            val collection: MediaCollection,
            val id: Long,
            val uri: String,
            val name: String,
            val size: Long,
            val rel: String,
            val dateAdded: Long,
            val modified: Long,
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

    /** Per-collection scope maps (P0-3): authority is per collection. */
    private val FULL_SCOPE = mapOf(
        MediaCollection.IMAGES to MediaPermissionScope.FULL,
        MediaCollection.VIDEOS to MediaPermissionScope.FULL,
    )
    private val PARTIAL_SCOPE = mapOf(
        MediaCollection.IMAGES to MediaPermissionScope.PARTIAL,
        MediaCollection.VIDEOS to MediaPermissionScope.PARTIAL,
    )
    private fun scope(images: MediaPermissionScope, videos: MediaPermissionScope) = mapOf(
        MediaCollection.IMAGES to images,
        MediaCollection.VIDEOS to videos,
    )

    // ---- race-safe new-only boundary ----

    @Test
    fun newOnlyFirstRunSkipsExistingAndImportsTheNewestRowAfter() = runTest {
        val lib = FakeLibrary()
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", dateAdded = 10)
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/b.jpg", dateAdded = 20)
        // First run: rows present at boundary time are NOT imported.
        var outcome = engine(lib).scan(
            settings(), emptyMap(), emptyMap(), FULL_SCOPE,
        )
        assertTrue(outcome.newRecords.isEmpty())
        assertEquals(1, outcome.cursorUpdates.size)
        val cursor = outcome.cursorUpdates.values.first()
        assertEquals(20L, cursor.watermarkDateAdded)
        assertEquals(2L, cursor.watermarkId)

        // A photo is taken AFTER the boundary (inserted between run 1 and 2).
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/c.jpg", name = "c.jpg", dateAdded = 30)
        outcome = engine(lib).scan(settings(), outcome.cursorUpdates, emptyMap(), FULL_SCOPE)
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
            settings(), emptyMap(), emptyMap(), FULL_SCOPE,
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
        var outcome = engine(lib).scan(settings(), emptyMap(), emptyMap(), FULL_SCOPE)
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/c.jpg", name = "c.jpg", dateAdded = 20) // same second, higher id
        outcome = engine(lib).scan(settings(), outcome.cursorUpdates, emptyMap(), FULL_SCOPE)
        assertEquals(1, outcome.newRecords.size)
        assertEquals("c.jpg", outcome.newRecords.single().displayName)
    }

    // ---- existing-history import ----

    @Test
    fun existingHistoryImportsEverythingDeterministically() = runTest {
        val lib = FakeLibrary()
        for (i in 1..5) lib.add(MediaCollection.IMAGES, "DCIM/Camera/x$i.jpg", name = "x$i.jpg", dateAdded = i.toLong())
        val outcome = engine(lib).scan(
            settings(mode = ScopeMode.EXISTING_HISTORY), emptyMap(), emptyMap(), FULL_SCOPE,
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
        for (i in 1..10) lib.add(MediaCollection.IMAGES, "DCIM/Camera/x$i.jpg", name = "x$i.jpg", dateAdded = i.toLong())
        // Run 1 scans every page; then we SIMULATE an interrupted run by
        // crafting a cursor that stopped at x7 (x7..x10 already imported).
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
        val alreadyKnown = (7L..10L).associate { id ->
            "images:$id@external_primary" to MediaRecord(
                identityKey = "images:$id@external_primary",
                mediaId = id,
                volume = "external_primary",
                collection = MediaCollection.IMAGES,
                source = AutoSource.CAMERA_PHOTOS,
                uri = "content://media/external_primary/images/media/$id",
                displayName = "x$id.jpg",
                sizeBytes = 1000L,
                dateAddedSeconds = id.toLong(),
                dateModifiedSeconds = id.toLong(),
                status = MediaRecordStatus.DISCOVERED,
            )
        }
        val resume = engine(lib).scan(
            settings(mode = ScopeMode.EXISTING_HISTORY), fakeCursor, alreadyKnown, FULL_SCOPE,
        )
        // Resume imports the rest: x6..x1 → 6 records.
        assertEquals(6, resume.newRecords.size)
        assertTrue(resume.cursorUpdates.values.first().fullScanCompleted)
    }

    // ---- changed media ----

    @Test
    fun changedSizeOnKnownIdentityProducesANewRevision() = runTest {
        val lib = FakeLibrary()
        val id = lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", dateAdded = 10)
        var outcome = engine(lib).scan(settings(), emptyMap(), emptyMap(), FULL_SCOPE)
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
        outcome = engine(lib).scan(settings(), emptyMap(), records, FULL_SCOPE)
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
        val outcome = engine(lib).scan(settings(), emptyMap(), mapOf(record.identityKey to record), FULL_SCOPE)
        assertEquals(listOf(record.identityKey), outcome.deletedIdentities)
    }

    @Test
    fun absentRowUnderPartialScopeIsUnreadableNotDeleted() = runTest {
        val lib = FakeLibrary(scope = MediaPermissionScope.PARTIAL)
        // A known record exists but MediaStore hides it (selected-photos
        // access): the engine must NOT claim deletion.
        val id = 1L
        val record = recordOf(id).copy(status = MediaRecordStatus.DISCOVERED)
        val outcome = engine(lib).scan(settings(), emptyMap(), mapOf(record.identityKey to record), PARTIAL_SCOPE)
        assertTrue(outcome.deletedIdentities.isEmpty())
        assertEquals(MediaRecordStatus.UNREADABLE, outcome.newRecords.single().status)
    }

    // ---- screenshot + video sources ----

    @Test
    fun screenshotsDiscoveredOnlyWhenEnabled() = runTest {
        val lib = FakeLibrary()
        lib.add(MediaCollection.IMAGES, "Pictures/Screenshots/s.png", name = "s.png", dateAdded = 5)
        // Disabled: nothing.
        var outcome = engine(lib).scan(settings(shots = false), emptyMap(), emptyMap(), FULL_SCOPE)
        assertTrue(outcome.newRecords.isEmpty())
        // Enabled with existing-history: imported and labeled SCREENSHOTS.
        outcome = engine(lib).scan(
            settings(shots = true, mode = ScopeMode.EXISTING_HISTORY),
            emptyMap(), emptyMap(), FULL_SCOPE,
        )
        assertEquals(AutoSource.SCREENSHOTS, outcome.newRecords.single().source)
    }

    @Test
    fun videosCollectedUnderCameraVideos() = runTest {
        val lib = FakeLibrary()
        lib.add(MediaCollection.VIDEOS, "DCIM/Camera/VID_1.mp4", name = "VID_1.mp4", dateAdded = 3, size = 70L * 1024 * 1024)
        val outcome = engine(lib).scan(
            settings(video = true, mode = ScopeMode.EXISTING_HISTORY),
            emptyMap(), emptyMap(), FULL_SCOPE,
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
        val outcome = engine(lib).scan(settings(shots = false), emptyMap(), emptyMap(), FULL_SCOPE)
        assertTrue(outcome.deletedIdentities.isEmpty())
    }

    // ---- P0-2: deletion semantics are honest, not false coverage claims ----

    @Test
    fun deletionBeforeStagingIsLostNotSatisfied() = runTest {
        val lib = FakeLibrary()
        val id = lib.add(MediaCollection.IMAGES, "DCIM/Camera/gone.jpg", dateAdded = 10)
        // DISCOVERED — never staged, never reached the server.
        val record = recordOf(id).copy(status = MediaRecordStatus.DISCOVERED)
        lib.remove(MediaCollection.IMAGES, id)
        val outcome = engine(lib).scan(settings(), emptyMap(), mapOf(record.identityKey to record), FULL_SCOPE)
        assertTrue("a not-yet-protected row must NOT be claimed deleted", outcome.deletedIdentities.isEmpty())
        val lost = outcome.newRecords.single()
        assertEquals(MediaRecordStatus.UNREADABLE, lost.status)
        assertTrue(lost.error!!.contains("disappeared before it was protected"))
    }

    @Test
    fun deletionAfterStagingKeepsTheUploadFromThePrivateCopy() = runTest {
        val lib = FakeLibrary()
        val id = lib.add(MediaCollection.IMAGES, "DCIM/Camera/gone.jpg", dateAdded = 10)
        // STAGED — the private copy exists and the upload must finish.
        val record = recordOf(id).copy(
            status = MediaRecordStatus.STAGED,
            queueItemId = "autoq-1",
        )
        lib.remove(MediaCollection.IMAGES, id)
        val outcome = engine(lib).scan(settings(), emptyMap(), mapOf(record.identityKey to record), FULL_SCOPE)
        assertTrue(outcome.deletedIdentities.isEmpty())
        assertTrue("STAGED rows are untouched so the staged copy still uploads", outcome.newRecords.isEmpty())
    }

    @Test
    fun deletionAfterVerifiedProtectionPreservesCoverageLocally() = runTest {
        val lib = FakeLibrary()
        val id = lib.add(MediaCollection.IMAGES, "DCIM/Camera/gone.jpg", dateAdded = 10)
        val record = recordOf(id) // PROTECTED with a receipt
        lib.remove(MediaCollection.IMAGES, id)
        val outcome = engine(lib).scan(settings(), emptyMap(), mapOf(record.identityKey to record), FULL_SCOPE)
        assertEquals(listOf(record.identityKey), outcome.deletedIdentities)
    }

    @Test
    fun protectedAndStagedRowsAreNeverUnreadableUnderPartialScope() = runTest {
        val lib = FakeLibrary(scope = MediaPermissionScope.PARTIAL)
        val id = 1L
        val protectedRec = recordOf(id)
        val outcome = engine(lib).scan(
            settings(), emptyMap(), mapOf(protectedRec.identityKey to protectedRec), PARTIAL_SCOPE,
        )
        assertTrue(outcome.deletedIdentities.isEmpty())
        assertTrue("verified/staged revisions keep their status under partial", outcome.newRecords.isEmpty())
    }

    // ---- P0-3: permission authority is PER COLLECTION ----

    @Test
    fun photosGrantedVideosDeniedNeverScansVideos() = runTest {
        val lib = FakeLibrary()
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", dateAdded = 1, size = 10)
        lib.add(MediaCollection.VIDEOS, "DCIM/Camera/v.mp4", name = "v.mp4", dateAdded = 2, size = 20)
        val outcome = engine(lib).scan(
            settings(photo = true, video = true, mode = ScopeMode.EXISTING_HISTORY),
            emptyMap(), emptyMap(),
            scope(MediaPermissionScope.FULL, MediaPermissionScope.NOT_GRANTED),
        )
        // Only the accessible IMAGES collection is imported.
        assertEquals(1, outcome.newRecords.size)
        assertEquals(MediaCollection.IMAGES, outcome.newRecords.single().collection)
    }

    @Test
    fun knownVideoHiddenByRevokedPermissionIsNeverDeclaredDeletedOrCovered() = runTest {
        val lib = FakeLibrary()
        val vid = lib.add(MediaCollection.VIDEOS, "DCIM/Camera/v.mp4", name = "v.mp4", dateAdded = 2)
        // A known video record whose row is hidden by a revoked permission.
        val videoRecord = recordOf(vid).copy(
            identityKey = "videos:$vid@external_primary",
            mediaId = vid,
            collection = MediaCollection.VIDEOS,
            source = AutoSource.CAMERA_VIDEOS,
            uri = "content://media/external_primary/video/media/$vid",
            displayName = "v.mp4",
        )
        val imgId = lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", dateAdded = 1, size = 10)
        val imgRecord = recordOf(imgId).copy(status = MediaRecordStatus.DISCOVERED)
        // Videos permission revoked; photos still FULL.
        val outcome = engine(lib).scan(
            settings(photo = true, video = true),
            emptyMap(),
            mapOf(videoRecord.identityKey to videoRecord, imgRecord.identityKey to imgRecord),
            scope(MediaPermissionScope.FULL, MediaPermissionScope.NOT_GRANTED),
        )
        // The hidden video is NOT declared deleted, NOT reclassified, NOT lost.
        assertTrue(outcome.deletedIdentities.isEmpty())
        assertTrue(outcome.newRecords.none { it.collection == MediaCollection.VIDEOS })
    }

    @Test
    fun revokedTransitionLeavesKnownRecordsUntouched() = runTest {
        val lib = FakeLibrary()
        val id = lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", dateAdded = 1)
        val record = recordOf(id).copy(status = MediaRecordStatus.PROTECTED)
        lib.remove(MediaCollection.IMAGES, id)
        // Permission revoked since the last scan: absence proves nothing.
        val outcome = engine(lib).scan(
            settings(), emptyMap(), mapOf(record.identityKey to record),
            scope(MediaPermissionScope.NOT_GRANTED, MediaPermissionScope.NOT_GRANTED),
        )
        assertTrue(outcome.deletedIdentities.isEmpty())
        assertTrue(outcome.newRecords.isEmpty())
    }

    // ---- P0-add: same-size edits are caught via date_modified ----

    @Test
    fun sameSizeButDateModifiedEditProducesANewRevision() = runTest {
        val lib = FakeLibrary()
        val id = lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", dateAdded = 10, size = 1000, modified = 500)
        var outcome = engine(lib).scan(settings(), emptyMap(), emptyMap(), FULL_SCOPE)
        assertEquals(0, outcome.newRecords.size)
        val known = MediaRecord(
            identityKey = "images:$id@external_primary",
            mediaId = id,
            volume = "external_primary",
            collection = MediaCollection.IMAGES,
            source = AutoSource.CAMERA_PHOTOS,
            uri = "content://media/external_primary/images/media/$id",
            displayName = "a.jpg",
            sizeBytes = 1000L,
            dateAddedSeconds = 10L,
            dateModifiedSeconds = 500L,
            status = MediaRecordStatus.PROTECTED,
        )
        // Same byte length, different modification time: an edit.
        lib.redate(MediaCollection.IMAGES, id, 900)
        outcome = engine(lib).scan(settings(), emptyMap(), mapOf(known.identityKey to known), FULL_SCOPE)
        assertEquals(1, outcome.newRecords.size)
        val revision = outcome.newRecords.single()
        assertEquals(MediaRecordStatus.DISCOVERED, revision.status)
        assertEquals(900L, revision.dateModifiedSeconds)
        assertNull("a new revision starts with no sha", revision.sha256)
    }

    @Test
    fun unchangedSizeAndModifiedIsNotARevision() = runTest {
        val lib = FakeLibrary()
        val id = lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", dateAdded = 10, size = 1000, modified = 500)
        val known = MediaRecord(
            identityKey = "images:$id@external_primary",
            mediaId = id,
            volume = "external_primary",
            collection = MediaCollection.IMAGES,
            source = AutoSource.CAMERA_PHOTOS,
            uri = "content://media/external_primary/images/media/$id",
            displayName = "a.jpg",
            sizeBytes = 1000L,
            dateAddedSeconds = 10L,
            dateModifiedSeconds = 500L,
            status = MediaRecordStatus.PROTECTED,
        )
        val outcome = engine(lib).scan(settings(), emptyMap(), mapOf(known.identityKey to known), FULL_SCOPE)
        assertTrue(outcome.newRecords.isEmpty())
    }

    // ---- P0-4: EXISTING_HISTORY keeps discovering FUTURE media ----

    @Test
    fun existingHistoryImportsNewerMediaAfterTheBackfillExactlyOnce() = runTest {
        val lib = FakeLibrary()
        for (i in 1..5) lib.add(MediaCollection.IMAGES, "DCIM/Camera/x$i.jpg", name = "x$i.jpg", dateAdded = i.toLong())
        val eng = engine(lib)
        // Backfill imports everything and marks the walk complete (photo and
        // video sources enabled so later inserts of either are covered).
        var outcome = eng.scan(
            settings(video = true, mode = ScopeMode.EXISTING_HISTORY), emptyMap(), emptyMap(), FULL_SCOPE,
        )
        assertEquals(5, outcome.newRecords.size)
        val cursor = outcome.cursorUpdates.values.first()
        assertTrue(cursor.fullScanCompleted)
        val known = outcome.newRecords.associateBy { it.identityKey }

        // A photo AND a video are captured later; the next scan must find
        // exactly those two, exactly once.
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/new.jpg", name = "new.jpg", dateAdded = 50)
        lib.add(MediaCollection.VIDEOS, "DCIM/Camera/newv.mp4", name = "newv.mp4", dateAdded = 51, size = 1000)
        outcome = eng.scan(
            settings(video = true, mode = ScopeMode.EXISTING_HISTORY), outcome.cursorUpdates, known, FULL_SCOPE,
        )
        assertEquals(2, outcome.newRecords.size)
        assertEquals(setOf("new.jpg", "newv.mp4"), outcome.newRecords.map { it.displayName }.toSet())
        // And a repeat scan discovers nothing again.
        val known2 = known + outcome.newRecords.associateBy { it.identityKey }
        val again = eng.scan(
            settings(video = true, mode = ScopeMode.EXISTING_HISTORY), outcome.cursorUpdates, known2, FULL_SCOPE,
        )
        assertTrue(again.newRecords.isEmpty())
    }

    @Test
    fun insertionDuringModeTransitionIsImportedExactlyOnce() = runTest {
        val lib = FakeLibrary()
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/a.jpg", name = "a.jpg", dateAdded = 10)
        val eng = engine(lib)
        // First scan in NEW_ONLY: nothing imported, boundary = newest row.
        var outcome = eng.scan(settings(mode = ScopeMode.NEW_ONLY), emptyMap(), emptyMap(), FULL_SCOPE)
        assertTrue(outcome.newRecords.isEmpty())
        // The user switches to EXISTING_HISTORY and a row is inserted between
        // the boundary capture and the backfill.
        lib.add(MediaCollection.IMAGES, "DCIM/Camera/b.jpg", name = "b.jpg", dateAdded = 20)
        outcome = eng.scan(
            settings(mode = ScopeMode.EXISTING_HISTORY), outcome.cursorUpdates, emptyMap(), FULL_SCOPE,
        )
        // The full backfill imports BOTH rows, exactly once.
        assertEquals(2, outcome.newRecords.size)
        assertEquals(setOf("b.jpg", "a.jpg"), outcome.newRecords.map { it.displayName }.toSet())
    }

    // ---- P1: per-page durable commit boundary ----

    @Test
    fun eachCompletedPageCommitsItsCursorAndRecords() = runTest {
        val lib = FakeLibrary()
        for (i in 1..5) lib.add(MediaCollection.IMAGES, "DCIM/Camera/x$i.jpg", name = "x$i.jpg", dateAdded = i.toLong())
        val commits = mutableListOf<MediaDiscoveryEngine.PageCommit>()
        val outcome = engine(lib).scan(
            settings(mode = ScopeMode.EXISTING_HISTORY), emptyMap(), emptyMap(), FULL_SCOPE,
            pageSize = 2,
            onPage = { commits += it },
        )
        // 5 rows / page size 2 → 3 pages (2+2+1) → 3 completed-page commits.
        assertEquals(3, commits.size)
        assertEquals(5, outcome.newRecords.size)
        // Every page's records are delivered with its commit, in order.
        assertEquals(2, commits[0].newRecords.size)
        assertEquals(2, commits[1].newRecords.size)
        assertEquals(1, commits[2].newRecords.size)
        assertEquals(5, commits.sumOf { it.newRecords.size })
        // The final cursor is durable and marks the walk complete.
        assertTrue(commits.last().cursor.fullScanCompleted)
    }

    @Test
    fun interruptedAfterACompletedPageResumesWithoutSkippingFiles() = runTest {
        val lib = FakeLibrary()
        for (i in 1..6) lib.add(MediaCollection.IMAGES, "DCIM/Camera/x$i.jpg", name = "x$i.jpg", dateAdded = i.toLong())
        val eng = engine(lib)
        // Run 1: page 1 (rows 6,5) completes; page 2 then FAILS.
        val failing = object : MediaCursorLibrary by lib {
            private var page = 0
            override suspend fun queryNewestFirst(
                collection: MediaCollection,
                volume: String,
                before: PageKey?,
                limit: Int,
            ): List<MediaRow> {
                page += 1
                if (page == 2) throw IllegalStateException("page failed")
                return lib.queryNewestFirst(collection, volume, before, limit)
            }
        }
        val commits = mutableListOf<MediaDiscoveryEngine.PageCommit>()
        val interrupted = MediaDiscoveryEngine(failing).scan(
            settings(mode = ScopeMode.EXISTING_HISTORY), emptyMap(), emptyMap(), FULL_SCOPE,
            pageSize = 2,
            onPage = { commits += it },
        )
        assertTrue("page 2 failed", interrupted.interrupted)
        // Exactly ONE completed page was committed: rows 6 and 5.
        assertEquals(1, commits.size)
        assertEquals(2, commits[0].newRecords.size)
        assertEquals("x6.jpg", commits[0].newRecords[0].displayName)
        // The committed cursor points AFTER the completed page (at row 5).
        val resumedFrom = commits[0].cursor
        assertEquals(5L, resumedFrom.watermarkDateAdded)
        assertEquals(5L, resumedFrom.watermarkId)

        // Run 2 resumes from the committed cursor and must see rows 4..1 —
        // never re-importing 6/5, never skipping anything.
        val resumed = eng.scan(
            settings(mode = ScopeMode.EXISTING_HISTORY),
            mapOf(MediaDiscoveryEngine.CursorKey(MediaCollection.IMAGES, "external_primary") to resumedFrom),
            commits[0].newRecords.associateBy { it.identityKey },
            FULL_SCOPE,
            pageSize = 2,
        )
        assertEquals(listOf("x4.jpg", "x3.jpg", "x2.jpg", "x1.jpg"), resumed.newRecords.map { it.displayName })
        assertTrue(resumed.cursorUpdates.values.first().fullScanCompleted)
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