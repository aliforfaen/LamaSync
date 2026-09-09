package app.lamasync.companion.media

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore

/**
 * LAMA-296 stage 2 — MediaStore access seam.
 *
 * The engine drives KEYSET pagination (never OFFSET: rows inserted between
 * pages must not be skipped or duplicated) over one deterministic order,
 * `(date_added DESC, _id DESC)`, keyed per VOLUME:
 *  - API 29+: `getExternalVolumeNames(context)` yields e.g. `external_primary`
 *    and `external_secondary_*`; per-volume keys make _ID comparison
 *    meaningful (MediaStore _IDs are per-volume, so cross-volume _ID
 *    ordering would be meaningless);
 *  - API ≤28: the single shared EXTERNAL_CONTENT_URI (documented
 *    primary-volume-only caveat).
 *
 * New-only watermark semantics (race-safe without relying on a public
 * GENERATION column — MediaStore.MediaColumns.GENERATION is not public
 * before API 36): the NEWEST row's `(date_added, _id)` is captured BEFORE
 * the first import query. Rows present at capture time have keys ≤
 * (boundary); rows inserted afterwards have strictly larger keys — so the
 * boundary query and the import queries can never miss or duplicate a row,
 * whatever interleaving the camera app uses. Edits of ALREADY-KNOWN rows
 * are caught by the record reconciliation pass (knownRows size/date checks)
 * rather than by the new-only walk.
 */
interface MediaCursorLibrary {

    /** Volume names to scan for a collection (deterministic order). */
    suspend fun volumes(collection: MediaCollection): List<String>

    /** Newest row key `(date_added, _id)` at call time (new-only boundary). */
    suspend fun newestKey(collection: MediaCollection, volume: String): PageKey?

    /** One page of rows strictly NEWER than [before] (or from the top),
     *  ordered `date_added DESC, _id DESC`. */
    suspend fun queryNewestFirst(
        collection: MediaCollection,
        volume: String,
        before: PageKey?,
        limit: Int,
    ): List<MediaRow>

    /** Meta for known ids (size + date_modified) to detect edits without a
     *  full collection walk. */
    suspend fun knownRows(
        collection: MediaCollection,
        volume: String,
        ids: List<Long>,
    ): List<KnownRowMeta>
}

/** One projected MediaStore row (identity + content metadata, never a path
 *  as identity). */
data class MediaRow(
    val mediaId: Long,
    val uri: String,
    val displayName: String,
    val sizeBytes: Long?,
    val mimeType: String?,
    val relativePath: String?,
    val dataPath: String?,
    val dateAddedSeconds: Long,
    /** Last-modified time (seconds since epoch) — a practical revision
     *  signal alongside size, so a same-size edit is detectable (P0-add). */
    val dateModifiedSeconds: Long? = null,
    val dateTakenMillis: Long?,
)

/** Deterministic keyset position in `(date_added, _id)` order. */
data class PageKey(
    val dateAdded: Long = 0L,
    val mediaId: Long = 0L,
)

/** Real MediaStore implementation (Android). Queries are suspend and run on
 *  the caller's dispatcher (the worker/IO) — never the main thread. */
class MediaStoreCursorLibrary(
    context: Context,
    private val sdkInt: Int = Build.VERSION.SDK_INT,
) : MediaCursorLibrary {

    private val contentResolver: ContentResolver = context.contentResolver

    override suspend fun volumes(collection: MediaCollection): List<String> {
        val names = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.getExternalVolumeNames(_context).filter { it.startsWith("external_") }
        } else {
            setOf(VOLUME_PRIMARY)
        }
        return names.sorted()
    }

    override suspend fun newestKey(collection: MediaCollection, volume: String): PageKey? {
        val uri = uriFor(collection, volume)
        val projection = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATE_ADDED)
        val args = android.os.Bundle().apply {
            putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, "${MediaStore.MediaColumns.DATE_ADDED} DESC, ${MediaStore.MediaColumns._ID} DESC")
            putInt(ContentResolver.QUERY_ARG_LIMIT, 1)
        }
        return contentResolver.query(uri, projection, args, null)?.use { c ->
            if (c.moveToFirst()) {
                PageKey(
                    dateAdded = c.getLong(c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)),
                    mediaId = c.getLong(c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)),
                )
            } else {
                null
            }
        }
    }

    override suspend fun queryNewestFirst(
        collection: MediaCollection,
        volume: String,
        before: PageKey?,
        limit: Int,
    ): List<MediaRow> {
        val selection = if (before == null) {
            null
        } else {
            "(${MediaStore.MediaColumns.DATE_ADDED} < ?) OR (${MediaStore.MediaColumns.DATE_ADDED} = ? AND ${MediaStore.MediaColumns._ID} < ?)"
        }
        val args = if (before == null) {
            null
        } else {
            arrayOf(before.dateAdded.toString(), before.dateAdded.toString(), before.mediaId.toString())
        }
        val queryArgs = android.os.Bundle().apply {
            putString(
                ContentResolver.QUERY_ARG_SQL_SORT_ORDER,
                "${MediaStore.MediaColumns.DATE_ADDED} DESC, ${MediaStore.MediaColumns._ID} DESC",
            )
            putInt(ContentResolver.QUERY_ARG_LIMIT, limit.coerceIn(1, 1000))
        }
        return queryRows(collection, volume, selection, args, queryArgs)
    }

    override suspend fun knownRows(
        collection: MediaCollection,
        volume: String,
        ids: List<Long>,
    ): List<KnownRowMeta> {
        if (ids.isEmpty()) return emptyList()
        val out = mutableListOf<KnownRowMeta>()
        val uri = uriFor(collection, volume)
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
        )
        for (chunk in ids.chunked(MAX_IN_VARS)) {
            val placeholders = chunk.joinToString(",") { "?" }
            val selection = "${MediaStore.MediaColumns._ID} IN ($placeholders)"
            val rows = contentResolver.query(uri, projection, selection, chunk.map { it.toString() }.toTypedArray(), null)
                ?.use { c -> buildList {
                    val idIdx = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                    val sizeIdx = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                    val modIdx = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
                    while (c.moveToNext()) {
                        val size = if (c.isNull(sizeIdx)) null else c.getLong(sizeIdx)
                        val mod = if (c.isNull(modIdx)) null else c.getLong(modIdx)
                        add(KnownRowMeta(c.getLong(idIdx), size, mod))
                    }
                } }
                ?: emptyList()
            out += rows
        }
        return out
    }

    private fun queryRows(
        collection: MediaCollection,
        volume: String,
        selection: String?,
        args: Array<String>?,
        queryArgs: android.os.Bundle,
    ): List<MediaRow> {
        val uri = uriFor(collection, volume)
        val projection = projectionFor(sdkInt)
        if (selection != null) {
            queryArgs.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
            args?.let { queryArgs.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, it) }
        }
        return contentResolver.query(uri, projection, queryArgs, null)?.use { c ->
            buildList {
                val idIdx = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                val nameIdx = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                val sizeIdx = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                val mimeIdx = c.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
                val addedIdx = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
                val takenIdx = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_TAKEN)
                val modIdx = if (sdkInt >= Build.VERSION_CODES.Q) {
                    c.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED)
                } else {
                    -1
                }
                val relPathIdx = if (sdkInt >= Build.VERSION_CODES.Q) {
                    c.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH)
                } else {
                    -1
                }
                val dataIdx = if (sdkInt < Build.VERSION_CODES.Q) {
                    c.getColumnIndex(MediaStore.MediaColumns.DATA)
                } else {
                    -1
                }
                while (c.moveToNext()) {
                    val id = c.getLong(idIdx)
                    val size = if (sizeIdx >= 0 && !c.isNull(sizeIdx)) c.getLong(sizeIdx) else null
                    val mime = if (mimeIdx >= 0 && !c.isNull(mimeIdx)) c.getString(mimeIdx) else null
                    val added = c.getLong(addedIdx)
                    val taken = if (takenIdx >= 0 && !c.isNull(takenIdx)) c.getLong(takenIdx) else null
                    val mod = if (modIdx >= 0 && !c.isNull(modIdx)) c.getLong(modIdx) else null
                    val rel = if (relPathIdx >= 0 && !c.isNull(relPathIdx)) c.getString(relPathIdx) else null
                    val data = if (dataIdx >= 0 && !c.isNull(dataIdx)) c.getString(dataIdx) else null
                    add(
                        MediaRow(
                            mediaId = id,
                            uri = ContentUris.withAppendedId(uri, id).toString(),
                            displayName = c.getString(nameIdx) ?: "media-$id",
                            sizeBytes = size,
                            mimeType = mime,
                            relativePath = rel,
                            dataPath = data,
                            dateAddedSeconds = added,
                            dateModifiedSeconds = mod,
                            dateTakenMillis = taken,
                        ),
                    )
                }
            }
        } ?: emptyList()
    }

    private fun uriFor(collection: MediaCollection, volume: String): Uri = when (collection) {
        MediaCollection.IMAGES ->
            if (sdkInt >= Build.VERSION_CODES.Q) MediaStore.Images.Media.getContentUri(volume)
            else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        MediaCollection.VIDEOS ->
            if (sdkInt >= Build.VERSION_CODES.Q) MediaStore.Video.Media.getContentUri(volume)
            else MediaStore.Video.Media.EXTERNAL_CONTENT_URI
    }

    private fun projectionFor(sdk: Int): Array<String> = buildList {
        add(MediaStore.MediaColumns._ID)
        add(MediaStore.MediaColumns.DISPLAY_NAME)
        add(MediaStore.MediaColumns.SIZE)
        add(MediaStore.MediaColumns.MIME_TYPE)
        add(MediaStore.MediaColumns.DATE_ADDED)
        add(MediaStore.MediaColumns.DATE_TAKEN)
        if (sdk >= Build.VERSION_CODES.Q) {
            add(MediaStore.MediaColumns.RELATIVE_PATH)
            add(MediaStore.MediaColumns.DATE_MODIFIED)
        }
        if (sdk < Build.VERSION_CODES.Q) add(MediaStore.MediaColumns.DATA)
    }.toTypedArray()

    /** getExternalVolumeNames takes a Context; queries use the resolver. */
    private val _context: android.content.Context = context

    companion object {
        const val VOLUME_PRIMARY = "external_primary"
        private const val MAX_IN_VARS = 500
    }
}