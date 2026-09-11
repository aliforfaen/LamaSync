package app.lamasync.companion.media

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * LAMA-334 item 1 — Android gallery top-level folders as an upload unit.
 *
 * The operator's request was "upload a gallery folder — Camera Roll, Downloads
 * and the other device gallery directories", with least-privilege permissions
 * and contents that are predictable rather than surprising.
 *
 * ## What a "gallery folder" is here
 *
 * The top-level directory segment of the MEDIA the app is allowed to read
 * (`DCIM/Camera/…` → `dcim`, `Download/…` → `download`). That is the unit a
 * gallery app presents as a device folder, it is derived from MediaStore rather
 * than from the filesystem, and it can only ever contain media — the two
 * collections the `READ_MEDIA_*` grants cover. No directory the user did not
 * grant is ever reachable: the catalogue is built from MediaStore queries, and
 * nothing here walks a path.
 *
 * ## Permission floor
 *
 * Discovery is per collection and honours PARTIAL access (Android 14's
 * "selected photos"): a collection the app cannot read is not scanned, not
 * counted and not offered. The scope is checked LIVE on every build, exactly
 * as `MediaPermissions` requires, because the user can change it in Settings
 * without the app knowing.
 *
 * ## Semantics of an upload
 *
 * A folder upload is a **one-shot snapshot**: the items readable at the moment
 * the operator asks. Media added later is not included — continuous coverage of
 * new media is Camera protection's job, and the UI links there. Each item
 * becomes its own queue entry, so it keeps its own progress, receipt, retry and
 * cancel.
 */

/** One gallery top-level folder, as the device's gallery apps present it. */
data class GalleryFolder(
    /** Normalized top-level segment, e.g. `dcim`. Stable identity for the UI. */
    val key: String,
    /** Human label, e.g. "Camera roll". */
    val label: String,
    /** How many readable media items it holds. */
    val itemCount: Int,
    /** Sum of the item sizes, in bytes (rows without a size count as 0). */
    val totalBytes: Long,
)

/** One item to stage and upload. */
data class GalleryFolderItem(
    val uri: String,
    val displayName: String,
    val mimeType: String?,
    val sizeBytes: Long?,
)

/** The catalogue plus the honest state it was built under. */
data class GalleryFolderListing(
    val folders: List<GalleryFolder>,
    val scope: MediaPermissionScope,
    /** The scan hit [GalleryFolders.MAX_SCAN_ROWS], so counts are a floor. */
    val truncated: Boolean = false,
)

/** One classified MediaStore row, before aggregation. */
data class GalleryRow(val key: String?, val sizeBytes: Long?)

object GalleryFolders {

    /**
     * Row cap for one catalogue build. A phone gallery this deep is already
     * pathological; the cap exists so the screen cannot hang on one, and
     * [GalleryFolderListing.truncated] says so rather than quietly
     * under-counting.
     */
    const val MAX_SCAN_ROWS = 50_000

    /** Rows per cursor page (MediaStore's own keyset walk in this app). */
    const val PAGE_ROWS = 500

    /** Friendly names for the segments Android actually produces. */
    private val KNOWN_LABELS = mapOf(
        "dcim" to "Camera roll",
        "download" to "Downloads",
        "downloads" to "Downloads",
        "pictures" to "Pictures",
        "movies" to "Movies",
        "video" to "Videos",
        "videos" to "Videos",
        "music" to "Music",
        "documents" to "Documents",
        "screenshots" to "Screenshots",
        "whatsapp" to "WhatsApp",
        "telegram" to "Telegram",
        "android" to "App media",
    )

    /** Segments sorted first, because they are the common case. */
    private val PREFERRED_ORDER =
        listOf("dcim", "download", "downloads", "pictures", "movies", "videos")

    private val EXTERNAL_ROOT_PREFIX = Regex("^/(?:storage|mnt/media_rw)/[^/]+/")

    /**
     * Top-level folder key for a MediaStore row.
     *
     * API 29+ gives `RELATIVE_PATH` ("DCIM/Camera/"). Before that the only
     * source is `DATA`, an absolute path, whose storage root is stripped first
     * ([dataRoot], else the documented `/storage/<volume>/` and
     * `/mnt/media_rw/<volume>/` prefixes). Returns null when nothing usable is
     * present — an unclassifiable row is skipped rather than guessed into a
     * folder.
     */
    fun topLevelKey(relativePath: String?, dataPath: String?, dataRoot: String? = null): String? {
        val relative = relativePath?.trim()?.takeIf { it.isNotEmpty() }
        if (relative != null) return firstSegment(relative)

        val data = dataPath?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val root = dataRoot?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
        val stripped = when {
            root != null && data.startsWith("$root/") -> data.removePrefix("$root/")
            else -> EXTERNAL_ROOT_PREFIX.replace(data, "")
        }
        return firstSegment(stripped)
    }

    /** Human label for a key; unknown segments are title-cased, never dropped. */
    fun labelFor(key: String): String {
        val known = KNOWN_LABELS[key.lowercase()]
        if (known != null) return known
        return key
            .split('-', '_', ' ')
            .filter { it.isNotEmpty() }
            .joinToString(" ") { part -> part.replaceFirstChar { it.uppercase() } }
            .ifBlank { key }
    }

    /**
     * Aggregates classified rows into the catalogue. Pure, so the grouping —
     * the part that decides what "a folder" means — is testable without
     * MediaStore.
     *
     * Order: the common device folders first, then by item count, then label.
     * Deterministic, so the list does not shuffle between refreshes.
     */
    fun catalogue(rows: List<GalleryRow>): List<GalleryFolder> {
        val byKey = LinkedHashMap<String, LongArray>()
        for (row in rows) {
            val key = row.key ?: continue
            val acc = byKey.getOrPut(key) { LongArray(2) }
            acc[0] += 1
            acc[1] += (row.sizeBytes ?: 0L).coerceAtLeast(0L)
        }
        return byKey.entries
            .map { (key, acc) ->
                GalleryFolder(
                    key = key,
                    label = labelFor(key),
                    itemCount = acc[0].toInt(),
                    totalBytes = acc[1],
                )
            }
            .sortedWith(
                compareBy(
                    { PREFERRED_ORDER.indexOf(it.key).takeIf { index -> index >= 0 } ?: Int.MAX_VALUE },
                    { -it.itemCount },
                    { it.label },
                ),
            )
    }

    private fun firstSegment(path: String): String? = path
        .split('/')
        .firstOrNull { it.isNotBlank() }
        ?.trim()
        ?.lowercase()
        ?.takeIf { it.isNotEmpty() }
}

/**
 * The MediaStore catalogue: folder discovery and per-folder enumeration.
 *
 * Pagination is keyset over `(date_added DESC, _id DESC)` — the same
 * deterministic order `MediaStoreCursorLibrary` walks, and for the same reason:
 * rows inserted mid-scan must not be skipped or duplicated.
 */
class GalleryFolderCatalog(
    private val context: Context,
    private val sdkInt: Int = Build.VERSION.SDK_INT,
) {

    private val resolver: ContentResolver = context.contentResolver

    private val dataRoot: String?
        get() = if (sdkInt < Build.VERSION_CODES.Q) {
            @Suppress("DEPRECATION")
            Environment.getExternalStorageDirectory()?.absolutePath
        } else {
            null
        }

    /** Folders the app may read right now, with their live permission scope. */
    suspend fun listFolders(): GalleryFolderListing = withContext(Dispatchers.IO) {
        val scopes = MediaPermissions.currentScopes(context)
        val accessible = MediaCollection.entries.filter {
            scopes[it] != MediaPermissionScope.NOT_GRANTED
        }
        if (accessible.isEmpty()) {
            return@withContext GalleryFolderListing(emptyList(), overallScope(scopes))
        }

        val rows = mutableListOf<GalleryRow>()
        var scanned = 0
        var truncated = false

        scan@ for (collection in accessible) {
            for (volume in volumesFor()) {
                var before: PageCursor? = null
                while (true) {
                    val page = queryPage(
                        collection = collection,
                        volume = volume,
                        folderKey = null,
                        before = before,
                        projection = projectionFor(includeName = false),
                    ) { cursor ->
                        val sizeIdx = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                        val pathIdx = cursor.getColumnIndexOrThrow(pathColumn())
                        val path = if (cursor.isNull(pathIdx)) null else cursor.getString(pathIdx)
                        GalleryRow(
                            key = if (sdkInt >= Build.VERSION_CODES.Q) {
                                GalleryFolders.topLevelKey(path, null, null)
                            } else {
                                GalleryFolders.topLevelKey(null, path, dataRoot)
                            },
                            sizeBytes = if (cursor.isNull(sizeIdx)) null else cursor.getLong(sizeIdx),
                        )
                    }
                    if (page.rows.isEmpty()) break
                    rows += page.rows
                    scanned += page.rows.size
                    if (scanned >= GalleryFolders.MAX_SCAN_ROWS) {
                        truncated = true
                        break@scan
                    }
                    if (page.rows.size < GalleryFolders.PAGE_ROWS) break
                    before = page.next ?: break
                }
            }
        }

        GalleryFolderListing(
            folders = GalleryFolders.catalogue(rows),
            scope = overallScope(scopes),
            truncated = truncated,
        )
    }

    /**
     * Every readable item in [key], across the volumes and collections the app
     * can currently read. This is what an upload batch snapshots.
     */
    suspend fun itemsIn(key: String): List<GalleryFolderItem> = withContext(Dispatchers.IO) {
        val normalized = key.trim().lowercase()
        if (normalized.isEmpty()) return@withContext emptyList()

        val scopes = MediaPermissions.currentScopes(context)
        val out = mutableListOf<GalleryFolderItem>()
        for (collection in MediaCollection.entries) {
            if (scopes[collection] == MediaPermissionScope.NOT_GRANTED) continue
            for (volume in volumesFor()) {
                var before: PageCursor? = null
                while (true) {
                    val uri = uriFor(collection, volume)
                    val page = queryPage(
                        collection = collection,
                        volume = volume,
                        folderKey = normalized,
                        before = before,
                        projection = projectionFor(includeName = true),
                    ) { cursor ->
                        val id = cursor.getLong(
                            cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID),
                        )
                        val nameIdx = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
                        val mimeIdx = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
                        val sizeIdx = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                        GalleryFolderItem(
                            uri = ContentUris.withAppendedId(uri, id).toString(),
                            displayName = cursor.getString(nameIdx) ?: "media-$id",
                            mimeType = if (cursor.isNull(mimeIdx)) null else cursor.getString(mimeIdx),
                            sizeBytes = if (cursor.isNull(sizeIdx)) null else cursor.getLong(sizeIdx),
                        )
                    }
                    if (page.rows.isEmpty()) break
                    out += page.rows
                    if (page.rows.size < GalleryFolders.PAGE_ROWS) break
                    before = page.next ?: break
                }
            }
        }
        out
    }

    // ------------------------------------------------------------- internals

    private class PageCursor(val dateAdded: Long, val id: Long)

    private class Page<T>(val rows: List<T>, val next: PageCursor?)

    /**
     * One keyset page. The folder filter and the readable-row filter are ANDed
     * with the cursor predicate, so a page can never step outside the folder
     * the caller asked for.
     */
    private fun <T> queryPage(
        collection: MediaCollection,
        volume: String,
        folderKey: String?,
        before: PageCursor?,
        projection: Array<String>,
        read: (Cursor) -> T,
    ): Page<T> {
        val selections = mutableListOf<String>()
        val args = mutableListOf<String>()

        folderKey?.let { key ->
            if (sdkInt >= Build.VERSION_CODES.Q) {
                selections += "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?"
                // SQLite LIKE is ASCII case-insensitive, which is what lets the
                // lowercased key match MediaStore's own casing ("DCIM/").
                args += "$key/%"
            } else {
                val root = dataRoot?.trimEnd('/')
                selections += "${MediaStore.MediaColumns.DATA} LIKE ?"
                args += if (root != null) "$root/$key/%" else "%/$key/%"
            }
        }
        readableRowFilter()?.let { selections += it }
        before?.let {
            selections += "(${MediaStore.MediaColumns.DATE_ADDED} < ? OR " +
                "(${MediaStore.MediaColumns.DATE_ADDED} = ? AND ${MediaStore.MediaColumns._ID} < ?))"
            args += it.dateAdded.toString()
            args += it.dateAdded.toString()
            args += it.id.toString()
        }

        val queryArgs = Bundle().apply {
            putString(
                ContentResolver.QUERY_ARG_SQL_SORT_ORDER,
                "${MediaStore.MediaColumns.DATE_ADDED} DESC, ${MediaStore.MediaColumns._ID} DESC",
            )
            putInt(ContentResolver.QUERY_ARG_LIMIT, GalleryFolders.PAGE_ROWS)
            if (selections.isNotEmpty()) {
                putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selections.joinToString(" AND "))
                putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args.toTypedArray())
            }
        }

        return resolver.query(uriFor(collection, volume), projection, queryArgs, null)?.use { cursor ->
            val idIdx = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val addedIdx = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
            val rows = mutableListOf<T>()
            var last: PageCursor? = null
            while (cursor.moveToNext()) {
                rows += read(cursor)
                last = PageCursor(cursor.getLong(addedIdx), cursor.getLong(idIdx))
            }
            Page(rows, last)
        } ?: Page(emptyList(), null)
    }

    /**
     * Excludes rows the system is still writing or has trashed: a pending file
     * is not something an upload can honestly promise, and a trashed one is
     * already gone as far as the user is concerned. Applied to BOTH the counts
     * and the upload walk, so "Camera roll (312)" is 312 files you will get.
     */
    private fun readableRowFilter(): String? = when {
        sdkInt >= Build.VERSION_CODES.R ->
            "${MediaStore.MediaColumns.IS_PENDING} != 1 AND ${MediaStore.MediaColumns.IS_TRASHED} != 1"
        sdkInt >= Build.VERSION_CODES.Q -> "${MediaStore.MediaColumns.IS_PENDING} != 1"
        else -> null
    }

    private fun pathColumn(): String =
        if (sdkInt >= Build.VERSION_CODES.Q) {
            MediaStore.MediaColumns.RELATIVE_PATH
        } else {
            MediaStore.MediaColumns.DATA
        }

    private fun projectionFor(includeName: Boolean): Array<String> = buildList {
        add(MediaStore.MediaColumns._ID)
        add(MediaStore.MediaColumns.DATE_ADDED)
        add(MediaStore.MediaColumns.SIZE)
        add(pathColumn())
        if (includeName) {
            add(MediaStore.MediaColumns.DISPLAY_NAME)
            add(MediaStore.MediaColumns.MIME_TYPE)
        }
    }.toTypedArray()

    /** Scope reported for the whole catalogue: full only if every grant is. */
    private fun overallScope(scopes: Map<MediaCollection, MediaPermissionScope>): MediaPermissionScope =
        when {
            scopes.values.all { it == MediaPermissionScope.FULL } -> MediaPermissionScope.FULL
            scopes.values.any { it != MediaPermissionScope.NOT_GRANTED } -> MediaPermissionScope.PARTIAL
            else -> MediaPermissionScope.NOT_GRANTED
        }

    private fun volumesFor(): List<String> {
        // Both the real platform level (lint's guard, and the only thing that
        // decides whether the call exists) and the injectable level are
        // checked: a test that simulates pre-Q must not reach a Q API either.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || sdkInt < Build.VERSION_CODES.Q) {
            return listOf(PRIMARY_VOLUME)
        }
        val names = MediaStore.getExternalVolumeNames(context)
            .filter { it.startsWith("external") }
            .sorted()
        return names.ifEmpty { listOf(PRIMARY_VOLUME) }
    }

    private fun uriFor(collection: MediaCollection, volume: String): Uri = when (collection) {
        MediaCollection.IMAGES ->
            if (sdkInt >= Build.VERSION_CODES.Q) MediaStore.Images.Media.getContentUri(volume)
            else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        MediaCollection.VIDEOS ->
            if (sdkInt >= Build.VERSION_CODES.Q) MediaStore.Video.Media.getContentUri(volume)
            else MediaStore.Video.Media.EXTERNAL_CONTENT_URI
    }

    private companion object {
        const val PRIMARY_VOLUME = "external_primary"
    }
}
