package app.lamasync.companion.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.lamasync.companion.data.UploadPolicy
import app.lamasync.companion.data.UploadQueueItem
import app.lamasync.companion.data.UploadQueueStore
import app.lamasync.companion.data.UploadStatus
import app.lamasync.companion.media.AutoProtectSettings
import app.lamasync.companion.media.AutoWaitingReasons
import app.lamasync.companion.media.MediaCollection
import app.lamasync.companion.media.MediaCoverage
import app.lamasync.companion.media.MediaPermissionScope
import app.lamasync.companion.media.MediaPermissions
import app.lamasync.companion.media.MediaProtectionStore
import app.lamasync.companion.media.MediaRecord
import app.lamasync.companion.media.MediaRecordStatus
import app.lamasync.companion.media.ScopeMode
import app.lamasync.companion.work.AutoProtectWorkScheduler
import app.lamasync.companion.work.UploadWorkScheduler
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * LAMA-296 stage 2 — automatic-protection setup + status state.
 *
 * The ViewModel is an OBSERVER of the durable stores (the worker writes
 * them); it never runs the discovery/transfer itself. It derives the
 * trustworthy status surface:
 *  - coverage ("protected through") from the CONTIGUOUS completion model;
 *  - pending count/bytes from the auto (mediaIdentity-bound) queue items;
 *  - waiting reason + permission scope checked LIVE every time the screen
 *    is (re)rendered, never from stale storage.
 */
class AutoProtectViewModel(application: Application) : AndroidViewModel(application) {

    private val context = application
    private val recordStore = MediaProtectionStore.getInstance(context)
    private val queueStore = UploadQueueStore.getInstance(context)

    data class AutoProtectUiState(
        val settings: AutoProtectSettings = AutoProtectSettings(),
        val coverage: MediaCoverage.Snapshot = MediaCoverage.Snapshot(null),
        val pendingAutoCount: Long = 0L,
        val pendingAutoBytes: Long = 0L,
        /** Live per-collection permission scope (P0-3): each collection is
         *  checked independently; a denied collection is neither scanned nor
         *  counted as covered. */
        val scopes: Map<MediaCollection, MediaPermissionScope> =
            MediaCollection.entries.associateWith { MediaPermissionScope.NOT_GRANTED },
        val scopeGuidance: String = "",
        val message: String? = null,
        val messageIsError: Boolean = false,
        val busy: Boolean = false,
    )

    private val _ui = MutableStateFlow(AutoProtectUiState())
    val ui: StateFlow<AutoProtectUiState> = _ui.asStateFlow()

    private var initialized = false

    fun initialize() {
        if (initialized) return
        initialized = true
        // One merged collector: the pending figure derives from BOTH the media
        // records (records not yet staged because a destination/space/read
        // problem kept them out of the queue) and the queue's live transfer
        // progress — deduplicated by media identity so nothing counts twice.
        viewModelScope.launch {
            combine(recordStore.snapshots, queueStore.snapshots) { snap, queue -> snap to queue }
                .collect { (snap, queue) ->
                    val pending = derivePending(snap.records, queue.items)
                    _ui.update {
                        it.copy(
                            settings = snap.settings,
                            coverage = MediaCoverage.of(snap.records),
                            pendingAutoCount = pending.pendingCount,
                            pendingAutoBytes = pending.pendingBytes,
                        )
                    }
                }
        }
        refreshScope()
    }

    /** Permission scopes are always checked LIVE (docs: never stored). */
    fun refreshScope() {
        val scopes = MediaPermissions.currentScopes(context)
        _ui.update {
            it.copy(
                scopes = scopes,
                scopeGuidance = MediaPermissions.guidance(
                    when {
                        scopes.values.all { s -> s == MediaPermissionScope.FULL } -> MediaPermissionScope.FULL
                        scopes.values.any { s -> s != MediaPermissionScope.NOT_GRANTED } -> MediaPermissionScope.PARTIAL
                        else -> MediaPermissionScope.NOT_GRANTED
                    },
                ),
            )
        }
    }

    /** Called after the runtime permission request result. */
    fun onPermissionResult(granted: Map<String, Boolean>) {
        refreshScope()
        // Any full-access grant (or partial) re-arms the pipeline.
        if (granted.values.any { it }) {
            AutoProtectWorkScheduler.scheduleDiscovery(context)
        }
    }

    fun setCameraPhotos(enabled: Boolean) = setSource(enabled) {
        it.copy(cameraPhotosEnabled = enabled)
    }

    fun setCameraVideos(enabled: Boolean) = setSource(enabled) {
        it.copy(cameraVideosEnabled = enabled)
    }

    fun setScreenshots(enabled: Boolean) = setSource(enabled) {
        it.copy(screenshotsEnabled = enabled)
    }

    private fun setSource(enabled: Boolean, transform: (AutoProtectSettings) -> AutoProtectSettings) {
        val next = recordStore.updateSettings {
            transform(it).copy(updatedAtEpochMillis = System.currentTimeMillis())
        }
        refreshScope()
        AutoProtectWorkScheduler.rescheduleAfterConfigChange(context)
        if (enabled) {
            message("Automatic protection enabled — the first scan starts shortly.")
        } else {
            message("Source disabled. Already protected files stay on the server.")
        }
    }

    fun setScopeMode(mode: ScopeMode) {
        recordStore.updateSettings {
            it.copy(scopeMode = mode, updatedAtEpochMillis = System.currentTimeMillis())
        }
        AutoProtectWorkScheduler.rescheduleAfterConfigChange(context)
        if (mode == ScopeMode.EXISTING_HISTORY) {
            message("Existing history import scheduled — this can take a while on large libraries.")
        }
    }

    // ---- transfer policy (AUTOMATIC work only) ----

    /**
     * P1/P2 policy separation: these conditions govern AUTOMATIC protection
     * work only and live in [AutoProtectSettings]. They never write the
     * manual upload policy ([app.lamasync.companion.data.UploadPolicyStore]),
     * so selecting "Only while charging" here cannot delay an explicit
     * user-initiated share. Manual behavior is unchanged from stage 1.
     */
    fun setUnmeteredOnly(value: Boolean) = updateAutoPolicy { it.copy(unmeteredOnly = value) }

    fun setChargingOnly(value: Boolean) = updateAutoPolicy { it.copy(chargingOnly = value) }

    private fun updateAutoPolicy(transform: (UploadPolicy) -> UploadPolicy) {
        val next = recordStore.updateSettings {
            val p = transform(UploadPolicy(unmeteredOnly = it.unmeteredOnly, chargingOnly = it.chargingOnly))
            it.copy(
                unmeteredOnly = p.unmeteredOnly,
                chargingOnly = p.chargingOnly,
                updatedAtEpochMillis = System.currentTimeMillis(),
            )
        }
        // REPLACE semantics: the next drainer pass carries the new automatic
        // constraint. Re-arm discovery to apply the new policy immediately.
        UploadWorkScheduler.scheduleAutoUploads(
            context,
            UploadPolicy(unmeteredOnly = next.unmeteredOnly, chargingOnly = next.chargingOnly),
        )
        AutoProtectWorkScheduler.scheduleDiscovery(context)
    }

    /** Manual sync-now: prompt discovery + drain under the automatic policy. */
    fun syncNow() {
        if (_ui.value.busy) return
        _ui.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            AutoProtectWorkScheduler.rescheduleAfterConfigChange(context)
            val s = recordStore.load().settings
            UploadWorkScheduler.scheduleAutoUploads(
                context,
                UploadPolicy(unmeteredOnly = s.unmeteredOnly, chargingOnly = s.chargingOnly),
            )
            _ui.update { it.copy(busy = false) }
            message("Sync requested — media will upload when the automatic transfer conditions allow.")
        }
    }

    /** Human label for the persistent waiting reason (null = healthy). */
    fun waitingReasonText(): String? {
        val s = _ui.value.settings
        return AutoWaitingReasons.human(s.lastWaitingReason, _ui.value.pendingAutoCount)
    }

    private fun message(text: String, isError: Boolean = false) {
        _ui.update { it.copy(message = text, messageIsError = isError) }
    }

    fun dismissMessage() {
        _ui.update { it.copy(message = null) }
    }

    /**
     * Pure pending derivation (P1): a non-double-counting total from the
     * media records plus the queue's live progress, with the actionable
     * unreadable count kept separate.
     *
     * Records can be pending WITHOUT being in the queue (no Camera
     * destination, no staging space, unreadable source), so a queue-only
     * count can show 0 pending while coverage is blocked. Records and queue
     * items are unioned by media identity; the queue item's staged byte size
     * wins when both exist.
     */
    companion object {
        private val RECORD_PENDING = setOf(
            MediaRecordStatus.DISCOVERED,
            MediaRecordStatus.STAGED,
            MediaRecordStatus.FAILED,
            MediaRecordStatus.UNREADABLE,
        )
        private val QUEUE_PENDING = setOf(
            UploadStatus.PENDING,
            UploadStatus.UPLOADING,
            UploadStatus.WAITING,
            UploadStatus.BLOCKED,
            UploadStatus.FAILED,
        )

        data class PendingWork(
            val pendingCount: Long,
            val pendingBytes: Long,
            val unreadableCount: Long,
        )

        fun derivePending(
            records: List<MediaRecord>,
            items: List<UploadQueueItem>,
        ): PendingWork {
            val pendingBytesById = linkedMapOf<String, Long>()
            for (record in records) {
                if (record.status in RECORD_PENDING) {
                    pendingBytesById[record.identityKey] = (record.sizeBytes ?: 0L).coerceAtLeast(0L)
                }
            }
            for (item in items) {
                val identity = item.mediaIdentity ?: continue
                if (item.status in QUEUE_PENDING) {
                    pendingBytesById[identity] = (item.sizeBytes ?: 0L).coerceAtLeast(0L)
                }
            }
            return PendingWork(
                pendingCount = pendingBytesById.size.toLong(),
                pendingBytes = pendingBytesById.values.sum(),
                unreadableCount = records.count { it.status == MediaRecordStatus.UNREADABLE }.toLong(),
            )
        }
    }
}