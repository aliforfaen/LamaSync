package app.lamasync.companion.media

import kotlinx.coroutines.CancellationException

/**
 * LAMA-296 stage 2 — incremental MediaStore discovery and reconciliation.
 *
 * Pure orchestration over the [MediaCursorLibrary] seam: JVM tests drive it
 * with a fake library (cursor boundaries, race-safe new-only boundary,
 * deterministic existing-history import, changed/repeated media, deletion
 * detection). The Android worker feeds it the real MediaStore-backed
 * library.
 *
 * Honesty rules enforced here:
 *  - identity is `collection:<mediaId>@<volume>` — never a path;
 *  - deletions are recorded LOCALLY_DELETED only when the observed scope was
 *    FULL and the walk completed (under PARTIAL access a missing row only
 *    proves the row is not accessible, not deleted — recorded UNREADABLE);
 *  - changed content on a known identity is a new revision (re-stage +
 *    re-protect), never a silent skip;
 *  - interrupted scans (CancellationException / page failure) persist the
 *    page cursor up to the last COMPLETED page, so restart resumes instead
 *    of skipping or re-importing.
 *
 * Cursor semantics:
 *  - NEW_ONLY: watermark = the NEWEST row's `(date_added, _id)` captured
 *    BEFORE the first import query; rows strictly newer are imported
 *    (per-volume keys make _ID comparison meaningful). MediaStore's
 *    GENERATION column is not public before API 36, so the boundary uses the
 *    (date_added, _id) keyset instead; edits of ALREADY-KNOWN rows are
 *    caught by the knownRows reconciliation, not the walk.
 *  - EXISTING_HISTORY: a deterministic newest-first keyset walk; the cursor
 *    resumes after the last COMPLETED page; `fullScanCompleted` flips when
 *    the end is reached.
 */
class MediaDiscoveryEngine(
    private val library: MediaCursorLibrary,
    private val classifier: MediaClassifier = MediaClassifier,
) {

    data class ScanOutcome(
        /** Records that are new or changed — to stage/enqueue next. */
        val newRecords: List<MediaRecord>,
        /** Identities confirmed gone from the accessible collection. */
        val deletedIdentities: List<String>,
        /** Cursor positions to persist (last completed page per unit). */
        val cursorUpdates: Map<CursorKey, MediaCursorState>,
        /** True when a page failed or the walk was interrupted mid-scan. */
        val interrupted: Boolean,
    )

    data class CursorKey(val collection: MediaCollection, val volume: String)

    suspend fun scan(
        settings: AutoProtectSettings,
        cursors: Map<CursorKey, MediaCursorState>,
        existingRecords: Map<String, MediaRecord>,
        observedScope: MediaPermissionScope,
        pageSize: Int = DEFAULT_PAGE_SIZE,
    ): ScanOutcome {
        val newRecords = mutableListOf<MediaRecord>()
        val deletedIdentities = mutableListOf<String>()
        val cursorUpdates = mutableMapOf<CursorKey, MediaCursorState>()
        var interrupted = false
        val now = System.currentTimeMillis()

        for (collection in MediaCollection.entries) {
            if (!collectionNeeded(collection, settings)) continue
            val volumes = try {
                library.volumes(collection)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                interrupted = true
                continue
            }
            for (volume in volumes) {
                val key = CursorKey(collection, volume)
                val cursor = cursors[key] ?: MediaCursorState(
                    collection = collection,
                    volume = volume,
                    scopeMode = settings.scopeMode,
                )
                val (nextCursor, completed) = try {
                    when (settings.scopeMode) {
                        ScopeMode.NEW_ONLY -> scanNewOnly(
                            settings, collection, volume, cursor, existingRecords,
                            newRecords, pageSize, now,
                        )
                        ScopeMode.EXISTING_HISTORY -> scanExistingHistory(
                            settings, collection, volume, cursor, existingRecords,
                            newRecords, pageSize, now,
                        )
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Page failure: keep the last completed cursor.
                    cursor to false
                }
                if (!completed) interrupted = true

                // Reconcile known identities via direct _ID lookups (robust
                // for BOTH modes: a new-only walk never revisits old rows).
                val known = existingRecords.values.filter {
                    it.collection == collection &&
                        it.volume == volume &&
                        it.status != MediaRecordStatus.LOCALLY_DELETED
                }
                val metaById = knownMetaFor(collection, volume, known.map { it.mediaId })
                for (record in known) {
                    val meta = metaById[record.mediaId]
                    if (meta != null) {
                        // Row exists. Changed content (size delta) re-protects
                        // the revision; unchanged rows are kept as-is.
                        if (meta.sizeBytes != null && record.sizeBytes != null &&
                            meta.sizeBytes != record.sizeBytes
                        ) {
                            newRecords += revisionOf(record, meta.sizeBytes, now)
                        }
                        continue
                    }
                    // Row absent from the accessible collection right now.
                    if (completed && observedScope == MediaPermissionScope.FULL) {
                        deletedIdentities += record.identityKey
                    } else if (observedScope == MediaPermissionScope.PARTIAL) {
                        newRecords += record.copy(
                            status = MediaRecordStatus.UNREADABLE,
                            error = "This media is no longer accessible under selected-photos access. Grant full access.",
                            updatedAtEpochMillis = now,
                        )
                    }
                }

                cursorUpdates[key] = nextCursor
            }
        }
        return ScanOutcome(
            newRecords = newRecords,
            deletedIdentities = deletedIdentities,
            cursorUpdates = cursorUpdates,
            interrupted = interrupted,
        )
    }

    // ---- per-mode walks (return the durable cursor + completion flag) ----

    private suspend fun scanNewOnly(
        settings: AutoProtectSettings,
        collection: MediaCollection,
        volume: String,
        cursor: MediaCursorState,
        existingRecords: Map<String, MediaRecord>,
        newRecords: MutableList<MediaRecord>,
        pageSize: Int,
        now: Long,
    ): Pair<MediaCursorState, Boolean> {
        // Boundary = the newest row at boundary time (captured BEFORE the
        // first import query — race-safe: rows present at capture have keys
        // <= the boundary, rows inserted afterwards have larger keys).
        val newest = library.newestKey(collection, volume)
        val boundaryDate = cursor.watermarkDateAdded ?: newest?.dateAdded
        val boundaryId = cursor.watermarkId ?: newest?.mediaId
        var afterKey: PageKey? = null
        var loop = true
        while (loop) {
            val rows = library.queryNewestFirst(collection, volume, afterKey, pageSize)
            for (row in rows) {
                val isNew = boundaryDate == null || boundaryId == null ||
                    row.dateAddedSeconds > boundaryDate ||
                    (row.dateAddedSeconds == boundaryDate && row.mediaId > boundaryId)
                if (isNew) {
                    whenRecord(settings, collection, volume, row, existingRecords, newRecords, now)
                }
            }
            if (rows.size < pageSize) {
                loop = false
            } else {
                afterKey = rowKeyOf(rows.last())
            }
        }
        return cursor.copy(
            scopeMode = settings.scopeMode,
            watermarkDateAdded = boundaryDate,
            watermarkId = boundaryId,
            updatedAtEpochMillis = now,
        ) to true
    }

    private suspend fun scanExistingHistory(
        settings: AutoProtectSettings,
        collection: MediaCollection,
        volume: String,
        cursor: MediaCursorState,
        existingRecords: Map<String, MediaRecord>,
        newRecords: MutableList<MediaRecord>,
        pageSize: Int,
        now: Long,
    ): Pair<MediaCursorState, Boolean> {
        var afterKey: PageKey? = cursor.watermarkDateAdded?.let { d ->
            cursor.watermarkId?.let { i -> PageKey(d, i) }
        }
        var loop = true
        var lastCursor = cursor
        while (loop) {
            val rows = library.queryNewestFirst(collection, volume, afterKey, pageSize)
            for (row in rows) {
                whenRecord(settings, collection, volume, row, existingRecords, newRecords, now)
            }
            val finished = rows.size < pageSize
            afterKey = if (finished) null else rowKeyOf(rows.last())
            // Persist after every completed page: process death resumes from
            // the keyset position instead of re-importing.
            lastCursor = cursor.copy(
                scopeMode = settings.scopeMode,
                watermarkDateAdded = afterKey?.dateAdded ?: cursor.watermarkDateAdded,
                watermarkId = afterKey?.mediaId ?: cursor.watermarkId,
                fullScanCompleted = finished,
                updatedAtEpochMillis = now,
            )
            if (finished) break
        }
        return lastCursor to true
    }

    // ---- record construction ----

    private fun whenRecord(
        settings: AutoProtectSettings,
        collection: MediaCollection,
        volume: String,
        row: MediaRow,
        existingRecords: Map<String, MediaRecord>,
        newRecords: MutableList<MediaRecord>,
        now: Long,
    ) {
        val classification = classifier.classify(row.relativePath, row.dataPath)
        val source = classifier.sourceOf(
            classification = classification,
            collection = collection,
            cameraPhotosEnabled = settings.cameraPhotosEnabled,
            cameraVideosEnabled = settings.cameraVideosEnabled,
            screenshotsEnabled = settings.screenshotsEnabled,
        ) ?: return
        val identity = identityKey(collection, volume, row.mediaId)
        val existing = existingRecords[identity]
        val base = MediaRecord(
            identityKey = identity,
            mediaId = row.mediaId,
            volume = volume,
            collection = collection,
            source = source,
            uri = row.uri,
            displayName = row.displayName,
            sizeBytes = row.sizeBytes,
            mimeType = row.mimeType,
            relativePath = row.relativePath,
            dateAddedSeconds = row.dateAddedSeconds,
            dateTakenMillis = row.dateTakenMillis,
            discoveredAtEpochMillis = now,
            updatedAtEpochMillis = now,
        )
        if (existing == null || existing.status == MediaRecordStatus.LOCALLY_DELETED) {
            // New identity (or a reappeared one): stage + protect.
            newRecords += base.copy(discoveredAtEpochMillis = existing?.discoveredAtEpochMillis ?: now)
            return
        }
        if (existing.uri != base.uri || existing.displayName != base.displayName) {
            // Same identity but the source moved/renamed: actionable state.
            newRecords += base.copy(
                discoveredAtEpochMillis = existing.discoveredAtEpochMillis,
                status = MediaRecordStatus.UNREADABLE,
                error = "This media moved or was renamed. Re-check its current location.",
            )
            return
        }
        // Content changed (size delta) vs the recorded revision.
        if (row.sizeBytes != null && existing.sizeBytes != null && row.sizeBytes != existing.sizeBytes) {
            newRecords += revisionOf(existing, row.sizeBytes, now)
        }
    }

    private fun revisionOf(record: MediaRecord, newSize: Long, now: Long): MediaRecord {
        val previous = buildList {
            record.receiptPath?.let { add(it) }
            addAll(record.previousProtectedPaths)
        }.take(MAX_PROVENANCE)
        return record.copy(
            sizeBytes = newSize,
            sha256 = null,
            status = MediaRecordStatus.DISCOVERED,
            queueItemId = null,
            receiptPath = null,
            previousProtectedPaths = previous,
            error = null,
            stagedAtEpochMillis = null,
            protectedAtEpochMillis = null,
            updatedAtEpochMillis = now,
        )
    }

    private suspend fun knownMetaFor(
        collection: MediaCollection,
        volume: String,
        ids: List<Long>,
    ): Map<Long, KnownRowMeta> =
        if (ids.isEmpty()) emptyMap()
        else library.knownRows(collection, volume, ids).associateBy { it.mediaId }

    private fun rowKeyOf(row: MediaRow): PageKey = PageKey(row.dateAddedSeconds, row.mediaId)

    private fun collectionNeeded(collection: MediaCollection, settings: AutoProtectSettings): Boolean =
        when (collection) {
            MediaCollection.IMAGES -> settings.cameraPhotosEnabled || settings.screenshotsEnabled
            MediaCollection.VIDEOS -> settings.cameraVideosEnabled || settings.screenshotsEnabled
        }

    companion object {
        const val DEFAULT_PAGE_SIZE = 200
        private const val MAX_PROVENANCE = 20

        /** Stable identity — collection, MediaStore _ID and volume. Never a
         *  path: stable across reboots and storage-path changes. */
        fun identityKey(collection: MediaCollection, volume: String, mediaId: Long): String =
            "${collection.name.lowercase()}:$mediaId@$volume"

        fun parseMediaId(identityKey: String): Long? =
            identityKey.substringAfter(':', "").substringBefore('@').toLongOrNull()
    }
}