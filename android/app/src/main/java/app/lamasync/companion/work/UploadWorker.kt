package app.lamasync.companion.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.lamasync.companion.data.FileSha256
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.RegistrationStoreImpl
import app.lamasync.companion.data.UploadQueueItem
import app.lamasync.companion.data.UploadQueueStore
import app.lamasync.companion.data.UploadReceipt
import app.lamasync.companion.data.UploadStatus
import app.lamasync.companion.data.UploadTransferEngine
import app.lamasync.companion.network.HttpUrlConnectionTransport
import app.lamasync.companion.network.MobileUploadApi
import java.io.File
import kotlinx.coroutines.CancellationException

/**
 * LAMA-296 stage 1 — the durable transfer executor. WorkManager survives
 * process death and reboot; the ViewModel only enqueues this work and
 * observes the persisted queue. The worker drains every transferable item:
 *
 *   binding check (item origin+hostId must equal the CURRENT registration —
 *   disconnect/re-pair never redirects old uploads to a new identity),
 *   staged-file locator, chunk-resumable transfer, receipt persistence.
 *
 * Transient network failures return [Result.retry] (WorkManager backoff);
 * blocked items stay in the queue for a user decision. Progress is persisted
 * to [UploadQueueStore] after every durable state change and mirrored into
 * WorkManager progress.
 *
 * LAMA-296 stage-1 correction (R2): cancellation is a DURABLE REQUESTED
 * STATE (status CANCELLED persisted by the ViewModel). The worker:
 *   - checks, before every persisted write, whether the CURRENT store state
 *     is CANCELLED/DONE and stops cooperatively (a stale pre-cancel object
 *     can never overwrite the user's cancel — the store also refuses it);
 *   - re-syncs remote cancellation for CANCELLED items whose server row was
 *     never cancelled (e.g. the device was offline when the user cancelled)
 *     and applies the AUTHORITATIVE server result (a race lost to finalize
 *     reconciles to DONE with the receipt instead of lying);
 *   - never leaves staging around for a terminal decision.
 */
class UploadWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val context = applicationContext
        val store = UploadQueueStore.getInstance(context)
        val vault = KeystoreCredentialVault(context)
        val registrationStore = RegistrationStoreImpl(context)
        val registration = registrationStore.load()
        val native = vault.nativeToken()
        val uploadsDir = File(context.filesDir, "uploads")
        val api = MobileUploadApi(HttpUrlConnectionTransport())

        val engine = UploadTransferEngine(
            api = api,
        )
        var transientFailure = false
        var processed = 0

        for (item in store.pendingItems().toList()) {
            processed += 1
            // Skip items with nothing left to do.
            if (item.status == UploadStatus.CANCELLED || item.status == UploadStatus.DONE) continue

            // Binding invariant: an item belongs to the identity that
            // created it. A disconnect/re-pair (even to the same origin with
            // a new hostId) blocks these items instead of resubmitting them
            // under the new identity.
            if (!bindingMatches(item, registration)) {
                store.update(
                    item.copy(
                        status = UploadStatus.BLOCKED,
                        error = if (registration == null) {
                            "This device is no longer paired. Re-pair, then retry this upload."
                        } else {
                            "This upload belongs to a previous pairing (${item.hostId}). Re-pair the original device or remove this item."
                        },
                        updatedAtEpochMillis = System.currentTimeMillis(),
                    ),
                )
                continue
            }
            if (native == null) {
                store.update(
                    item.copy(
                        status = UploadStatus.BLOCKED,
                        error = "The device credential is unavailable. Re-pair this device.",
                        updatedAtEpochMillis = System.currentTimeMillis(),
                    ),
                )
                continue
            }

            // Locate the staged source. Transient share grants were staged at
            // intake; the private copy is the durable source.
            val staged = stagedSourceOf(item, uploadsDir, store) ?: continue

            setProgress(workDataOf("itemId" to item.id, "status" to "transferring"))

            val outcome = try {
                engine.transfer(
                    item = item,
                    native = native,
                    stagedFile = staged.file,
                    stagedSha256 = staged.sha256,
                    onProgress = { updated ->
                        // Cooperative cancellation (R2): if the user's cancel
                        // (or a server-authoritative completion) landed while
                        // this transfer ran, stop the loop NOW. The store's
                        // terminal-state guard is the backstop for any write
                        // that already slipped through.
                        val currentStatus = durableStatusOf(store, updated.id)
                        if (currentStatus == UploadStatus.CANCELLED || currentStatus == UploadStatus.DONE) {
                            throw CancellationException("transfer superseded by durable state")
                        }
                        store.update(updated)
                        setProgress(
                            workDataOf(
                                "itemId" to updated.id,
                                "uploadedBytes" to updated.uploadedBytes,
                                "totalBytes" to (updated.sizeBytes ?: 0L),
                            ),
                        )
                    },
                )
            } catch (e: CancellationException) {
                // User cancelled mid-transfer: persist NOTHING (the store
                // keeps the durable CANCELLED state and already removed the
                // local staging). Move to the next item.
                continue
            }

            when (outcome) {
                is UploadTransferEngine.TransferOutcome.Completed -> {
                    store.update(
                        item.copy(
                            status = UploadStatus.DONE,
                            serverStatus = "finalized",
                            receipt = outcome.receipt,
                            uploadedBytes = outcome.receipt.sizeBytes,
                            serverBytesReceived = outcome.receipt.sizeBytes,
                            error = null,
                            updatedAtEpochMillis = System.currentTimeMillis(),
                        ),
                    )
                    // Durable completion permits local staging cleanup.
                    staged.file.delete()
                }
                is UploadTransferEngine.TransferOutcome.Blocked -> {
                    store.update(
                        item.copy(
                            status = UploadStatus.BLOCKED,
                            error = outcome.message,
                            updatedAtEpochMillis = System.currentTimeMillis(),
                        ),
                    )
                }
                is UploadTransferEngine.TransferOutcome.Failed -> {
                    store.update(
                        item.copy(
                            status = UploadStatus.FAILED,
                            error = outcome.message,
                            updatedAtEpochMillis = System.currentTimeMillis(),
                        ),
                    )
                    if (outcome.transient) transientFailure = true
                }
                is UploadTransferEngine.TransferOutcome.Skipped -> Unit
            }
        }

        // R2: reconcile remote cancellation for items the user cancelled
        // while the device was offline (or whose cancel call never landed) —
        // the server row also stores the authoritative finalize outcome.
        syncServerCancellations(store, api, native, registration)

        cleanupTerminalStaging(context, store)
        // Transient failures → retry with WorkManager backoff; everything
        // else drains cleanly and the worker stops (no busy loop).
        return if (transientFailure && processed > 0) Result.retry() else Result.success()
    }

    /** Item binds to the current registration identity or is blocked. */
    private fun bindingMatches(item: UploadQueueItem, registration: Registration?): Boolean {
        return registration != null &&
            registration.origin == item.origin &&
            registration.hostId == item.hostId
    }

    /** The current durable status of an item (null when it was removed). */
    private fun durableStatusOf(store: UploadQueueStore, itemId: String): UploadStatus? =
        store.load().items.firstOrNull { it.id == itemId }?.status

    /**
     * Resolve the staged source file + its sha256. A missing private copy
     * (app storage cleared mid-lifecycle) blocks the item loudly instead of
     * silently skipping it.
     */
    private fun stagedSourceOf(
        item: UploadQueueItem,
        uploadsDir: File,
        store: UploadQueueStore,
    ): StagedSource? {
        if (item.staged && item.stagedFileName != null) {
            val file = File(uploadsDir, item.stagedFileName)
            if (file.exists()) {
                val sha = item.sha256 ?: FileSha256.of(file)
                return StagedSource(file, sha)
            }
            store.update(
                item.copy(
                    status = UploadStatus.BLOCKED,
                    error = "The staged copy of this file is missing (app storage was cleared). Re-select the file.",
                    updatedAtEpochMillis = System.currentTimeMillis(),
                ),
            )
            return null
        }
        store.update(
            item.copy(
                status = UploadStatus.BLOCKED,
                error = "This item was not staged before transfer. Re-select the file.",
                updatedAtEpochMillis = System.currentTimeMillis(),
            ),
        )
        return null
    }

    /** Local staging is retained until a durable completion/cancellation
     *  decision; this pass removes only staged files of terminal items. */
    private fun cleanupTerminalStaging(context: Context, store: UploadQueueStore) {
        val uploadsDir = File(context.filesDir, "uploads")
        val items = store.load().items
        val keepNames = items
            .filter {
                it.status == UploadStatus.PENDING ||
                    it.status == UploadStatus.UPLOADING ||
                    it.status == UploadStatus.WAITING ||
                    it.status == UploadStatus.FAILED ||
                    it.status == UploadStatus.BLOCKED
            }
            .mapNotNull { it.stagedFileName }
            .toSet()
        uploadsDir.listFiles()?.forEach { f ->
            if (f.isFile && f.name !in keepNames) {
                f.delete()
            }
        }
    }

    private data class StagedSource(val file: File, val sha256: String)
}

/**
 * R2 offline-cancellation reconciliation: every CANCELLED item with a server
 * upload id whose remote cancel never landed (device offline when the user
 * cancelled, or the cancel request was lost) is cancelled server-side now —
 * best effort, never failing the run. If the server reports the upload
 * already finalized (the cancel lost the race to finalize), the authoritative
 * result is applied: the item becomes DONE with the receipt instead of
 * claiming a cancellation of a protected file. Returns the number of items
 * reconciled (finalized → DONE) and -1 when the credential is unavailable.
 * Internal (not a public API) and called by [UploadWorker]; the on-device
 * suite drives it directly for the offline/restart regressions.
 */
internal suspend fun syncServerCancellations(
    store: UploadQueueStore,
    api: app.lamasync.companion.network.MobileUploadService,
    native: NativeToken?,
    registration: Registration?,
): Int {
    if (native == null) return -1
    val cancelled = store.load().items.filter {
        it.status == UploadStatus.CANCELLED && it.serverUploadId != null
    }
    var reconciled = 0
    for (item in cancelled) {
        val matches = registration != null &&
            registration.origin == item.origin &&
            registration.hostId == item.hostId
        if (!matches) continue
        val serverResult = try {
            api.cancel(item.origin, native, item.serverUploadId!!)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Still offline/unreachable — a later run retries.
            continue
        }
        if (serverResult.status == "finalized") {
            val receipt = serverResult.receipt?.let {
                UploadReceipt(
                    uploadId = it.uploadId,
                    fileName = it.fileName,
                    finalRelPath = it.finalRelPath,
                    browsePath = it.browseRef?.path ?: it.finalRelPath,
                    sizeBytes = it.sizeBytes,
                    sha256 = it.sha256,
                    finalizedAtEpochMillis = it.finalizedAt,
                )
            }
            store.update(
                item.copy(
                    status = UploadStatus.DONE,
                    serverStatus = "finalized",
                    receipt = receipt,
                    uploadedBytes = serverResult.bytesReceived,
                    serverBytesReceived = serverResult.bytesReceived,
                    error = null,
                    updatedAtEpochMillis = System.currentTimeMillis(),
                ),
            )
            reconciled += 1
        }
    }
    return reconciled
}