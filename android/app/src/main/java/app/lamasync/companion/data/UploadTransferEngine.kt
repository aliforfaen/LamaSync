package app.lamasync.companion.data

import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.network.MobileUploadApi
import app.lamasync.companion.network.MobileUploadDto
import app.lamasync.companion.network.MobileUploadService
import java.io.File
import java.io.RandomAccessFile
import kotlinx.coroutines.CancellationException

/**
 * LAMA-296 stage 1 — per-item resumable transfer state machine. Pure Kotlin
 * (no Android APIs beyond the storage files it reads), so JVM tests drive it
 * over real temp files + a fake transport.
 *
 * Contract (server spec-296-stage-1-manual-uploads.md):
 *   create (idempotency-keyed) → chunk loop at the durable server offset →
 *   finalize (verify → publish → receipt). A lost create/chunk/finalize
 *   response is recovered by re-querying server state; one intent produces
 *   exactly one final file.
 *
 * Memory bound: chunks are read as ≤ [MobileUploadApi.MAX_CHUNK_SEND] bytes
 * at a time — the whole file is never buffered, whatever its size.
 */
class UploadTransferEngine(
    private val api: MobileUploadService,
    private val chunkSize: Int = MobileUploadApi.MAX_CHUNK_SEND,
) {

    sealed interface TransferOutcome {
        /** Durable verified completion. */
        data class Completed(val receipt: UploadReceipt) : TransferOutcome

        /** Cannot proceed without user action (revocation, collision, unpaired). */
        data class Blocked(val message: String) : TransferOutcome

        /** Failed; [transient] selects worker retry vs terminal failure. */
        data class Failed(val message: String, val transient: Boolean) : TransferOutcome

        /** Skipped without transfer (e.g. already done/cancelled). */
        data class Skipped(val reason: String) : TransferOutcome
    }

    /**
     * @param onProgress invoked after each durable state change (chunk
     *   accepted, offsets advanced) so the caller persists it. Suspending so
     *   the caller can mirror into WorkManager progress.
     */
    suspend fun transfer(
        item: UploadQueueItem,
        native: NativeToken,
        stagedFile: File,
        stagedSha256: String,
        onProgress: suspend (UploadQueueItem) -> Unit = {},
    ): TransferOutcome {
        if (item.status == UploadStatus.CANCELLED || item.status == UploadStatus.DONE) {
            return TransferOutcome.Skipped("no transfer needed")
        }

        // 1) Create (idempotency-safe): a retry after a lost response returns
        // the SAME upload id and reserved final name.
        val created = try {
            api.createUpload(
                origin = item.origin,
                native = native,
                destinationId = item.destinationId,
                fileName = item.displayName,
                sizeBytes = item.sizeBytes,
                sha256 = stagedSha256,
                idempotencyKey = item.idempotencyKey,
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiFailure.UploadCollision) {
            return TransferOutcome.Blocked(
                "A file with this name already exists at the destination. Rename the file or choose another inbox.",
            )
        } catch (e: ApiFailure.DestinationRevoked) {
            return TransferOutcome.Blocked("This destination was revoked by the administrator.")
        } catch (e: ApiFailure.Unauthorized) {
            return TransferOutcome.Blocked("This device's upload access was revoked — re-pair to continue.")
        } catch (e: ApiFailure.Network) {
            return TransferOutcome.Failed("Cannot reach the server (${kindText(e)}). Retry when connected.", transient = true)
        } catch (e: ApiFailure.MalformedResponse) {
            return TransferOutcome.Failed("The server returned an invalid response.", transient = false)
        } catch (e: ApiFailure.UploadTooLarge) {
            return TransferOutcome.Blocked("The file exceeds the server's upload size limit.")
        } catch (e: ApiFailure.StagingFull) {
            return TransferOutcome.Failed("Server upload staging is full. Retry later.", transient = true)
        } catch (e: ApiFailure) {
            return TransferOutcome.Failed("Upload could not be started (${e.message}).", transient = false)
        }

        onProgress(item.copy(
            serverUploadId = created.id,
            serverBytesReceived = created.bytesReceived,
            status = UploadStatus.UPLOADING,
            updatedAtEpochMillis = System.currentTimeMillis(),
        ))

        // 2) Chunk loop at the durable server offset.
        var state = created
        val fileSize = stagedFile.length()
        while (state.bytesReceived < fileSize) {
            val offset = state.bytesReceived
            val remaining = fileSize - offset
            val n = minOf(chunkSize.toLong(), remaining).toInt()
            val chunk = readRange(stagedFile, offset, n) ?: return TransferOutcome.Failed(
                "The staged file disappeared before it could be uploaded. Re-select the file.",
                transient = false,
            )
            state = try {
                api.sendChunk(item.origin, native, state.id, offset, chunk)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiFailure.UploadConflict) {
                // Lost-response recovery: the server may have accepted the
                // chunk but its reply was lost. Re-query the authoritative
                // state instead of failing.
                val fresh = try {
                    api.uploadState(item.origin, native, state.id)
                } catch (e2: CancellationException) {
                    throw e2
                } catch (e2: ApiFailure) {
                    return TransferOutcome.Failed("Could not recover upload state (${e2.message}). Retry.", transient = true)
                }
                fresh.takeIf { it.bytesReceived > offset }
                    ?: return TransferOutcome.Failed(
                        "The server refused the chunk offset. Cancel and re-select the file.",
                        transient = false,
                    )
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiFailure.Network) {
                return TransferOutcome.Failed("Network interrupted mid-transfer. Retry when connected.", transient = true)
            } catch (e: ApiFailure.Unauthorized) {
                return TransferOutcome.Blocked("This device's upload access was revoked mid-transfer — re-pair to continue.")
            } catch (e: ApiFailure.DestinationRevoked) {
                return TransferOutcome.Blocked("This destination was revoked mid-transfer by the administrator.")
            } catch (e: ApiFailure.StagingFull) {
                return TransferOutcome.Failed("Server upload staging is full. Retry later.", transient = true)
            } catch (e: ApiFailure.UploadTooLarge) {
                return TransferOutcome.Blocked("A chunk exceeded the server limit.")
            } catch (e: ApiFailure) {
                return TransferOutcome.Failed("Upload failed (${e.message}). Retry.", transient = true)
            }
            onProgress(item.copy(
                serverUploadId = state.id,
                uploadedBytes = state.bytesReceived,
                serverBytesReceived = state.bytesReceived,
                serverStatus = state.status,
                status = UploadStatus.UPLOADING,
                updatedAtEpochMillis = System.currentTimeMillis(),
            ))
        }

        // 3) Finalize (verify + publish). Retry-safe; an incomplete report
        // from the server sends the loop back to top up remaining chunks.
        while (true) {
            val finalizeResult = try {
                api.finalize(item.origin, native, state.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiFailure.ChecksumMismatch) {
                return TransferOutcome.Blocked(
                    "The received file did not match its checksum. Cancel this item and re-select the file.",
                )
            } catch (e: ApiFailure.UploadCollision) {
                return TransferOutcome.Blocked("A file with this name now exists at the destination. Rename and re-select.")
            } catch (e: ApiFailure.UploadIncomplete) {
                // Server thought it was incomplete — re-sync and finish the loop.
                val fresh = try {
                    api.uploadState(item.origin, native, state.id)
                } catch (e2: CancellationException) {
                    throw e2
                } catch (e2: ApiFailure) {
                    return TransferOutcome.Failed("Upload incomplete on the server and state is unreachable.", transient = true)
                }
                if (fresh.bytesReceived < fileSize) {
                    onProgress(item.copy(
                        serverUploadId = fresh.id,
                        uploadedBytes = fresh.bytesReceived,
                        serverBytesReceived = fresh.bytesReceived,
                        serverStatus = fresh.status,
                        status = UploadStatus.UPLOADING,
                        updatedAtEpochMillis = System.currentTimeMillis(),
                    ))
                    state = fresh
                    continue
                }
                return TransferOutcome.Failed("Upload is incomplete on the server. Retry.", transient = true)
            } catch (e: ApiFailure.Unauthorized) {
                return TransferOutcome.Blocked("This device's upload access was revoked before publication — re-pair to continue.")
            } catch (e: ApiFailure.DestinationRevoked) {
                return TransferOutcome.Blocked("This destination was revoked before publication by the administrator.")
            } catch (e: ApiFailure.Network) {
                return TransferOutcome.Failed("Network interrupted during finalize. Retry when connected.", transient = true)
            } catch (e: ApiFailure) {
                return TransferOutcome.Failed("Finalize failed (${e.message}). Retry.", transient = true)
            }
            val receipt = UploadReceipt(
                uploadId = finalizeResult.uploadId,
                fileName = finalizeResult.fileName,
                finalRelPath = finalizeResult.finalRelPath,
                browsePath = finalizeResult.browseRef?.path ?: finalizeResult.finalRelPath,
                sizeBytes = finalizeResult.sizeBytes,
                sha256 = finalizeResult.sha256,
                finalizedAtEpochMillis = finalizeResult.finalizedAt,
            )
            return TransferOutcome.Completed(receipt)
        }
    }

    /** Streaming file hash for items without a recorded digest. */
    fun hashOf(file: File): String = FileSha256.of(file)

    private fun readRange(file: File, offset: Long, length: Int): ByteArray? {
        return try {
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(offset)
                val buffer = ByteArray(length)
                val read = readFully(raf, buffer)
                if (read < length) buffer.copyOf(read) else buffer
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun readFully(raf: RandomAccessFile, buffer: ByteArray): Int {
        var total = 0
        while (total < buffer.size) {
            val read = raf.read(buffer, total, buffer.size - total)
            if (read == -1) break
            total += read
        }
        return total
    }

    private fun kindText(e: ApiFailure.Network): String = when (e.causeKind) {
        ApiFailure.Network.CauseKind.CONNECT -> "unreachable"
        ApiFailure.Network.CauseKind.TIMEOUT -> "timed out"
        ApiFailure.Network.CauseKind.TLS -> "TLS failure"
        ApiFailure.Network.CauseKind.IO -> "connection error"
    }
}