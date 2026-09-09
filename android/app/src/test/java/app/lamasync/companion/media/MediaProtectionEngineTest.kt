package app.lamasync.companion.media

import app.lamasync.companion.data.MemoryQueueStorage
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.QueueStorage
import app.lamasync.companion.data.UploadQueueItem
import app.lamasync.companion.data.UploadQueueStore
import app.lamasync.companion.data.UploadReceipt
import app.lamasync.companion.data.UploadStatus
import app.lamasync.companion.network.MobileUploadDestinationDto
import java.io.File
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** In-memory storage for the record store (JVM). */
class MemoryRecordStorage : QueueStorage {
    private val map = mutableMapOf<String, String>()
    override fun read(key: String): String? = map[key]
    override fun write(key: String, value: String) {
        map[key] = value
    }

    fun dump(): MutableMap<String, String> = map
}

/** Controllable stager. */
class FakeByteStager : ByteStager {
    var outcome: ByteStager.StageOutcome = ByteStager.StageOutcome.Staged(
        ByteStager.Ok("stage-r.jpg", 1000L, "a".repeat(64)),
    )
    val stagedUris = mutableListOf<String>()

    override suspend fun stage(uri: String): ByteStager.StageOutcome {
        stagedUris += uri
        return outcome
    }
}

/** Staging + enqueue: idempotent, deterministic, honest on failure. */
class MediaProtectionEngineTest {

    private fun record(
        id: Long = 1L,
        status: MediaRecordStatus = MediaRecordStatus.DISCOVERED,
        size: Long? = 1000L,
    ) = MediaRecord(
        identityKey = "images:$id@external_primary",
        mediaId = id,
        volume = "external_primary",
        collection = MediaCollection.IMAGES,
        source = AutoSource.CAMERA_PHOTOS,
        uri = "content://media/external_primary/images/media/$id",
        displayName = "IMG_$id.jpg",
        sizeBytes = size,
        relativePath = "DCIM/Camera",
        dateAddedSeconds = id,
        status = status,
        discoveredAtEpochMillis = 1L,
        updatedAtEpochMillis = 1L,
    )

    private fun engine(
        recordStore: MediaProtectionStore,
        queueStore: UploadQueueStore,
        stager: ByteStager,
    ) = MediaProtectionEngine(queueStore, recordStore, stager) { 1_000L }

    private fun cameraDestination(id: String = "mdst-camera") = MobileUploadDestinationDto(
        id = id,
        label = "Camera",
        relPath = "Mobile/mob-host-1/Camera",
        createdAt = 1L,
    )

    private fun settings(destId: String? = null) = AutoProtectSettings(
        cameraPhotosEnabled = true,
        cameraDestinationId = destId,
        cameraDestinationLabel = if (destId != null) "Camera" else null,
        cameraDestinationRelPath = if (destId != null) "Mobile/mob-host-1/Camera" else null,
    )

    private val cameraDestinations = listOf(cameraDestination())

    @Test
    fun enqueuesOneDurableItemPerStagedRecord() = runTest {
        val queue = UploadQueueStore(MemoryQueueStorage())
        val store = MediaProtectionStore(MemoryRecordStorage())
        store.updateRecords(listOf(record(1L)))

        val summary = engine(store, queue, FakeByteStager()).protectPending(
            settings(),
            "https://fleet.example.com",
            "mob-host-1",
            DestinationsResult.Ok(cameraDestinations),
        )

        assertEquals(1, summary.stagedCount)
        val items = queue.load().items
        assertEquals(1, items.size)
        val item = items.single()
        assertEquals("mob-host-1", item.hostId)
        assertEquals("https://fleet.example.com", item.origin)
        assertEquals("mdst-camera", item.destinationId)
        assertEquals("images:1@external_primary", item.mediaIdentity)
        assertEquals("Camera photos", item.sourceLabel)
        assertTrue(item.staged)
        // Record advanced to STAGED with a deterministic queue id.
        val rec = store.recordFor("images:1@external_primary")!!
        assertEquals(MediaRecordStatus.STAGED, rec.status)
        assertEquals(item.id, rec.queueItemId)
    }

    @Test
    fun duplicateScanDoesNotDoubleQueue() = runTest {
        val queue = UploadQueueStore(MemoryQueueStorage())
        val store = MediaProtectionStore(MemoryRecordStorage())
        store.updateRecords(listOf(record(1L)))
        val engine = engine(store, queue, FakeByteStager())

        engine.protectPending(settings(), "https://fleet.example.com", "mob-host-1", DestinationsResult.Ok(cameraDestinations))
        val second = engine.protectPending(
            settings("mdst-camera"),
            "https://fleet.example.com",
            "mob-host-1",
            DestinationsResult.Ok(cameraDestinations),
        )
        assertEquals("no new queue item on a duplicate scan", 0, second.stagedCount)
        assertEquals(1, queue.load().items.size)
    }

    @Test
    fun doneQueueItemLinksReceiptIntoTheRegistry() = runTest {
        val queue = UploadQueueStore(MemoryQueueStorage())
        val store = MediaProtectionStore(MemoryRecordStorage())
        store.updateRecords(listOf(record(1L)))
        val item = UploadQueueItem(
            id = AutoQueueKeys.queueItemId("images:1@external_primary", "a".repeat(64)),
            origin = "https://fleet.example.com",
            hostId = "mob-host-1",
            sourceUri = "content://media/external_primary/images/media/1",
            displayName = "IMG_1.jpg",
            destinationId = "mdst-camera",
            destinationRelPath = "Mobile/mob-host-1/Camera",
            idempotencyKey = AutoQueueKeys.idempotencyKey("images:1@external_primary", "a".repeat(64)),
            staged = true,
            mediaIdentity = "images:1@external_primary",
            status = UploadStatus.DONE,
            receipt = UploadReceipt(
                uploadId = "mup-1",
                fileName = "IMG_1.jpg",
                finalRelPath = "Mobile/mob-host-1/Camera/IMG_1.jpg",
                browsePath = "Mobile/mob-host-1/Camera/IMG_1.jpg",
                sizeBytes = 1000L,
                sha256 = "a".repeat(64),
                finalizedAtEpochMillis = 5_000L,
            ),
            createdAtEpochMillis = 1L,
            updatedAtEpochMillis = 5_000L,
        )
        queue.add(item)

        engine(store, queue, FakeByteStager()).protectPending(
            settings("mdst-camera"),
            "https://fleet.example.com",
            "mob-host-1",
            DestinationsResult.Ok(cameraDestinations),
        )
        val rec = store.recordFor("images:1@external_primary")!!
        assertEquals(MediaRecordStatus.PROTECTED, rec.status)
        assertEquals("Mobile/mob-host-1/Camera/IMG_1.jpg", rec.receiptPath)
        assertEquals(5_000L, rec.protectedAtEpochMillis)
    }

    @Test
    fun stagingFailureMarksTheRecordUnreadableWithActionableError() = runTest {
        val queue = UploadQueueStore(MemoryQueueStorage())
        val store = MediaProtectionStore(MemoryRecordStorage())
        store.updateRecords(listOf(record(1L)))
        val stager = FakeByteStager().apply {
            outcome = ByteStager.StageOutcome.Failed(ByteStager.FailReason.UNREADABLE, "row gone")
        }
        val summary = engine(store, queue, stager).protectPending(
            settings("mdst-camera"),
            "https://fleet.example.com",
            "mob-host-1",
            DestinationsResult.Ok(cameraDestinations),
        )
        assertEquals(1, summary.unreadableCount)
        assertEquals(0, summary.stagedCount)
        assertEquals(MediaRecordStatus.UNREADABLE, store.recordFor("images:1@external_primary")!!.status)
        assertTrue(queue.load().items.isEmpty())
        assertTrue(store.recordFor("images:1@external_primary")!!.error!!.contains("no longer readable"))
    }

    @Test
    fun missingCameraDestinationSkipsStagingWithHonestState() = runTest {
        val queue = UploadQueueStore(MemoryQueueStorage())
        val store = MediaProtectionStore(MemoryRecordStorage())
        store.updateRecords(listOf(record(1L)))
        val stager = FakeByteStager()
        val summary = engine(store, queue, stager).protectPending(
            settings(),
            "https://fleet.example.com",
            "mob-host-1",
            DestinationsResult.Ok(listOf(MobileUploadDestinationDto(id = "mdst-inbox", label = "Inbox", relPath = "Mobile/mob-host-1/Inbox"))), // no Camera
        )
        assertEquals(0, summary.stagedCount)
        assertEquals(0, summary.unreadableCount)
        assertEquals(DestinationState.MISSING, summary.destinationState)
        assertTrue("no bytes were read without a destination", stager.stagedUris.isEmpty())
    }

    @Test
    fun networkFailureFallsBackToCachedDestination() = runTest {
        val queue = UploadQueueStore(MemoryQueueStorage())
        val store = MediaProtectionStore(MemoryRecordStorage())
        store.updateRecords(listOf(record(1L)))
        val engine = engine(store, queue, FakeByteStager())
        val summary = engine.protectPending(
            settings("mdst-camera"),
            "https://fleet.example.com",
            "mob-host-1",
            DestinationsResult.NetworkFailure("unreachable"),
        )
        assertEquals(DestinationState.CACHED, summary.destinationState)
        assertEquals(1, summary.stagedCount)
        // The cached destination persisted into settings.
        assertEquals("mdst-camera", store.load().settings.cameraDestinationId)
    }

    @Test
    fun networkFailureWithoutCacheIsUnreachable() = runTest {
        val queue = UploadQueueStore(MemoryQueueStorage())
        val store = MediaProtectionStore(MemoryRecordStorage())
        store.updateRecords(listOf(record(1L)))
        val summary = engine(store, queue, FakeByteStager()).protectPending(
            settings(),
            "https://fleet.example.com",
            "mob-host-1",
            DestinationsResult.NetworkFailure("unreachable"),
        )
        assertEquals(DestinationState.UNREACHABLE, summary.destinationState)
        assertEquals(0, summary.stagedCount)
    }

    @Test
    fun authFailureClassifiesAsRevoked() = runTest {
        val summary = engine(
            MediaProtectionStore(MemoryRecordStorage()),
            UploadQueueStore(MemoryQueueStorage()),
            FakeByteStager(),
        ).protectPending(
            settings(),
            "https://fleet.example.com",
            "mob-host-1",
            DestinationsResult.AuthFailure("revoked"),
        )
        assertEquals(DestinationState.REVOKED, summary.destinationState)
    }

    @Test
    fun deterministicQueueIdsDifferPerRevision() {
        val identity = "images:1@external_primary"
        val shaA = "a".repeat(64)
        val shaB = "b".repeat(64)
        assertFalse(AutoQueueKeys.queueItemId(identity, shaA) == AutoQueueKeys.queueItemId(identity, shaB))
        assertEquals(AutoQueueKeys.queueItemId(identity, shaA), AutoQueueKeys.queueItemId(identity, shaA))
        assertNotNull(AutoQueueKeys.queueItemId(identity, shaA))
        assertTrue(AutoQueueKeys.idempotencyKey(identity, shaA).length <= 128)
    }
}

/** Destination matching (server-approved Camera) + waiting reasons. */
class CameraDestinationResolverTest {

    @Test
    fun picksTheCameraDestinationDeterministically() {
        val found = CameraDestinationResolver.pickCamera(
            listOf(
                MobileUploadDestinationDto(id = "a", label = "Inbox", relPath = "Mobile/x/Inbox", createdAt = 1L),
                MobileUploadDestinationDto(id = "b", label = "Camera", relPath = "Mobile/x/Camera", createdAt = 2L),
            ),
        )
        assertEquals("b", found?.id)
    }

    @Test
    fun matchesCaMeRaCaseInsensitiveAndRelPathSuffix() {
        val bySlug = CameraDestinationResolver.pickCamera(
            listOf(MobileUploadDestinationDto(id = "c", label = "camera", relPath = "Mobile/x/whatever", createdAt = 3L)),
        )
        assertEquals("c", bySlug?.id)
        val byPath = CameraDestinationResolver.pickCamera(
            listOf(MobileUploadDestinationDto(id = "d", label = "Foto", relPath = "Mobile/x/Camera", createdAt = 1L)),
        )
        assertEquals("d", byPath?.id)
    }

    @Test
    fun missingCameraIsNull() {
        assertNull(
            CameraDestinationResolver.pickCamera(
                listOf(MobileUploadDestinationDto(id = "a", label = "Inbox", relPath = "Mobile/x/Inbox")),
            ),
        )
    }

    @Test
    fun slugifyMirrorsServerNormalization() {
        assertEquals("camera", CameraDestinationResolver.slugify("Camera"))
        assertEquals("inbox", CameraDestinationResolver.slugify("  Inbox "))
        assertEquals("my-photo-inbox", CameraDestinationResolver.slugify("My Photo  Inbox"))
    }
}

/** Waiting-reason priority — honest, actionable ordering. */
class AutoWaitingReasonsTest {

    private fun derive(
        registration: Boolean = true,
        native: Boolean = true,
        scope: MediaPermissionScope = MediaPermissionScope.FULL,
        dest: DestinationState = DestinationState.READY,
        pending: Long = 0L,
    ) = AutoWaitingReasons.derive(registration, native, scope, dest, pending)

    @Test
    fun healthyPipelineIsNone() {
        assertEquals(AutoWaitReason.NONE, derive())
    }

    @Test
    fun unpairedAndCredentialLossComeFirst() {
        assertEquals(AutoWaitReason.UNPAIRED, derive(registration = false))
        assertEquals(AutoWaitReason.CREDENTIAL_LOST, derive(native = false))
    }

    @Test
    fun deniedPermissionBeatsDestinationProblems() {
        assertEquals(
            AutoWaitReason.PERMISSION_DENIED,
            derive(scope = MediaPermissionScope.NOT_GRANTED, dest = DestinationState.MISSING),
        )
    }

    @Test
    fun destinationIssuesOrderedByActionability() {
        assertEquals(AutoWaitReason.REVOKED, derive(dest = DestinationState.REVOKED))
        assertEquals(AutoWaitReason.NO_CAMERA_DESTINATION, derive(dest = DestinationState.MISSING))
        assertEquals(AutoWaitReason.NETWORK, derive(dest = DestinationState.UNREACHABLE))
    }

    @Test
    fun partialAccessIsInformationalNotBlocking() {
        assertEquals(AutoWaitReason.PERMISSION_PARTIAL, derive(scope = MediaPermissionScope.PARTIAL))
    }

    @Test
    fun everyReasonHasHumanText() {
        for (reason in AutoWaitReason.entries.filter { it != AutoWaitReason.NONE }) {
            assertNotNull("$reason must have guidance", AutoWaitingReasons.human(reason, 3L))
        }
    }
}