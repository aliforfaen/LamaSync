package app.lamasync.companion.data

import android.content.Context
import java.io.IOException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json

/** Pluggable string-key/value persistence so JVM tests can exercise the
 *  queue without Android. The default is SharedPreferences. */
interface QueueStorage {
    fun read(key: String): String?
    fun write(key: String, value: String)
}

/**
 * SharedPreferences-backed [QueueStorage]. Writes are SYNCHRONOUS (commit(),
 * never apply()): the LAMA-296 stage-1 correction requires the queue state
 * to be durably on disk before the caller hands an item to WorkManager or
 * reports an intake/cancel result to the UI — apply() only promised eventual
 * persistence and could lose the durable boundary after process death.
 */
class PrefsQueueStorage(context: Context) : QueueStorage {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun read(key: String): String? = prefs.getString(key, null)

    override fun write(key: String, value: String) {
        if (!prefs.edit().putString(key, value).commit()) {
            throw IOException("Could not persist the upload queue")
        }
    }

    companion object {
        const val PREFS_NAME = "lamasync_upload_queue"
    }
}

/** [QueueStorage] over an arbitrary prefs file (stage 2 reuses the same
 *  durable string-key store for auto-protect settings/registry). */
class NamedQueueStorage(context: Context, prefsName: String) : QueueStorage {
    private val prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)

    override fun read(key: String): String? = prefs.getString(key, null)

    override fun write(key: String, value: String) {
        if (!prefs.edit().putString(key, value).commit()) {
            throw IOException("Could not persist durable state")
        }
    }
}

/**
 * Durable upload queue (SharedPreferences + kotlinx.serialization). This is
 * the source of truth the transfer executor and the UI both read; state
 * survives process death and reboot (app opts out of backup entirely, so the
 * queue never leaves the device). Items bind to the enrollment identity at
 * intake (see [UploadQueueItem]) — a disconnect/re-pair never redirects old
 * uploads to a new device or server.
 *
 * LAMA-296 stage-1 correction (R1): every mutation serializes on ONE
 * process-wide lock (companion [GLOBAL_LOCK]) and re-reads the persisted
 * snapshot inside it, so ANY number of store instances (the ViewModel, the
 * WorkManager worker, tests) mutate one coherent snapshot. A worker progress
 * write can never race a UI add/cancel/remove into a lost whole-snapshot
 * update. Every mutation also publishes the latest snapshot on [snapshots],
 * which the UI collects for LIVE worker progress/completion — no activity
 * recreation or unrelated UI action required.
 *
 * LAMA-296 stage-1 correction (R2): [update] refuses to resurrect terminal
 * states. Once an item is durably CANCELLED (or DONE), a stale worker write
 * (UPLOADING/FAILED/BLOCKED/DONE from a pre-cancel object) is ignored — the
 * store keeps the authoritative state. The one allowed escape hatch is
 * CANCELLED → DONE, which only the server-authoritative cancel result uses
 * (a cancel that lost the race to finalize must not lie that the upload was
 * cancelled while the file is protected).
 */
class UploadQueueStore(private val storage: QueueStorage) {

    constructor(context: Context) : this(PrefsQueueStorage(context))

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    /** Latest durable snapshot, re-emitted on every mutation. */
    private val _snapshots = MutableStateFlow(readSnapshot())
    val snapshots: StateFlow<UploadQueueSnapshot> = _snapshots.asStateFlow()

    fun load(): UploadQueueSnapshot = synchronized(GLOBAL_LOCK) { readSnapshot() }

    private fun readSnapshot(): UploadQueueSnapshot {
        val raw = storage.read(KEY_QUEUE) ?: return UploadQueueSnapshot()
        return try {
            json.decodeFromString(UploadQueueSnapshot.serializer(), raw)
        } catch (e: Exception) {
            // Corrupt serialization: fail safe to an empty queue rather than
            // crashing or silently re-submitting unknown work.
            UploadQueueSnapshot()
        }
    }

    private fun writeSnapshot(snapshot: UploadQueueSnapshot) {
        storage.write(KEY_QUEUE, json.encodeToString(UploadQueueSnapshot.serializer(), snapshot))
        _snapshots.value = snapshot
    }

    /** Replace one item (matched by id) and persist. Returns the resulting
     *  list. Terminal-state guard (R2): a stale write can never overwrite a
     *  durably CANCELLED item (except the server-authoritative CANCELLED →
     *  DONE reconciliation) and never resurrects a DONE item. */
    fun update(item: UploadQueueItem): List<UploadQueueItem> {
        synchronized(GLOBAL_LOCK) {
            val current = readSnapshot().items
            val existing = current.firstOrNull { it.id == item.id }
            if (existing != null) {
                if (existing.status == UploadStatus.CANCELLED &&
                    item.status != UploadStatus.CANCELLED &&
                    item.status != UploadStatus.DONE
                ) {
                    // Stale worker write racing the user's cancel: keep the
                    // authoritative CANCELLED state.
                    return current
                }
                if (existing.status == UploadStatus.DONE && item.status != UploadStatus.DONE) {
                    return current
                }
            }
            val next = current.map { if (it.id == item.id) item else it }
            writeSnapshot(UploadQueueSnapshot(next))
            return next
        }
    }

    fun add(item: UploadQueueItem): List<UploadQueueItem> {
        synchronized(GLOBAL_LOCK) {
            val current = readSnapshot().items
            val next = listOf(item) + current
            writeSnapshot(UploadQueueSnapshot(next))
            return next
        }
    }

    fun remove(itemId: String): List<UploadQueueItem> {
        synchronized(GLOBAL_LOCK) {
            val current = readSnapshot().items
            val next = current.filterNot { it.id == itemId }
            writeSnapshot(UploadQueueSnapshot(next))
            return next
        }
    }

    fun replaceAll(items: List<UploadQueueItem>) {
        synchronized(GLOBAL_LOCK) { writeSnapshot(UploadQueueSnapshot(items)) }
    }

    /** The currently queued/pending (non-terminal) items, oldest first. */
    fun pendingItems(): List<UploadQueueItem> =
        synchronized(GLOBAL_LOCK) {
            readSnapshot().items
                .filter {
                    it.status == UploadStatus.PENDING ||
                        it.status == UploadStatus.UPLOADING ||
                        it.status == UploadStatus.WAITING ||
                        it.status == UploadStatus.FAILED ||
                        it.status == UploadStatus.BLOCKED
                }
                .sortedBy { it.createdAtEpochMillis }
        }

    fun clear() {
        synchronized(GLOBAL_LOCK) { writeSnapshot(UploadQueueSnapshot()) }
    }

    companion object {
        private const val KEY_QUEUE = "queue_v1"

        /** Process-wide mutation lock: one writer at a time across every
         *  store instance (ViewModel, worker, tests) in this process. */
        private val GLOBAL_LOCK = Any()

        @Volatile
        private var instance: UploadQueueStore? = null

        /** The canonical process-wide store instance. The ViewModel and the
         *  WorkManager worker BOTH use it, so every mutation fans out to ONE
         *  [snapshots] flow — worker progress/completion is live in the UI
         *  with no activity recreation (R1). */
        fun getInstance(context: Context): UploadQueueStore {
            instance?.let { return it }
            synchronized(GLOBAL_LOCK) {
                instance?.let { return it }
                return UploadQueueStore(PrefsQueueStorage(context.applicationContext)).also {
                    instance = it
                }
            }
        }
    }
}
