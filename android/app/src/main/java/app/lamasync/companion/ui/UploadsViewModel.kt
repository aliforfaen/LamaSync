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
import app.lamasync.companion.media.GalleryFolder
import app.lamasync.companion.media.GalleryFolderCatalog
import app.lamasync.companion.media.MediaPermissionScope
import app.lamasync.companion.network.HttpUrlConnectionTransport
import app.lamasync.companion.network.MobileUploadApi
import app.lamasync.companion.network.MobileUploadDestinationDto
import androidx.core.net.toUri
import app.lamasync.companion.work.UploadWorkScheduler
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
        /** Set when the pending intake is a gallery folder, not a file list. */
        val gallery: GalleryRequest? = null,
    )

    /**
     * LAMA-334 item 1: a gallery top-level folder chosen for upload. The
     * contents are snapshotted when the batch starts, not when the folder is
     * tapped, so what the operator confirmed is what gets queued.
     */
    data class GalleryRequest(val key: String, val label: String, val declaredCount: Int)

    /** Progress of the batch currently being staged into the queue. */
    data class GalleryBatch(
        val folderLabel: String,
        val queued: Int,
        val total: Int,
        /** Waiting for an earlier file to leave app storage before staging more. */
        val waiting: Boolean = false,
    )

    /** The gallery-folder catalogue and the permissions it was built under. */
    data class GalleryState(
        val scope: MediaPermissionScope = MediaPermissionScope.NOT_GRANTED,
        val folders: List<GalleryFolder> = emptyList(),
        val loading: Boolean = false,
        /** The MediaStore scan hit its cap; counts are a floor. */
        val truncated: Boolean = false,
        val error: String? = null,
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
        val gallery: GalleryState = GalleryState(),
        val galleryBatch: GalleryBatch? = null,
    )

    private val _ui = MutableStateFlow(UploadsUiState())
    val ui: StateFlow<UploadsUiState> = _ui.asStateFlow()

    private val stager = ContentStager(
        contentResolver = context.contentResolver,
        uploadsDir = { uploadsDir },
    )

    /** LAMA-334 item 1: MediaStore folder catalogue (read-only, no new grant). */
    private val galleryCatalog = GalleryFolderCatalog(context)
    private var galleryBatchJob: Job? = null

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
            when (val result = fetchDestinations(registration, native)) {
                is DestinationsResult.Failed -> {
                    _ui.update { it.copy(busy = false) }
                    message(result.message, isError = true)
                }
                is DestinationsResult.Ready -> when (result.destinations.size) {
                    0 -> {
                        _ui.update { it.copy(busy = false) }
                        message(NO_INBOX_MESSAGE, isError = true)
                    }
                    1 -> proceedWithDestination(registration, clean, result.destinations.first())
                    else -> _ui.update {
                        it.copy(busy = false, pendingShare = PendingShare(clean, result.destinations))
                    }
                }
            }
        }
    }

    // ------------------------------------------------- LAMA-334 item 1: gallery

    /**
     * Build (or rebuild) the gallery-folder catalogue from MediaStore.
     *
     * The permission scope is read LIVE, so a grant or revoke in Settings is
     * reflected on the next refresh — never from stored state.
     */
    fun refreshGalleryFolders() {
        _ui.update { it.copy(gallery = it.gallery.copy(loading = true, error = null)) }
        viewModelScope.launch {
            val listing = try {
                galleryCatalog.listFolders()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.update {
                    it.copy(
                        gallery = it.gallery.copy(
                            loading = false,
                            error = "Could not read the device gallery.",
                        ),
                    )
                }
                return@launch
            }
            _ui.update {
                it.copy(
                    gallery = GalleryState(
                        scope = listing.scope,
                        folders = listing.folders,
                        loading = false,
                        truncated = listing.truncated,
                    ),
                )
            }
        }
    }

    /** The media permission dialog returned: re-read the live scope. */
    fun onGalleryPermissionResult() {
        refreshGalleryFolders()
    }

    /**
     * Queue everything readable in [folder], as a one-shot snapshot.
     *
     * The destination rules are the share flow's: zero inboxes is an explicit
     * failure, one is used directly, several ask. Nothing here can choose a
     * server or widen a grant.
     */
    fun uploadGalleryFolder(folder: GalleryFolder) {
        if (galleryBatchJob?.isActive == true) {
            message("A gallery folder is already being queued.", isError = true)
            return
        }
        val registration = registrationStore.load()
        if (registration == null) {
            _ui.update { it.copy(busy = false, intakeBlock = IntakeBlock.UNPAIRED) }
            message(UNPAIRED_MESSAGE, isError = true)
            return
        }
        val native = vault.nativeToken()
        if (native == null) {
            _ui.update { it.copy(busy = false, intakeBlock = IntakeBlock.CREDENTIAL_LOST) }
            message(CREDENTIAL_LOST_MESSAGE, isError = true)
            return
        }
        val request = GalleryRequest(folder.key, folder.label, folder.itemCount)
        _ui.update { it.copy(busy = true, message = null, intakeBlock = null) }
        viewModelScope.launch {
            when (val result = fetchDestinations(registration, native)) {
                is DestinationsResult.Failed -> {
                    _ui.update { it.copy(busy = false) }
                    message(result.message, isError = true)
                }
                is DestinationsResult.Ready -> when (result.destinations.size) {
                    0 -> {
                        _ui.update { it.copy(busy = false) }
                        message(NO_INBOX_MESSAGE, isError = true)
                    }
                    1 -> startGalleryBatch(registration, request, result.destinations.first())
                    else -> _ui.update {
                        it.copy(
                            busy = false,
                            pendingShare = PendingShare(
                                uris = emptyList(),
                                destinations = result.destinations,
                                gallery = request,
                            ),
                        )
                    }
                }
            }
        }
    }

    /** Stops adding files to the queue; what is already queued keeps uploading. */
    fun cancelGalleryBatch() {
        galleryBatchJob?.cancel()
    }

    private sealed interface DestinationsResult {
        data class Ready(val destinations: List<MobileUploadDestinationDto>) : DestinationsResult
        data class Failed(val message: String) : DestinationsResult
    }

    private suspend fun fetchDestinations(
        registration: Registration,
        native: NativeToken,
    ): DestinationsResult = try {
        DestinationsResult.Ready(uploadApi.value.listDestinations(registration.origin, native))
    } catch (e: CancellationException) {
        throw e
    } catch (e: ApiFailure.Unauthorized) {
        DestinationsResult.Failed(REVOKED_MESSAGE)
    } catch (e: ApiFailure.Network) {
        DestinationsResult.Failed("Cannot reach the server to find your inboxes. Check the connection.")
    } catch (e: ApiFailure) {
        DestinationsResult.Failed("Could not load upload inboxes (${e.message}).")
    }

    /**
     * Stage a gallery folder into the queue, a few files at a time.
     *
     * Staging is a private copy in app storage (stage-1's contract), so the
     * batch deliberately keeps only [GALLERY_STAGING_WINDOW] un-transferred
     * files on disk: a 3000-photo roll must not need 12 GB of free space to
     * start. Each pass re-enqueues the drainer with KEEP, which is a no-op
     * while a worker runs and starts a fresh pass when one has already
     * snapshotted the queue — that is what stops a batch from stranding the
     * files it added after the worker's snapshot.
     */
    private fun startGalleryBatch(
        registration: Registration,
        request: GalleryRequest,
        dest: MobileUploadDestinationDto,
    ) {
        val job = viewModelScope.launch {
            _ui.update {
                it.copy(
                    busy = false,
                    pendingShare = null,
                    galleryBatch = GalleryBatch(request.label, 0, request.declaredCount, waiting = true),
                )
            }
            val items = galleryCatalog.itemsIn(request.key)
            _ui.update {
                it.copy(galleryBatch = GalleryBatch(request.label, 0, items.size, waiting = true))
            }
            var queued = 0
            for (item in items) {
                while (unfinishedStagedCount() >= GALLERY_STAGING_WINDOW) {
                    // KEEP: no-op while a drainer runs, a fresh pass when none
                    // does — the batch can never strand what it queued.
                    UploadWorkScheduler.scheduleUploads(
                        context,
                        policyStore.load(),
                        UploadWorkScheduler.UploadItemKind.MANUAL,
                    )
                    _ui.update {
                        it.copy(galleryBatch = it.galleryBatch?.copy(waiting = true))
                    }
                    delay(GALLERY_WINDOW_POLL_MS)
                }
                val uri = item.uri.toUri()
                when (val staged = stager.stage(uri)) {
                    is ContentStager.StageResult.Success -> {
                        store.add(
                            queueItemFor(
                                registration = registration,
                                uri = uri,
                                displayName = item.displayName,
                                mimeType = item.mimeType,
                                sizeBytes = staged.sizeBytes,
                                dest = dest,
                                staged = staged,
                                now = System.currentTimeMillis(),
                            ),
                        )
                        queued += 1
                        UploadWorkScheduler.scheduleUploads(
                            context,
                            policyStore.load(),
                            UploadWorkScheduler.UploadItemKind.MANUAL,
                        )
                        _ui.update {
                            it.copy(
                                galleryBatch = GalleryBatch(
                                    folderLabel = request.label,
                                    queued = queued,
                                    total = items.size,
                                    waiting = queued < items.size,
                                ),
                            )
                        }
                    }
                    is ContentStager.StageResult.Failure -> {
                        _ui.update { it.copy(galleryBatch = null) }
                        message(
                            "${request.label}: queued $queued of ${items.size} — " +
                                stageFailureText(staged.reason),
                            isError = true,
                        )
                        return@launch
                    }
                }
            }
            _ui.update { it.copy(galleryBatch = null) }
            message(
                if (items.isEmpty()) {
                    "Nothing to upload in ${request.label}."
                } else {
                    "Queued $queued file${if (queued == 1) "" else "s"} from ${request.label}."
                },
            )
        }
        job.invokeOnCompletion { cause ->
            if (cause is CancellationException) {
                // The operator stopped the batch: report what made it into the
                // queue rather than pretending the folder completed.
                val queued = _ui.value.galleryBatch?.queued ?: 0
                val total = _ui.value.galleryBatch?.total ?: 0
                _ui.update { it.copy(galleryBatch = null) }
                message("Stopped queuing ${request.label} — $queued of $total files are queued.")
            }
        }
        galleryBatchJob = job
    }

    /**
     * Files already staged but not yet finished: the batch's disk window.
     * BLOCKED/FAILED/CANCELLED/DONE items leave the window, so a failing file
     * cannot stall the batch behind it.
     */
    private fun unfinishedStagedCount(): Int = _ui.value.items.count {
        it.staged && (it.status == UploadStatus.PENDING ||
            it.status == UploadStatus.UPLOADING ||
            it.status == UploadStatus.WAITING)
    }

    /** One queue item from a staged source. Shared by shares and gallery batches. */
    private fun queueItemFor(
        registration: Registration,
        uri: Uri,
        displayName: String,
        mimeType: String?,
        sizeBytes: Long,
        dest: MobileUploadDestinationDto,
        staged: ContentStager.StageResult.Success,
        now: Long,
    ): UploadQueueItem = UploadQueueItem(
        id = UUID.randomUUID().toString(),
        origin = registration.origin,
        hostId = registration.hostId,
        sourceUri = uri.toString(),
        displayName = displayName,
        mimeType = mimeType ?: uriMime(uri),
        sizeBytes = sizeBytes,
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

    private fun stageFailureText(reason: ContentStager.StageFailure): String = when (reason) {
        ContentStager.StageFailure.UNREADABLE -> "a file could not be read — it may no longer be available."
        ContentStager.StageFailure.TOO_LARGE -> "a file exceeds the local staging limit."
        ContentStager.StageFailure.NO_SPACE -> "there was not enough free storage to stage the next file."
        ContentStager.StageFailure.IO_ERROR -> "a file could not be staged locally."
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
        val gallery = pending.gallery
        if (gallery != null) {
            // A gallery folder's contents are enumerated at start, not held as
            // URIs — a roll of thousands has no business in a bundle.
            _ui.update { it.copy(pendingShare = null) }
            startGalleryBatch(registration, gallery, dest)
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
                when (val staged = stager.stage(uri)) {
                    is ContentStager.StageResult.Success -> {
                        store.add(
                            queueItemFor(
                                registration = registration,
                                uri = uri,
                                displayName = displayNameFor(uri, stager.targetName(uri)),
                                mimeType = uriMime(uri),
                                sizeBytes = staged.sizeBytes,
                                dest = dest,
                                staged = staged,
                                now = now,
                            ),
                        )
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
        updatePolicy { it.copy(unmeteredOnly = value) }
    }

    /**
     * LAMA-329 — the charging constraint was already enforced for manual
     * uploads (UploadWorkScheduler sets `setRequiresCharging` from the stored
     * policy) but had no way to be turned on. Settings owns the switch.
     */
    fun setChargingOnly(value: Boolean) {
        updatePolicy { it.copy(chargingOnly = value) }
    }

    private fun updatePolicy(transform: (UploadPolicy) -> UploadPolicy) {
        val policy = transform(policyStore.load())
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

    private companion object {
        /** Un-transferred staged files a gallery batch keeps on disk at once. */
        const val GALLERY_STAGING_WINDOW = 3

        /** How often the batch re-offers the drainer while the window is full. */
        const val GALLERY_WINDOW_POLL_MS = 1_000L

        const val UNPAIRED_MESSAGE =
            "Pair this device with a QR before sharing files. Your share was not queued."
        const val CREDENTIAL_LOST_MESSAGE =
            "This device's credential is missing — re-pair it, then share again. Your share was not queued."
        const val REVOKED_MESSAGE =
            "This device's upload access was revoked — re-pair to upload again."
        const val NO_INBOX_MESSAGE =
            "No upload inbox is assigned to this device yet. An administrator must assign one " +
                "from the desktop web UI (Admin → Android devices → Inboxes)."
    }

    private fun uriMime(uri: Uri): String? = context.contentResolver.getType(uri)
}
