package app.lamasync.companion.media

import android.content.Context
import app.lamasync.companion.data.NamedQueueStorage
import app.lamasync.companion.data.QueueStorage
import java.io.IOException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * LAMA-296 stage 2 — durable device-local automatic-protection state:
 * settings, discovery cursors and the media record registry. Serialized JSON
 * in an app-private SharedPreferences (sync `commit()` — the durable
 * boundary is on disk before any scan result is reported), excluded from
 * backup by `android:allowBackup="false"`.
 *
 * Writers serialize on ONE process-wide lock so the UI, the discovery
 * worker and the transfer worker mutate one coherent snapshot (same pattern
 * as [app.lamasync.companion.data.UploadQueueStore]); every mutation
 * re-emits the snapshot for live status UI.
 */
class MediaProtectionStore(private val storage: QueueStorage) {

    constructor(context: Context) : this(NamedQueueStorage(context, PREFS_NAME))

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private val _snapshots = MutableStateFlow(readSnapshot())
    val snapshots: StateFlow<MediaProtectionSnapshot> = _snapshots.asStateFlow()

    fun load(): MediaProtectionSnapshot = synchronized(GLOBAL_LOCK) { readSnapshot() }

    private fun readSnapshot(): MediaProtectionSnapshot {
        val raw = storage.read(KEY_SNAPSHOT) ?: return MediaProtectionSnapshot()
        return try {
            json.decodeFromString(MediaProtectionSnapshot.serializer(), raw)
        } catch (e: Exception) {
            // Corrupt durable state: fail safe to defaults rather than
            // crashing or re-submitting unknown work.
            MediaProtectionSnapshot()
        }
    }

    private fun writeSnapshot(snapshot: MediaProtectionSnapshot) {
        storage.write(KEY_SNAPSHOT, json.encodeToString(MediaProtectionSnapshot.serializer(), snapshot))
        _snapshots.value = snapshot
    }

    // ---- settings ----

    fun updateSettings(transform: (AutoProtectSettings) -> AutoProtectSettings): AutoProtectSettings {
        synchronized(GLOBAL_LOCK) {
            val current = readSnapshot()
            val next = transform(current.settings)
            writeSnapshot(current.copy(settings = next))
            return next
        }
    }

    // ---- cursors ----

    fun cursorFor(collection: MediaCollection, volume: String): MediaCursorState? =
        load().cursors.firstOrNull { it.collection == collection && it.volume == volume }

    fun updateCursors(updates: Collection<MediaCursorState>) {
        if (updates.isEmpty()) return
        synchronized(GLOBAL_LOCK) {
            val current = readSnapshot()
            val merged = current.cursors.toMutableList()
            for (u in updates) {
                merged.removeAll { it.collection == u.collection && it.volume == u.volume }
                merged += u
            }
            writeSnapshot(current.copy(cursors = merged))
        }
    }

    // ---- records ----

    fun recordFor(identityKey: String): MediaRecord? =
        load().records.firstOrNull { it.identityKey == identityKey }

    fun updateRecords(updates: Collection<MediaRecord>) {
        if (updates.isEmpty()) return
        synchronized(GLOBAL_LOCK) {
            val current = readSnapshot()
            val merged = current.records.toMutableList()
            for (u in updates) {
                merged.removeAll { it.identityKey == u.identityKey }
                merged += u
            }
            writeSnapshot(current.copy(records = merged))
        }
    }

    /**
     * Atomic page commit: persist the settings summary, cursor advances and
     * record updates in ONE durable write so a process death between
     * independent calls can never leave a half-applied scan page.
     */
    fun commitScanPage(
        settings: AutoProtectSettings,
        cursorUpdates: Collection<MediaCursorState>,
        recordUpdates: Collection<MediaRecord>,
    ) {
        synchronized(GLOBAL_LOCK) {
            val current = readSnapshot()
            val cursors = current.cursors.toMutableList()
            for (u in cursorUpdates) {
                cursors.removeAll { it.collection == u.collection && it.volume == u.volume }
                cursors += u
            }
            val records = current.records.toMutableList()
            for (u in recordUpdates) {
                records.removeAll { it.identityKey == u.identityKey }
                records += u
            }
            writeSnapshot(current.copy(settings = settings, cursors = cursors, records = records))
        }
    }

    fun clear() {
        synchronized(GLOBAL_LOCK) { writeSnapshot(MediaProtectionSnapshot()) }
    }

    companion object {
        private const val PREFS_NAME = "lamasync_auto_protect"
        private const val KEY_SNAPSHOT = "media_protection_v1"

        private val GLOBAL_LOCK = Any()

        @Volatile
        private var instance: MediaProtectionStore? = null

        /** Canonical process-wide instance (UI + workers share one live flow). */
        fun getInstance(context: Context): MediaProtectionStore {
            instance?.let { return it }
            synchronized(GLOBAL_LOCK) {
                instance?.let { return it }
                return MediaProtectionStore(NamedQueueStorage(context.applicationContext, PREFS_NAME)).also {
                    instance = it
                }
            }
        }
    }
}

/** The whole durable automatic-protection snapshot. */
@Serializable
data class MediaProtectionSnapshot(
    val settings: AutoProtectSettings = AutoProtectSettings(),
    val cursors: List<MediaCursorState> = emptyList(),
    val records: List<MediaRecord> = emptyList(),
)