package app.lamasync.companion.media

import app.lamasync.companion.data.UploadPolicy
import app.lamasync.companion.data.UploadQueueSnapshot
import app.lamasync.companion.data.MemoryQueueStorage
import app.lamasync.companion.data.UploadQueueStore
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Durable auto-protect state: persistence, atomic page commits, safety. */
class MediaProtectionStoreTest {

    private fun store(bytes: MemoryRecordStorage = MemoryRecordStorage()) = MediaProtectionStore(bytes)

    @Test
    fun persistsAcrossStoreInstancesLikeProcessDeath() {
        val bytes = MemoryRecordStorage()
        store(bytes).updateSettings { it.copy(cameraPhotosEnabled = true) }
        val reloaded = store(bytes).load().settings
        assertTrue(reloaded.cameraPhotosEnabled)
    }

    @Test
    fun corruptedStateFailsSafeToDefaults() {
        val bytes = MemoryRecordStorage()
        bytes.write("media_protection_v1", "{not json")
        val snap = store(bytes).load()
        assertFalse(snap.settings.cameraPhotosEnabled)
        assertTrue(snap.records.isEmpty())
    }

    @Test
    fun commitScanPageIsAtomic() {
        val s = store()
        val record = MediaRecord(
            identityKey = "images:1@external_primary",
            mediaId = 1L,
            volume = "external_primary",
            collection = MediaCollection.IMAGES,
            source = AutoSource.CAMERA_PHOTOS,
            uri = "content://x",
            displayName = "a.jpg",
            sizeBytes = 10L,
            status = MediaRecordStatus.DISCOVERED,
        )
        val cursor = MediaCursorState(
            collection = MediaCollection.IMAGES,
            volume = "external_primary",
            scopeMode = ScopeMode.NEW_ONLY,
            watermarkDateAdded = 7L,
            watermarkId = 7L,
        )
        val settings = AutoProtectSettings(cameraPhotosEnabled = true).copy(lastScanStatus = ScanStatus.OK)
        s.updateSettings { it.copy(cameraPhotosEnabled = true) }
        s.commitScanPage(settings, listOf(cursor), listOf(record))

        val snap = s.load()
        assertEquals(1, snap.records.size)
        assertEquals(MediaRecordStatus.DISCOVERED, snap.records.single().status)
        val c = snap.cursors.single()
        assertEquals(7L, c.watermarkDateAdded)
        assertTrue(snap.settings.cameraPhotosEnabled)
    }

    @Test
    fun staleScanCommitPreservesLatestUserConfiguration() {
        val s = store()
        val staleAtScanStart = AutoProtectSettings(
            cameraPhotosEnabled = true,
            unmeteredOnly = false,
            updatedAtEpochMillis = 10L,
        )
        s.updateSettings {
            it.copy(
                cameraPhotosEnabled = false,
                cameraVideosEnabled = true,
                unmeteredOnly = true,
                updatedAtEpochMillis = 20L,
            )
        }

        s.commitScanPage(
            staleAtScanStart.copy(
                lastScanAtEpochMillis = 30L,
                lastScanStatus = ScanStatus.INTERRUPTED,
                updatedAtEpochMillis = 30L,
            ),
            emptyList(),
            emptyList(),
        )

        val settings = s.load().settings
        assertFalse(settings.cameraPhotosEnabled)
        assertTrue(settings.cameraVideosEnabled)
        assertTrue(settings.unmeteredOnly)
        assertEquals(30L, settings.lastScanAtEpochMillis)
        assertEquals(ScanStatus.INTERRUPTED, settings.lastScanStatus)
    }

    @Test
    fun updateRecordsReplacesByIdentity() {
        val s = store()
        val a = record(1L, "a.jpg")
        s.updateRecords(listOf(a))
        s.updateRecords(listOf(a.copy(status = MediaRecordStatus.PROTECTED, receiptPath = "p/a.jpg")))
        assertEquals(1, s.load().records.size)
        assertEquals(MediaRecordStatus.PROTECTED, s.load().records.single().status)
    }

    @Test
    fun cursorForFindsByCollectionAndVolume() {
        val s = store()
        s.updateCursors(
            listOf(
                MediaCursorState(MediaCollection.IMAGES, "external_primary"),
                MediaCursorState(MediaCollection.VIDEOS, "external_primary"),
            ),
        )
        assertEquals(
            MediaCollection.VIDEOS,
            s.cursorFor(MediaCollection.VIDEOS, "external_primary")?.collection,
        )
        assertEquals(null, s.cursorFor(MediaCollection.IMAGES, "external_secondary_x"))
    }

    private fun record(id: Long, name: String) = MediaRecord(
        identityKey = "images:$id@external_primary",
        mediaId = id,
        volume = "external_primary",
        collection = MediaCollection.IMAGES,
        source = AutoSource.CAMERA_PHOTOS,
        uri = "content://x/$id",
        displayName = name,
        sizeBytes = 10L,
        dateAddedSeconds = id,
    )
}

/** Stage-2 queue fields must not break stage-1 persister snapshots. */
class QueueSnapshotBackwardCompatTest {

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Test
    fun legacyQueueJsonWithoutStage2FieldsStillDecodes() {
        val legacy = """{"items":[{"id":"i1","origin":"https://fleet.example.com","hostId":"mob-1","sourceUri":"content://a","displayName":"d.pdf","destinationId":"mdst-1","destinationRelPath":"Mobile/mob-1/Inbox","idempotencyKey":"up-1","status":"PENDING","createdAtEpochMillis":1,"updatedAtEpochMillis":2}]}"""
        val snap = json.decodeFromString(UploadQueueSnapshot.serializer(), legacy)
        val item = snap.items.single()
        assertEquals("d.pdf", item.displayName)
        // Stage-2 defaults apply:
        assertEquals(0, item.autoNameAttempt)
        assertEquals(null, item.mediaIdentity)
        assertEquals(null, item.sourceLabel)
    }

    @Test
    fun policyJsonWithoutChargingDefaultsToFalse() {
        val legacy = """{"unmeteredOnly":true}"""
        val policy = json.decodeFromString(UploadPolicy.serializer(), legacy)
        assertEquals(true, policy.unmeteredOnly)
        assertEquals(false, policy.chargingOnly)
    }

    @Test
    fun queueStillSurvivesWithTheExtendedSharedPrefsStorage() {
        // Sanity: the existing store contract is unchanged by stage 2.
        val storage = MemoryQueueStorage()
        val store = UploadQueueStore(storage)
        assertTrue(store.load().items.isEmpty())
    }
}
