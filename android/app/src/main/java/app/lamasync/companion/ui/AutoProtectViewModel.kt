package app.lamasync.companion.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.lamasync.companion.data.UploadPolicy
import app.lamasync.companion.data.UploadPolicyStore
import app.lamasync.companion.data.UploadQueueStore
import app.lamasync.companion.media.AutoProtectSettings
import app.lamasync.companion.media.AutoWaitingReasons
import app.lamasync.companion.media.MediaCoverage
import app.lamasync.companion.media.MediaPermissionScope
import app.lamasync.companion.media.MediaPermissions
import app.lamasync.companion.media.MediaProtectionStore
import app.lamasync.companion.media.ScopeMode
import app.lamasync.companion.work.AutoProtectWorkScheduler
import app.lamasync.companion.work.UploadWorkScheduler
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
    private val policyStore = UploadPolicyStore(context)

    data class AutoProtectUiState(
        val settings: AutoProtectSettings = AutoProtectSettings(),
        val coverage: MediaCoverage.Snapshot = MediaCoverage.Snapshot(null),
        val pendingAutoCount: Long = 0L,
        val pendingAutoBytes: Long = 0L,
        val scope: MediaPermissionScope = MediaPermissionScope.NOT_GRANTED,
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
        viewModelScope.launch {
            recordStore.snapshots.collect { snap ->
                _ui.update { current ->
                    current.copy(
                        settings = snap.settings,
                        coverage = MediaCoverage.of(snap.records),
                        pendingAutoCount = pendingAutoCount(),
                        pendingAutoBytes = pendingAutoBytes(),
                    )
                }
            }
        }
        viewModelScope.launch {
            queueStore.snapshots.collect { snap ->
                val auto = snap.items.filter { it.mediaIdentity != null }
                _ui.update {
                    it.copy(
                        pendingAutoCount = auto.count { i ->
                            i.status != app.lamasync.companion.data.UploadStatus.DONE &&
                                i.status != app.lamasync.companion.data.UploadStatus.CANCELLED
                        }.toLong(),
                        pendingAutoBytes = auto.sumOf { i ->
                            if (i.status == app.lamasync.companion.data.UploadStatus.DONE ||
                                i.status == app.lamasync.companion.data.UploadStatus.CANCELLED
                            ) {
                                0L
                            } else {
                                (i.sizeBytes ?: 0L).coerceAtLeast(0L)
                            }
                        },
                    )
                }
            }
        }
        refreshScope()
    }

    /** Permission scope is always checked LIVE (docs: never stored). */
    fun refreshScope() {
        val scope = MediaPermissions.current(context)
        _ui.update {
            it.copy(
                scope = scope,
                scopeGuidance = MediaPermissions.guidance(scope),
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

    fun setUnmeteredOnly(value: Boolean) {
        val policy = UploadPolicy(
            unmeteredOnly = value,
            chargingOnly = _ui.value.settings.chargingOnly,
        )
        applyPolicy(policy)
    }

    fun setChargingOnly(value: Boolean) {
        val policy = UploadPolicy(
            unmeteredOnly = _ui.value.settings.unmeteredOnly,
            chargingOnly = value,
        )
        applyPolicy(policy)
    }

    private fun applyPolicy(policy: UploadPolicy) {
        policyStore.save(policy)
        recordStore.updateSettings {
            it.copy(
                unmeteredOnly = policy.unmeteredOnly,
                chargingOnly = policy.chargingOnly,
                updatedAtEpochMillis = System.currentTimeMillis(),
            )
        }
        // REPLACE the drainer so the constraint actually takes effect (R6);
        // re-arm discovery to apply the new policy immediately.
        UploadWorkScheduler.rescheduleWithPolicy(context, policy)
        AutoProtectWorkScheduler.scheduleDiscovery(context)
    }

    /** Manual sync-now: prompt discovery + drain. */
    fun syncNow() {
        if (_ui.value.busy) return
        _ui.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            AutoProtectWorkScheduler.rescheduleAfterConfigChange(context)
            val policy = policyStore.load()
            UploadWorkScheduler.scheduleUploads(context, policy)
            _ui.update { it.copy(busy = false) }
            message("Sync requested — media will upload when the network/charging conditions allow.")
        }
    }

    /** Human label for the persistent waiting reason (null = healthy). */
    fun waitingReasonText(): String? {
        val s = _ui.value.settings
        return AutoWaitingReasons.human(s.lastWaitingReason, _ui.value.pendingAutoCount)
    }

    private fun pendingAutoCount(): Long =
        queueStore.load().items.count { i ->
            i.mediaIdentity != null &&
                i.status != app.lamasync.companion.data.UploadStatus.DONE &&
                i.status != app.lamasync.companion.data.UploadStatus.CANCELLED
        }.toLong()

    private fun pendingAutoBytes(): Long =
        queueStore.load().items.sumOf { i ->
            if (i.mediaIdentity == null ||
                i.status == app.lamasync.companion.data.UploadStatus.DONE ||
                i.status == app.lamasync.companion.data.UploadStatus.CANCELLED
            ) {
                0L
            } else {
                (i.sizeBytes ?: 0L).coerceAtLeast(0L)
            }
        }

    private fun message(text: String, isError: Boolean = false) {
        _ui.update { it.copy(message = text, messageIsError = isError) }
    }

    fun dismissMessage() {
        _ui.update { it.copy(message = null) }
    }
}