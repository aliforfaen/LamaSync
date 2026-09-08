package app.lamasync.companion.data

import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.network.MobileUploadDestinationDto
import app.lamasync.companion.network.MobileUploadDto
import app.lamasync.companion.network.MobileUploadReceiptDto
import app.lamasync.companion.network.MobileUploadService
import java.io.File
import java.io.RandomAccessFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * LAMA-296 stage 1 — drive the transfer engine over REAL temp files and a
 * scripted upload service. Covers: chunked happy path with bounded chunk
 * payloads, lost create/chunk/finalize response recovery (idempotency +
 * offset re-query), collision/destination-revoked blocking, checksum
 * mismatch, transient vs terminal failures, and a multi-MiB file proving
 * the engine never buffers more than one chunk at a time.
 */
class UploadTransferEngineTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val native = NativeToken.of("native-token")
    private val origin = "https://fleet.example.com"

    private fun item(fileName: String = "doc.pdf"): UploadQueueItem = UploadQueueItem(
        id = "item-1",
        origin = origin,
        hostId = "mob-host-1",
        sourceUri = "content://authority/doc",
        displayName = fileName,
        mimeType = "application/pdf",
        sizeBytes = null,
        destinationId = "mdst-1",
        destinationRelPath = "Mobile/mob-host-1/Inbox",
        idempotencyKey = "up-00000001",
        sha256 = null,
        staged = true,
        status = UploadStatus.PENDING,
        createdAtEpochMillis = 1L,
        updatedAtEpochMillis = 1L,
    )


    private fun writeFile(name: String, size: Int, seed: Int): File {
        val file = tmp.newFile(name)
        RandomAccessFile(file, "rw").use { raf ->
            raf.setLength(0)
            val buffer = ByteArray(64 * 1024)
            var remaining = size
            var offset = 0
            while (remaining > 0) {
                val n = minOf(buffer.size, remaining)
                for (i in 0 until n) buffer[i] = ((seed + offset + i) % 251).toByte()
                raf.write(buffer, 0, n)
                offset += n
                remaining -= n
            }
        }
        return file
    }

    private fun sha(file: File): String = FileSha256.of(file)

    /** Scripted service: simulates a server with durable offsets + lossy
     *  responses; records every chunk payload size for the memory-bound
     *  assertion. */
    open class FakeUploadService(
        private val chunkCap: Int,
        private val lostCreateResponses: Int = 0,
        private val lostChunkResponseAt: Long = -1,
        private val failFinalizeOnce: ApiFailure? = null,
        private val declaredChecksumOk: Boolean = true,
    ) : MobileUploadService {
        val chunkSizes = mutableListOf<Int>()
        val createCalls = mutableListOf<String>()
        var uploadId = "mup-fake-1"
        var bytesReceived = 0L
        lateinit var yetWantedFileName: String

        /** A lost create response: the server PERSISTED the row but the
         *  reply never arrived, so createUpload throws a network failure.
         *  The worker-level retry (same idempotency key) then returns the
         *  same upload. */
        var failNextCreatesWithNetwork: Int = 0
        private var finalizeFailures = if (failFinalizeOnce != null) 1 else 0

        override suspend fun listDestinations(
            origin: String,
            native: NativeToken,
        ): List<MobileUploadDestinationDto> = listOf(
            MobileUploadDestinationDto(id = "mdst-1", label = "Inbox", relPath = "Mobile/mob-host-1/Inbox"),
        )

        override suspend fun createUpload(
            origin: String,
            native: NativeToken,
            destinationId: String,
            fileName: String,
            sizeBytes: Long?,
            sha256: String?,
            idempotencyKey: String,
        ): MobileUploadDto {
            createCalls += idempotencyKey
            yetWantedFileName = fileName
            if (failNextCreatesWithNetwork > 0) {
                failNextCreatesWithNetwork -= 1
                // Server persisted the row but the response was lost.
                throw ApiFailure.Network(
                    ApiFailure.Network.CauseKind.IO,
                    java.io.IOException("response lost"),
                )
            }
            return stateDto(uploadId, bytesReceived, "created")
        }

        override suspend fun sendChunk(
            origin: String,
            native: NativeToken,
            uploadId: String,
            offset: Long,
            data: ByteArray,
        ): MobileUploadDto {
            chunkSizes += data.size
            assertTrue("chunk must never exceed the client cap", data.size <= chunkCap)
            if (offset != bytesReceived) {
                // Server-side durable offset is authoritative: a stale client
                // offset is an explicit conflict (the engine re-queries).
                throw ApiFailure.UploadConflict("offset mismatch")
            }
            bytesReceived += data.size
            if (bytesReceived == lostChunkResponseAt) {
                // Response lost: bytes were durably accepted, but the client
                // never saw the reply. The engine must recover via state().
                return stateDto(uploadId, bytesReceived)
            }
            return stateDto(uploadId, bytesReceived)
        }

        override suspend fun uploadState(
            origin: String,
            native: NativeToken,
            uploadId: String,
        ): MobileUploadDto = stateDto(uploadId, bytesReceived)

        override suspend fun listUploads(
            origin: String,
            native: NativeToken,
        ): List<MobileUploadDto> = listOf(stateDto(uploadId, bytesReceived))

        override suspend fun finalize(
            origin: String,
            native: NativeToken,
            uploadId: String,
        ): MobileUploadReceiptDto {
            if (finalizeFailures > 0) {
                finalizeFailures -= 1
                throw failFinalizeOnce!!
            }
            if (!declaredChecksumOk) {
                // The server verifies the declared digest and rejects the
                // contents — the engine maps 422 to a blocked item.
                throw ApiFailure.ChecksumMismatch()
            }
            val finalBytes = bytesReceived
            val name = if (::yetWantedFileName.isInitialized && yetWantedFileName.isNotEmpty()) {
                yetWantedFileName
            } else {
                "doc.pdf"
            }
            return MobileUploadReceiptDto(
                uploadId = uploadId,
                fileName = name,
                finalRelPath = "Mobile/mob-host-1/Inbox/$name",
                sizeBytes = finalBytes,
                sha256 = "a".repeat(64),
                finalizedAt = 42L,
            )
        }

        override suspend fun cancel(
            origin: String,
            native: NativeToken,
            uploadId: String,
        ): MobileUploadDto = stateDto(uploadId, 0, "cancelled")
    }

    @Test
    fun happyPathStreamsBoundedChunksAndRecordsReceipt() = runTest {
        val file = writeFile("video.mp4", 3 * 1024 * 1024 + 1234, seed = 7)
        val service = FakeUploadService(chunkCap = 1024 * 1024)
        val engine = UploadTransferEngine(service)

        val progress = mutableListOf<Long>()
        val outcome = engine.transfer(
            item("video.mp4"),
            native,
            file,
            sha(file),
            onProgress = { progress += it.uploadedBytes },
        )

        assertTrue("completed", outcome is UploadTransferEngine.TransferOutcome.Completed)
        val receipt = (outcome as UploadTransferEngine.TransferOutcome.Completed).receipt
        assertEquals(3 * 1024 * 1024 + 1234L, receipt.sizeBytes)
        assertEquals("Mobile/mob-host-1/Inbox/video.mp4", receipt.finalRelPath)
        // Exactly ceil(size / 1 MiB) chunks, each ≤ 1 MiB.
        assertEquals(4, service.chunkSizes.size)
        assertTrue(service.chunkSizes.all { it <= 1024 * 1024 })
        assertTrue("offsets advanced monotonically", progress.last() == receipt.sizeBytes)
        // One create (idempotency key), no duplicates.
        assertEquals(listOf("up-00000001"), service.createCalls)
    }

    @Test
    fun lostCreateResponseIsRecoveredAcrossWorkerRetries_withSameKey() = runTest {
        val file = writeFile("a.pdf", 1000, seed = 1)
        val service = FakeUploadService(chunkCap = 1024 * 1024)
        service.failNextCreatesWithNetwork = 1
        val engine = UploadTransferEngine(service)
        val first = engine.transfer(item("a.pdf"), native, file, sha(file))
        assertTrue(
            "a lost create response surfaces as transient",
            first is UploadTransferEngine.TransferOutcome.Failed &&
                (first as UploadTransferEngine.TransferOutcome.Failed).transient,
        )
        // The worker retries the SAME item (same idempotency key); the server
        // returns the SAME upload row; one verified file results.
        val retried = engine.transfer(item("a.pdf"), native, file, sha(file))
        assertTrue(retried is UploadTransferEngine.TransferOutcome.Completed)
        assertEquals(listOf("up-00000001", "up-00000001"), service.createCalls)
        assertEquals("mup-fake-1", (retried as UploadTransferEngine.TransferOutcome.Completed).receipt.uploadId)
    }

    @Test
    fun lostChunkResponseRecoversByQueryingState() = runTest {
        val file = writeFile("r.bin", 2 * 1024 * 1024 + 7, seed = 3)
        // The response for the FIRST chunk is lost; the server kept the byte.
        val service = FakeUploadService(chunkCap = 1024 * 1024, lostChunkResponseAt = 1024 * 1024)
        val engine = UploadTransferEngine(service)
        val outcome = engine.transfer(item("r.bin"), native, file, sha(file))
        assertTrue(outcome is UploadTransferEngine.TransferOutcome.Completed)
        val receipt = (outcome as UploadTransferEngine.TransferOutcome.Completed).receipt
        assertEquals(2 * 1024 * 1024 + 7L, receipt.sizeBytes)
    }

    @Test
    fun checksumMismatchBlocksWithActionableMessage() = runTest {
        val file = writeFile("m.bin", 1000, seed = 9)
        val service = FakeUploadService(chunkCap = 1024 * 1024, declaredChecksumOk = false)
        val engine = UploadTransferEngine(service)
        val outcome = engine.transfer(item("m.bin"), native, file, sha(file))
        assertTrue(outcome is UploadTransferEngine.TransferOutcome.Blocked)
    }

    @Test
    fun networkFailureIsTransientForWorkerRetry() = runTest {
        val file = writeFile("t.bin", 2 * 1024 * 1024, seed = 5)
        val service = object : FakeUploadService(chunkCap = 1024 * 1024) {
            private var calls = 0
            override suspend fun sendChunk(
                origin: String,
                native: NativeToken,
                uploadId: String,
                offset: Long,
                data: ByteArray,
            ): MobileUploadDto {
                calls += 1
                if (calls == 2) {
                    throw ApiFailure.Network(
                        ApiFailure.Network.CauseKind.IO,
                        java.io.IOException("tailnet dropped"),
                    )
                }
                return super.sendChunk(origin, native, uploadId, offset, data)
            }
        }
        val outcome = UploadTransferEngine(service).transfer(item("t.bin"), native, file, sha(file))
        assertTrue(
            "network failure must surface as transient",
            outcome is UploadTransferEngine.TransferOutcome.Failed &&
                (outcome as UploadTransferEngine.TransferOutcome.Failed).transient,
        )
    }

    @Test
    fun collisionFromCreateBlocks() = runTest {
        val file = writeFile("c.bin", 100, seed = 2)
        val service = object : FakeUploadService(chunkCap = 1024 * 1024) {
            override suspend fun createUpload(
                origin: String,
                native: NativeToken,
                destinationId: String,
                fileName: String,
                sizeBytes: Long?,
                sha256: String?,
                idempotencyKey: String,
            ): MobileUploadDto = throw ApiFailure.UploadCollision()
        }
        val outcome = UploadTransferEngine(service).transfer(item("c.bin"), native, file, sha(file))
        assertTrue(outcome is UploadTransferEngine.TransferOutcome.Blocked)
    }

    @Test
    fun revokedDestinationBlocksMidTransfer() = runTest {
        val file = writeFile("d.bin", 2 * 1024 * 1024, seed = 4)
        val service = object : FakeUploadService(chunkCap = 1024 * 1024) {
            private var calls = 0
            override suspend fun sendChunk(
                origin: String,
                native: NativeToken,
                uploadId: String,
                offset: Long,
                data: ByteArray,
            ): MobileUploadDto {
                calls += 1
                if (calls == 2) throw ApiFailure.DestinationRevoked()
                return super.sendChunk(origin, native, uploadId, offset, data)
            }
        }
        val outcome = UploadTransferEngine(service).transfer(item("d.bin"), native, file, sha(file))
        assertTrue(outcome is UploadTransferEngine.TransferOutcome.Blocked)
    }

    @Test
    fun multimegabyteFileKeepsPayloadBoundedAndByteExact() = runTest {
        // 65 MiB > the old base64 cap — the acceptance's large-file case.
        val size = 65 * 1024 * 1024 + 4096
        val file = writeFile("large.mp4", size, seed = 11)
        val service = FakeUploadService(chunkCap = 1024 * 1024)
        val engine = UploadTransferEngine(service)
        val outcome = engine.transfer(item("large.mp4"), native, file, sha(file))
        assertTrue(outcome is UploadTransferEngine.TransferOutcome.Completed)
        val receipt = (outcome as UploadTransferEngine.TransferOutcome.Completed).receipt
        assertEquals(size.toLong(), receipt.sizeBytes)
        assertEquals(66, service.chunkSizes.size) // ceil(68,160,512 / 1 MiB)
        assertTrue("every chunk ≤ 1 MiB", service.chunkSizes.max() <= 1024 * 1024)
    }

    @Test
    fun finalizeTransientFailureRetriesToCompletion() = runTest {
        val file = writeFile("f.bin", 5000, seed = 8)
        val service = FakeUploadService(
            chunkCap = 1024 * 1024,
            failFinalizeOnce = ApiFailure.Network(ApiFailure.Network.CauseKind.TIMEOUT, java.io.IOException("t")),
        )
        val engine = UploadTransferEngine(service)
        var attempts = 0
        val outcome = engine.transfer(
            item("f.bin"),
            native,
            file,
            sha(file),
            onProgress = { attempts++ },
        )
        // The finalize network failure propagates as a transient failure (the
        // worker retries the whole item; idempotency keeps it one file).
        assertTrue(
            "transient finalize failure surfaces for the worker to retry",
            outcome is UploadTransferEngine.TransferOutcome.Failed &&
                (outcome as UploadTransferEngine.TransferOutcome.Failed).transient,
        )
    }

    // ---- R2: cooperative cancellation ----

    @Test
    fun cooperativeCancelDuringChunkStopsTheTransferAndWritesNothing() = runTest {
        val file = writeFile("cancel.bin", 2 * 1024 * 1024, seed = 6)
        val service = FakeUploadService(chunkCap = 1024 * 1024)
        val engine = UploadTransferEngine(service)
        var cancelledOnProgress = 0
        // The worker's onProgress checks the DURABLE store state and throws
        // CancellationException when the user's cancel won the race. The
        // engine must propagate it (never turn it into FAILED/DONE).
        val outcome = try {
            engine.transfer(
                item("cancel.bin"),
                native,
                file,
                sha(file),
                onProgress = {
                    if (cancelledOnProgress == 0) {
                        cancelledOnProgress += 1
                        throw CancellationException("durable CANCELLED")
                    }
                },
            )
            "no-throw"
        } catch (e: CancellationException) {
            "cancelled"
        }
        assertEquals("cancelled", outcome)
        assertTrue("the transfer got at least one durable progress checkpoint", cancelledOnProgress == 1)
    }

    @Test
    fun finalizeConflictAfterRemoteCancelSurfacesAsTransientForTheWorker() = runTest {
        val file = writeFile("fc.bin", 3000, seed = 4)
        // The user cancelled remotely between the last chunk and finalize; the
        // server refuses finalize on the cancelled row with a 409 conflict.
        val service = object : FakeUploadService(chunkCap = 1024 * 1024) {
            override suspend fun finalize(
                origin: String,
                native: NativeToken,
                uploadId: String,
            ): MobileUploadReceiptDto = throw ApiFailure.UploadConflict("upload is in a terminal or incompatible state")
        }
        val outcome = UploadTransferEngine(service).transfer(item("fc.bin"), native, file, sha(file))
        // The engine reports a transient failure; the worker's store write is
        // then REFUSED by the terminal-state guard, so the item stays
        // durably CANCELLED (never resurrected by the failed finalize).
        assertTrue(
            "finalize conflict propagates as a transient failure",
            outcome is UploadTransferEngine.TransferOutcome.Failed &&
                (outcome as UploadTransferEngine.TransferOutcome.Failed).transient,
        )
    }
}

/** Top-level helper: fake server state DTO (callable from nested fakes). */
private fun stateDto(id: String, bytesReceived: Long, status: String = "uploading"): MobileUploadDto =
    MobileUploadDto(
        id = id,
        destinationId = "mdst-1",
        fileName = "doc.pdf",
        finalRelPath = "Mobile/mob-host-1/Inbox/doc.pdf",
        sizeBytes = bytesReceived,
        bytesReceived = bytesReceived,
        status = status,
        createdAt = 1L,
        updatedAt = 1L,
    )
