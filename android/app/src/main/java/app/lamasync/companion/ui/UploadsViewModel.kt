package app.lamasync.companion.ui

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.data.ContentStager
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.RegistrationStoreImpl
import app.lamasync.companion.data.UploadPolicy
import app.lamasync.companion.data.UploadPolicyStore
import app.lamasync.companion.data.UploadQueueItem
import app.lamasync.companion.data.UploadQueueStore
import app.lamasync.companion.data.UploadReceipt
import app.lamasync.companion.data.UploadStatus
import app.lamasync.companion.network.HttpUrlConnectionTransport
import app.lamasync.companion.network.MobileUploadApi
import app.lamasync.companion.network.MobileUploadDestinationDto
import app.lamasync.companion.work.UploadWorkScheduler
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * LAMA-296 stage 1 — upload intake + queue UI state. The ViewModel observes
 * the persisted queue and enqueues WorkManager work; it is NEVER the durable
 * transfer executor (the [app.lamasync.companion.work.UploadWorker] is).
 *
 * Intake rules: external intents cannot choose server origins or override
 * destination grants; items bind to the enrollment identity at intake; a
 * share while unpaired (or with lost credential material) is an explicit,
 * renderable failure — never an empty screen or a null assertion (R5).
 *
 * R1: the ViewModel collects the store's snapshot FLOW (the worker and the
 * ViewModel share the one process-wide store instance), so worker progress,
 * failure and completion appear live on an already-open Uploads screen.
 */
class UploadsViewModel(application: Application) : AndroidViewModel(application) {

    private val context = application
    private val store = UploadQueueStore.getInstance(context)
    private val policyStore = UploadPolicyStore(context)
    private val registrationStore = RegistrationStoreImpl(context)
    private val vault = KeystoreCredentialVault(context)
    private val uploadApi = lazy { MobileUploadApi(HttpUrlConnectionTransport()) }
    private val uploadsDir = File(context.filesDir, "uploads")

    /** Why intake cannot proceed: the device is not in a usable paired
     *  state (R5). The Uploads screen renders an onboarding/error surface. */
    enum class IntakeBlock { UNPAIRED, CREDENTIAL_LOST }

    /** Share URIs awaiting a destination choice (N > 1 destinations). */
    data class PendingShare(
        val uris: List<Uri>,
        val destinations: List<MobileUploadDestinationDto>,
    )

    data class UploadsUiState(
        val items: List<UploadQueueItem> = emptyList(),
        val pendingShare: PendingShare? = null,
        /** Non-null when the last intake was blocked by pairing state. */
        val intakeBlock: IntakeBlock? = null,
        val policy: UploadPolicy = UploadPolicy(),
        val message: String? = null,
        val messageIsError: Boolean = false,
        val busy: Boolean = false,
    )

    private val _ui = MutableStateFlow(UploadsUiState())
    val ui: StateFlow<UploadsUiState> = _ui.asStateFlow()

    private val stager = ContentStager(
        contentResolver = context.contentResolver,
        uploadsDir = { uploadsDir },
    )

    private var initialized = false

    fun initialize() {
        if (initialized) return
        initialized = true
        // R1: live queue observation — every worker/UI mutation on the
        // shared store re-emits the snapshot into the UI state.
        viewModelScope.launch {
            store.snapshots.collect { snap ->
                _ui.update { it.copy(items = snap.items) }
            }
        }
        _ui.update { it.copy(policy = policyStore.load()) }
    }

    private fun message(text: String, isError: Boolean = false) {
        _ui.update { it.copy(message = text, messageIsError = isError) }
    }

    fun dismissMessage() {
        _ui.update { it.copy(message = null) }
    }

    fun currentRegistration(): Registration? = registrationStore.load()

    fun nativeToken(): NativeToken? = vault.nativeToken()

    /**
     * Accept share/document URIs (content links only). Stages them (bounded)
     * after resolving the destination: 0 destinations → explicit failure; 1 →
     * immediate; N → the picker. Never treats URIs as filesystem paths.
     * Unpaired/credential-lost intake is an explicit, renderable block (R5).
     */
    fun acceptShare(uris: List<Uri>, grantFlags: Int) {
        val clean = uris.filter { it.scheme == "content" }
        if (clean.isEmpty()) {
            message("Nothing to upload — the shared link is not a document.", isError = true)
            return
        }
        val registration = registrationStore.load()
        if (registration == null) {
            // Spec: intake while unpaired is an explicit failure — shown on
            // the Uploads screen's onboarding surface, never silently.
            _ui.update { it.copy(busy = false, intakeBlock = IntakeBlock.UNPAIRED) }
            message("Pair this device with a QR before sharing files. Your share was not queued.", isError = true)
            return
        }
        val native = vault.nativeToken()
        if (native == null) {
            // Registration metadata survived but the credential material is
            // gone (Keystore loss / app restore) — same renderable block.
            _ui.update { it.copy(busy = false, intakeBlock = IntakeBlock.CREDENTIAL_LOST) }
            message(
                "This device's credential is missing — re-pair it, then share again. Your share was not queued.",
                isError = true,
            )
            return
        }
        // Retain the grant where the platform allows it (document flows).
        clean.forEach { uri ->
            if (grantFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0) {
                try {
                    context.contentResolver.takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION,
                    )
                } catch (e: Exception) {
                    // Transient share grants are not persistable — the private
                    // staging copy is the durable source either way.
                }
            }
        }
        _ui.update { it.copy(busy = true, message = null, intakeBlock = null) }
        viewModelScope.launch {
            val destinations = try {
                uploadApi.value.listDestinations(registration.origin, native)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiFailure.Unauthorized) {
                _ui.update { it.copy(busy = false) }
                message(
                    "This device's upload access was revoked — re-pair to upload again.",
                    isError = true,
                )
                return@launch
            } catch (e: ApiFailure.Network) {
                _ui.update { it.copy(busy = false) }
                message("Cannot reach the server to find your inboxes. Check the connection.", isError = true)
                return@launch
            } catch (e: ApiFailure) {
                _ui.update { it.copy(busy = false) }
                message("Could not load upload inboxes (${e.message}).", isError = true)
                return@launch
            }
            when (destinations.size) {
                0 -> {
                    _ui.update { it.copy(busy = false) }
                    message(
                        "No upload inbox is assigned to this device yet. An administrator must " +
                            "assign one from the desktop web UI (Admin → Android devices → Inboxes).",
                        isError = true,
                    )
                }
                1 -> {
                    proceedWithDestination(registration, clean, destinations.first())
                }
                else -> {
                    _ui.update {
                        it.copy(busy = false, pendingShare = PendingShare(clean, destinations))
                    }
                }
            }
        }
    }

    /** User picked a destination in the picker. */
    fun chooseDestination(dest: MobileUploadDestinationDto) {
        val pending = _ui.value.pendingShare ?: return
        val registration = registrationStore.load()
        val native = vault.nativeToken()
        if (registration == null || native == null) {
            _ui.update {
                it.copy(
                    busy = false,
                    pendingShare = null,
                    intakeBlock = if (registration == null) IntakeBlock.UNPAIRED else IntakeBlock.CREDENTIAL_LOST,
                )
            }
            message(
                if (registration == null) {
                    "Pair this device with a QR before sharing files."
                } else {
                    "This device's credential is missing — re-pair it first."
                },
                isError = true,
            )
            return
        }
        _ui.update { it.copy(busy = true, pendingShare = null, message = null, intakeBlock = null) }
        viewModelScope.launch {
            proceedWithDestination(registration, pending.uris, dest)
        }
    }

    fun cancelDestinationChoice() {
        _ui.update { it.copy(pendingShare = null) }
    }

    /** Stage every URI (bounded) + enqueue one item per file + schedule work. */
    private fun proceedWithDestination(
        registration: Registration,
        uris: List<Uri>,
        dest: MobileUploadDestinationDto,
    ) {
        viewModelScope.launch {
            var stagedCount = 0
            val now = System.currentTimeMillis()
            for (uri in uris) {
                val staged = stager.stage(uri)
                when (staged) {
                    is ContentStager.StageResult.Success -> {
                        val display = displayNameFor(uri, stager.targetName(uri))
                        val item = UploadQueueItem(
                            id = UUID.randomUUID().toString(),
                            origin = registration.origin,
                            hostId = registration.hostId,
                            sourceUri = uri.toString(),
                            displayName = display,
                            mimeType = uriMime(uri),
                            sizeBytes = staged.sizeBytes,
                            destinationId = dest.id,
                            destinationRelPath = dest.relPath,
                            idempotencyKey = "up-${UUID.randomUUID()}",
                            sha256 = staged.sha256,
                            stagedFileName = staged.file.name,
                            staged = true,
                            status = UploadStatus.PENDING,
                            createdAtEpochMillis = now,
                            updatedAtEpochMillis = now,
                        )
                        store.add(item)
                        stagedCount += 1
                    }
                    is ContentStager.StageResult.Failure -> {
                        message(
                            when (staged.reason) {
                                ContentStager.StageFailure.UNREADABLE -> "Cannot read a shared file — it may no longer be available."
                                ContentStager.StageFailure.TOO_LARGE -> "A shared file exceeds the local staging limit."
                                ContentStager.StageFailure.NO_SPACE -> "Not enough free storage to stage the shared file."
                                ContentStager.StageFailure.IO_ERROR -> "Could not stage the shared file locally."
                            },
                            isError = true,
                        )
                    }
                }
            }
            if (stagedCount > 0) {
                UploadWorkScheduler.scheduleUploads(context, policyStore.load(), UploadWorkScheduler.UploadItemKind.MANUAL)
            }
            _ui.update { it.copy(busy = false) }
            if (stagedCount > 0) {
                message("$stagedCount file${if (stagedCount == 1) "" else "s"} queued for upload.")
            }
        }
    }

    fun retryItem(itemId: String) {
        val item = store.load().items.firstOrNull { it.id == itemId } ?: return
        if (item.status == UploadStatus.DONE) return
        store.update(
            item.copy(
                status = UploadStatus.PENDING,
                error = null,
                updatedAtEpochMillis = System.currentTimeMillis(),
            ),
        )
        UploadWorkScheduler.scheduleUploads(context, policyStore.load(), UploadWorkScheduler.UploadItemKind.MANUAL)
    }

    /**
     * User cancel (R2): 1) persist the durable REQUESTED state first — the
     * running worker sees it and stops cooperatively, and a process restart
     * retains it; 2) cancel remotely BEFORE deleting staging; 3) delete the
     * local staged copy; 4) persist the AUTHORITATIVE server result — a
     * cancel that lost the race to finalize reconciles the item to DONE with
     * the receipt instead of claiming a cancellation of a protected file.
     */
    fun cancelItem(itemId: String) {
        val item = store.load().items.firstOrNull { it.id == itemId } ?: return
        if (item.status == UploadStatus.DONE) return
        val native = vault.nativeToken()
        val serverUploadId = item.serverUploadId
        val now = System.currentTimeMillis()
        // 1) Durable requested state (serialized with worker progress
        // updates by the process-wide store lock).
        store.update(
            item.copy(
                status = UploadStatus.CANCELLED,
                error = null,
                updatedAtEpochMillis = now,
            ),
        )
        // Force a reconciliation pass. KEEP can lose this request when the
        // existing worker is between its final cancellation scan and success.
        UploadWorkScheduler.scheduleCancellationReconciliation(context, policyStore.load(), UploadWorkScheduler.UploadItemKind.MANUAL)
        viewModelScope.launch {
            // 2) Cancel remotely before deleting staging (best-effort; the
            // worker also re-syncs offline cancellations on its next run).
            val serverResult = if (native != null && serverUploadId != null) {
                try {
                    uploadApi.value.cancel(item.origin, native, serverUploadId)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiFailure) {
                    null
                }
            } else {
                null
            }
            // 3) Local staging is dropped only after the remote attempt.
            deleteStagedFor(item)
            // 4) Authoritative server result.
            if (serverResult != null && serverResult.status == "finalized") {
                val receipt = serverResult.receipt?.let {
                    UploadReceipt(
                        uploadId = it.uploadId,
                        fileName = it.fileName,
                        finalRelPath = it.finalRelPath,
                        browsePath = it.browseRef?.path ?: it.finalRelPath,
                        browseFolderId = it.browseRef?.folderId,
                        sizeBytes = it.sizeBytes,
                        sha256 = it.sha256,
                        finalizedAtEpochMillis = it.finalizedAt,
                    )
                }
                val done = item.copy(
                    status = UploadStatus.DONE,
                    serverStatus = "finalized",
                    receipt = receipt,
                    uploadedBytes = serverResult.bytesReceived,
                    serverBytesReceived = serverResult.bytesReceived,
                    error = null,
                    updatedAtEpochMillis = System.currentTimeMillis(),
                )
                store.update(done)
                // A cancel that lost the race to finalize is a durable
                // completion: keep the automatic media registry honest too.
                app.lamasync.companion.media.MediaProtectionEngine.reconcileCompleted(
                    app.lamasync.companion.media.MediaProtectionStore.getInstance(context),
                    done,
                )
            }
        }
    }

    /** Remove a terminal item from the queue entirely. */
    fun removeItem(itemId: String) {
        val item = store.load().items.firstOrNull { it.id == itemId } ?: return
        if (item.status == UploadStatus.PENDING ||
            item.status == UploadStatus.UPLOADING ||
            item.status == UploadStatus.WAITING
        ) {
            return
        }
        store.remove(itemId)
        deleteStagedFor(item)
    }

    private fun deleteStagedFor(item: UploadQueueItem) {
        if (item.stagedFileName != null) {
            File(uploadsDir, item.stagedFileName).delete()
        }
    }

    fun setUnmeteredOnly(value: Boolean) {
        val policy = policyStore.load().copy(unmeteredOnly = value)
        policyStore.save(policy)
        _ui.update { it.copy(policy = policy) }
        UploadWorkScheduler.rescheduleWithPolicy(
            context,
            policy,
            UploadWorkScheduler.UploadItemKind.MANUAL,
        )
    }

    /** Browse/open URL for a completed receipt (embedded web UI Data Browser). */
    fun browseUrlFor(origin: String, browsePath: String, folderId: String? = null): String {
        val encoded = android.net.Uri.encode(browsePath)
        return if (folderId == null) {
            "$origin/#/data?kind=local&path=$encoded"
        } else {
            "$origin/#/data?kind=s3&folderId=${android.net.Uri.encode(folderId)}&path=$encoded"
        }
    }

    private fun displayNameFor(uri: Uri, fallback: String): String {
        return try {
            val name = android.provider.OpenableColumns.DISPLAY_NAME
                .let { col ->
                    context.contentResolver.query(uri, arrayOf(col), null, null, null)?.use { c ->
                        if (c.moveToFirst()) {
                            c.getString(c.getColumnIndexOrThrow(col))
                        } else null
                    }
                }
            name?.takeIf { it.isNotBlank() } ?: fallback
        } catch (e: Exception) {
            fallback
        }
    }

    private fun uriMime(uri: Uri): String? = context.contentResolver.getType(uri)
}
