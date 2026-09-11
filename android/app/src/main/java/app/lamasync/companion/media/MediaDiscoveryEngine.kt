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
 *  - PERMISSION AUTHORITY IS PER COLLECTION. A collection whose read
 *    permission is denied is never scanned, never declared deleted, and
 *    never counted as covered. `READ_MEDIA_IMAGES` grants FULL authority
 *    over the IMAGES collection only; `READ_MEDIA_VIDEO` over VIDEOS only;
 *    a denied collection simply does not exist for discovery (P0-3).
 *  - LOCALLY_DELETED is only a satisfied, honest claim for a revision that
 *    was already verified PROTECTED. A source that disappeared BEFORE it
 *    reached the server is never counted as covered: DISCOVERED/FAILED/
 *    UNREADABLE rows become UNREADABLE (action required / lost), and a
 *    STAGED row keeps its private staging copy and the upload finishes
 *    from there — it is never silently marked satisfied (P0-2).
 *  - changed content on a known identity is a new revision (re-stage +
 *    re-protect), never a silent skip. The revision signal is
 *    size OR date-modified; staging then gives each detected revision an
 *    exact content SHA. Providers that expose neither metadata change cannot
 *    be detected without re-reading every media item (documented limit).
 *  - interrupted scans persist a page cursor after every COMPLETED page
 *    (process-death resume without skipping files).
 *
 * Cursor semantics:
 *  - NEW_ONLY: watermark = the NEWEST row's `(date_added, _id)` captured
 *    BEFORE the first import query; rows strictly newer are imported.
 *  - EXISTING_HISTORY: a deterministic newest-first keyset walk that completes
 *    into a retained high-water boundary; later scans do an incremental-new
 *    pass over rows newer than that boundary while reconciliation still
 *    handles known rows (P0-4).
 */
class MediaDiscoveryEngine(
    private val library: MediaCursorLibrary,
    private val classifier: MediaClassifier = MediaClassifier,
) {

    data class ScanOutcome(
        /** Records that are new or changed — to stage/enqueue next. */
        val newRecords: List<MediaRecord>,
        /** Identities confirmed gone AND already verified PROTECTED. */
        val deletedIdentities: List<String>,
        /** Cursor positions to persist (last completed page per unit). */
        val cursorUpdates: Map<CursorKey, MediaCursorState>,
        /** True when a page failed or the walk was interrupted mid-scan. */
        val interrupted: Boolean,
    )

    /**
     * Fired after each COMPLETED page with the durable cursor and the records
     * discovered in that page, so the caller can atomically persist them —
     * a process death after a completed page resumes without skipping files.
     */
    data class PageCommit(
        val cursor: MediaCursorState,
        val newRecords: List<MediaRecord>,
    )

    data class CursorKey(val collection: MediaCollection, val volume: String)

    suspend fun scan(
        settings: AutoProtectSettings,
        cursors: Map<CursorKey, MediaCursorState>,
        existingRecords: Map<String, MediaRecord>,
        scopeByCollection: Map<MediaCollection, MediaPermissionScope>,
        pageSize: Int = DEFAULT_PAGE_SIZE,
        onPage: suspend (PageCommit) -> Unit = {},
    ): ScanOutcome {
        val newRecords = mutableListOf<MediaRecord>()
        val deletedIdentities = mutableListOf<String>()
        val cursorUpdates = mutableMapOf<CursorKey, MediaCursorState>()
        var interrupted = false
        val now = System.currentTimeMillis()

        for (collection in MediaCollection.entries) {
            if (!collectionNeeded(collection, settings)) continue
            // P0-3: a collection we cannot access is skipped entirely — we
            // must not scan it, declare its rows deleted, or count it covered.
            val scope = scopeByCollection[collection] ?: MediaPermissionScope.NOT_GRANTED
            if (scope == MediaPermissionScope.NOT_GRANTED) continue
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
                            newRecords, pageSize, now, onPage,
                        )
                        ScopeMode.EXISTING_HISTORY -> scanExistingHistory(
                            settings, collection, volume, cursor, existingRecords,
                            newRecords, pageSize, now, onPage,
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
                        // Row exists. Changed content (size OR date-modified
                        // delta) re-protects the revision; unchanged rows are
                        // kept as-is (P0-add: same-size edits are detected).
                        val sizeChanged = meta.sizeBytes != null && record.sizeBytes != null &&
                            meta.sizeBytes != record.sizeBytes
                        val modifiedChanged = meta.dateModifiedSeconds != null &&
                            record.dateModifiedSeconds != null &&
                            meta.dateModifiedSeconds != record.dateModifiedSeconds
                        if (sizeChanged || modifiedChanged) {
                            newRecords += revisionOf(record, meta.sizeBytes, meta.dateModifiedSeconds, now)
                        }
                        continue
                    }
                    // Row absent from the accessible collection right now.
                    when (val decision = absenceDecision(record, scope, completed)) {
                        AbsenceDecision.LOCAL_DELETE -> deletedIdentities += record.identityKey
                        AbsenceDecision.LOST_FULL -> newRecords += record.copy(
                            status = MediaRecordStatus.UNREADABLE,
                            error = "This media disappeared before it was protected. " +
                                "Restore it or it stays unprotected; already protected copies are untouched.",
                            updatedAtEpochMillis = now,
                        )
                        AbsenceDecision.LOST_PARTIAL -> newRecords += record.copy(
                            status = MediaRecordStatus.UNREADABLE,
                            error = "This media is no longer accessible under selected-photos access. Grant full access.",
                            updatedAtEpochMillis = now,
                        )
                        AbsenceDecision.KEEP -> Unit
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

    /** How an absent known row should be reconciled under a given scope. */
    private enum class AbsenceDecision { LOCAL_DELETE, LOST_FULL, LOST_PARTIAL, KEEP }

    private fun absenceDecision(
        record: MediaRecord,
        scope: MediaPermissionScope,
        completed: Boolean,
    ): AbsenceDecision = when (scope) {
        MediaPermissionScope.NOT_GRANTED -> AbsenceDecision.KEEP
        MediaPermissionScope.FULL -> {
            // Only a verified-PROTECTED revision may be claimed satisfied via
            // LOCALLY_DELETED; otherwise the local source is genuinely gone
            // before protection and we must not advance coverage.
            if (record.status == MediaRecordStatus.PROTECTED && completed) {
                AbsenceDecision.LOCAL_DELETE
            } else if (record.status == MediaRecordStatus.STAGED) {
                // Private staged copy still exists; the upload finishes from
                // there regardless of the source's local fate.
                AbsenceDecision.KEEP
            } else if (completed) {
                AbsenceDecision.LOST_FULL
            } else {
                AbsenceDecision.KEEP
            }
        }
        MediaPermissionScope.PARTIAL -> {
            // Accessible-subset access only. A verified/Staged revision keeps
            // its satisfied-or-in-flight status; a not-yet-protected row is
            // honestly marked unreadable (could be deselected or deleted).
            if (record.status == MediaRecordStatus.PROTECTED ||
                record.status == MediaRecordStatus.STAGED
            ) {
                AbsenceDecision.KEEP
            } else {
                AbsenceDecision.LOST_PARTIAL
            }
        }
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
        onPage: suspend (PageCommit) -> Unit,
    ): Pair<MediaCursorState, Boolean> {
        // Boundary = the newest row at boundary time (captured BEFORE the
        // first import query — race-safe: rows present at capture have keys
        // <= the boundary, rows inserted afterwards have larger keys).
        val newest = library.newestKey(collection, volume)
        val boundaryDate = cursor.watermarkDateAdded ?: newest?.dateAdded
        val boundaryId = cursor.watermarkId ?: newest?.mediaId
        var afterKey: PageKey? = null
        var loop = true
        val durableCursor = cursor.copy(
            scopeMode = settings.scopeMode,
            watermarkDateAdded = boundaryDate,
            watermarkId = boundaryId,
            updatedAtEpochMillis = now,
        )
        while (loop) {
            val rows = try {
                library.queryNewestFirst(collection, volume, afterKey, pageSize)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Page failure: keep the last completed cursor; nothing
                // committed for the failed page, nothing can be skipped.
                return durableCursor to false
            }
            val pageRecords = mutableListOf<MediaRecord>()
            for (row in rows) {
                val isNew = boundaryDate == null || boundaryId == null ||
                    row.dateAddedSeconds > boundaryDate ||
                    (row.dateAddedSeconds == boundaryDate && row.mediaId > boundaryId)
                if (isNew) {
                    whenRecord(settings, collection, volume, row, existingRecords, pageRecords, now)
                }
            }
            newRecords += pageRecords
            // Per-page durable commit boundary (process-death resume without
            // skipping files): persist this page's records + the stable cursor.
            onPage(PageCommit(durableCursor, pageRecords.toList()))
            if (rows.size < pageSize) {
                loop = false
            } else {
                afterKey = rowKeyOf(rows.last())
            }
        }
        return durableCursor to true
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
        onPage: suspend (PageCommit) -> Unit,
    ): Pair<MediaCursorState, Boolean> {
        // P0-4: once a backfill completed, retain the high-water boundary and
        // do an incremental-new pass on later scans; reconciliation still
        // handles known rows below. The high-water boundary stays FIXED (the
        // race-safe choice: rows inserted mid-scan have larger keys and are
        // imported by the next pass; dedup keeps re-reads exactly-once).
        if (cursor.fullScanCompleted) {
            val materialized = cursor.copy(
                watermarkDateAdded = cursor.watermarkDateAdded ?: 0L,
                watermarkId = cursor.watermarkId ?: 0L,
            )
            return scanNewOnly(
                settings, collection, volume, materialized, existingRecords,
                newRecords, pageSize, now, onPage,
            )
        }

        // Backfill: walk from the TOP until the walk completes. Re-walking
        // after an interruption is safe — [whenRecord] dedupes known rows —
        // so nothing is ever skipped and nothing is imported twice. The
        // boundary for the FIRST incremental pass is captured BEFORE the walk
        // so rows inserted mid-walk are never folded into it.
        val highAtStart = library.newestKey(collection, volume)
        var afterKey: PageKey? = null
        var loop = true
        var lastCursor = cursor
        while (loop) {
            val rows = try {
                library.queryNewestFirst(collection, volume, afterKey, pageSize)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Page failure: keep the last COMPLETED page cursor.
                return lastCursor to false
            }
            val pageRecords = mutableListOf<MediaRecord>()
            for (row in rows) {
                whenRecord(settings, collection, volume, row, existingRecords, pageRecords, now)
            }
            newRecords += pageRecords
            val finished = rows.size < pageSize
            afterKey = if (finished) null else rowKeyOf(rows.last())
            // Persist after every completed page: process death resumes from
            // the keyset position instead of re-importing (the commit carries
            // the page's records with it, so no file can be skipped). The
            // final page commits the COMPLETED cursor with the retained
            // high-water boundary.
            lastCursor = if (finished) {
                cursor.copy(
                    scopeMode = settings.scopeMode,
                    watermarkDateAdded = highAtStart?.dateAdded ?: cursor.watermarkDateAdded,
                    watermarkId = highAtStart?.mediaId ?: cursor.watermarkId,
                    fullScanCompleted = true,
                    updatedAtEpochMillis = now,
                )
            } else {
                cursor.copy(
                    scopeMode = settings.scopeMode,
                    watermarkDateAdded = afterKey?.dateAdded ?: cursor.watermarkDateAdded,
                    watermarkId = afterKey?.mediaId ?: cursor.watermarkId,
                    fullScanCompleted = false,
                    updatedAtEpochMillis = now,
                )
            }
            onPage(PageCommit(lastCursor, pageRecords.toList()))
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
            dateModifiedSeconds = row.dateModifiedSeconds,
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
        // Content changed (size or date-modified delta) vs the recorded
        // revision.
        if ((row.sizeBytes != null && existing.sizeBytes != null && row.sizeBytes != existing.sizeBytes) ||
            (row.dateModifiedSeconds != null && existing.dateModifiedSeconds != null &&
                row.dateModifiedSeconds != existing.dateModifiedSeconds)
        ) {
            newRecords += revisionOf(existing, row.sizeBytes, row.dateModifiedSeconds, now)
        }
    }

    private fun revisionOf(record: MediaRecord, newSize: Long?, newModified: Long?, now: Long): MediaRecord {
        val previous = buildList {
            record.receiptPath?.let { add(it) }
            addAll(record.previousProtectedPaths)
        }.take(MAX_PROVENANCE)
        return record.copy(
            sizeBytes = newSize,
            dateModifiedSeconds = newModified,
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
