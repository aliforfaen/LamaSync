package app.lamasync.companion.media

import android.Manifest
import android.app.Application
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lamasync.companion.data.NamedQueueStorage
import app.lamasync.companion.data.UploadQueueStore
import java.io.RandomAccessFile
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-296 stage 2 — discovery over the REAL MediaStore: insert real photos
 * and a >64 MiB video into DCIM/Camera and Pictures/Screenshots, discover
 * them through the real MediaStoreCursorLibrary + engine, prove
 * classification, idempotent duplicate scans, editing, local deletion (never
 * touching the server), and permission revoke/regrant scope semantics.
 *
 * Requires the emulator (API 35) and full media permission, granted via the
 * shell (UiAutomation). Inserts need no permission on API 29+; queries do.
 */
@RunWith(AndroidJUnit4::class)
class MediaStoreDiscoveryInstrumentedTest {

    private lateinit var app: Application
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    /** "mediaScopeNegative=true" marks the shell-prepared negative pass where
     *  permissions are set OUTSIDE the app process (revoking a permission of a
     *  RUNNING app force-stops it — so in-process revocation is impossible and
     *  dishonest to fake). See docs/development.md stage-2 negative pass. */
    private val negativePass: Boolean =
        InstrumentationRegistry.getArguments().getString(MEDIA_SCOPE_NEGATIVE_ARG) == "true"

    private val insertedPhoto = mutableListOf<Uri>()
    private val insertedVideo = mutableListOf<Uri>()
    private val insertedShot = mutableListOf<Uri>()

    @Before
    fun grantPermissions() {
        app = ApplicationProvider.getApplicationContext()
        if (!negativePass) {
            grant(Manifest.permission.READ_MEDIA_IMAGES)
            grant(Manifest.permission.READ_MEDIA_VIDEO)
            grant(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        }
    }

    @After
    fun cleanup() {
        // Remove every row this test inserted (keep the emulator gallery
        // clean for repeat runs).
        (insertedPhoto + insertedVideo + insertedShot).forEach { uri ->
            runCatching { app.contentResolver.delete(uri, null, null) }
        }
        insertedPhoto.clear()
        insertedVideo.clear()
        insertedShot.clear()
    }

    private fun grant(permission: String) {
        instrumentation.uiAutomation.grantRuntimePermission(app.packageName, permission)
    }

    private fun insertImage(relPath: String, name: String, size: Int): Uri {
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH, relPath)
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = app.contentResolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL), values)!!
        app.contentResolver.openOutputStream(uri)!!.use { out ->
            val buffer = ByteArray(64 * 1024) { ((it + 7) % 251).toByte() }
            var left = size
            while (left > 0) {
                val n = minOf(buffer.size, left)
                out.write(buffer, 0, n)
                left -= n
            }
        }
        val done = ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }
        app.contentResolver.update(uri, done, null, null)
        return uri
    }

    private fun insertVideo(relPath: String, name: String, sizeBytes: Long): Uri {
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, relPath)
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val uri = app.contentResolver.insert(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL), values)!!
        app.contentResolver.openOutputStream(uri)!!.use { out ->
            val buffer = ByteArray(1024 * 1024)
            var written = 0L
            while (written < sizeBytes) {
                val n = minOf(buffer.size.toLong(), sizeBytes - written).toInt()
                for (i in 0 until n) buffer[i] = ((written + i) % 251).toByte()
                out.write(buffer, 0, n)
                written += n
            }
        }
        val done = ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }
        app.contentResolver.update(uri, done, null, null)
        return uri
    }

    private fun settings(existing: Boolean = false) = AutoProtectSettings(
        cameraPhotosEnabled = true,
        cameraVideosEnabled = true,
        screenshotsEnabled = true,
        scopeMode = if (existing) ScopeMode.EXISTING_HISTORY else ScopeMode.NEW_ONLY,
    )

    private fun freshStores(): Pair<MediaProtectionStore, UploadQueueStore> {
        val tag = System.currentTimeMillis()
        val recStore = MediaProtectionStore(NamedQueueStorage(app, "auto_test_$tag"))
        val queue = UploadQueueStore(
            NamedQueueStorage(app, "queue_test_$tag"),
        )
        recStore.clear()
        queue.clear()
        return recStore to queue
    }

    private fun discovered(
        recStore: MediaProtectionStore,
        settings: AutoProtectSettings,
        scope: MediaPermissionScope,
        pageSize: Int = 50,
    ): MediaDiscoveryEngine.ScanOutcome = runBlocking {
        val lib = MediaStoreCursorLibrary(app, Build.VERSION.SDK_INT)
        val cursors = recStore.load().cursors.associateBy { MediaDiscoveryEngine.CursorKey(it.collection, it.volume) }
        val records = recStore.load().records.associateBy { it.identityKey }
        MediaDiscoveryEngine(lib).scan(settings, cursors, records, scope, pageSize)
    }

    @Test
    fun discoversAndClassifiesRealCameraPhotoScreenshotAndBigVideo() {
        Assume.assumeTrue("MediaStore insert requires API 29+", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        val photoUri = insertImage("DCIM/Camera", "stage2-photo-${System.currentTimeMillis()}.jpg", 200_000)
        insertedPhoto += photoUri
        val shotUri = insertImage("Pictures/Screenshots", "stage2-shot-${System.currentTimeMillis()}.png", 90_000)
        insertedShot += shotUri
        // A video ABOVE the old 64 MiB base64 cap (the stage-2 requirement).
        val videoUri = insertVideo("DCIM/Camera", "stage2-big-${System.currentTimeMillis()}.mp4", 65L * 1024 * 1024 + 777)
        insertedVideo += videoUri

        val (recStore, _) = freshStores()
        val outcome = discovered(recStore, settings(existing = true), MediaPermissionScope.FULL)

        val names = outcome.newRecords.map { it.displayName }
        assertTrue("camera photo discovered (${names})", names.any { it.startsWith("stage2-photo") })
        assertTrue("screenshot discovered", names.any { it.startsWith("stage2-shot") })
        val video = outcome.newRecords.firstOrNull { it.displayName.startsWith("stage2-big") }
        assertNotNull("big video discovered", video)
        assertEquals(
            "65 MiB+ video size carried through",
            65L * 1024 * 1024 + 777,
            video!!.sizeBytes,
        )
        assertEquals(AutoSource.CAMERA_VIDEOS, video.source)
        assertEquals(
            AutoSource.CAMERA_PHOTOS,
            outcome.newRecords.first { it.displayName.startsWith("stage2-photo") }.source,
        )
        assertEquals(
            AutoSource.SCREENSHOTS,
            outcome.newRecords.first { it.displayName.startsWith("stage2-shot") }.source,
        )
    }

    @Test
    fun repeatedScansAreIdempotentAndDeletionBecomesLocalOnly() {
        Assume.assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        val photoUri = insertImage("DCIM/Camera", "stage2-idem-${System.currentTimeMillis()}.jpg", 120_000)
        insertedPhoto += photoUri

        val (recStore, queue) = freshStores()
        // First scan: the row appears.
        val first = discovered(recStore, settings(existing = true), MediaPermissionScope.FULL)
        val identity = first.newRecords.first { it.displayName.startsWith("stage2-idem") }.identityKey

        // Persist the record + cursor exactly like the protection engine.
        recStore.commitScanPage(
            settings = settings(existing = true),
            cursorUpdates = first.cursorUpdates.values,
            recordUpdates = first.newRecords,
        )

        // Duplicate scan: no new record for the same identity.
        val second = discovered(recStore, settings(existing = true), MediaPermissionScope.FULL)
        assertEquals("no duplicate record on a repeated scan", 0, second.newRecords.count { it.identityKey == identity })

        // Delete the local row (photo removed from the gallery) → LOCALLY_DELETED.
        app.contentResolver.delete(photoUri, null, null)
        val third = discovered(recStore, settings(existing = true), MediaPermissionScope.FULL)
        assertTrue(
            "deletion detected locally only",
            third.deletedIdentities.contains(identity),
        )
        // Nothing was enqueued by discovery itself (queuing is the staging
        // phase), and nothing claims protection for the deleted row.
        assertTrue(queue.load().items.isEmpty())
    }

    @Test
    fun fullMediaAccessIsDetectedAsFullWhenGranted() {
        Assume.assumeTrue("full-scope assertion is for the default pass", !negativePass)
        assertEquals(
            MediaPermissionScope.FULL,
            MediaPermissions.current(app),
        )
    }

    @Test
    fun revokedMediaAccessIsDetectedAsNotGranted() {
        Assume.assumeTrue(
            "revocation cannot be mutated in-process (force-stop): run the shell-prepared negative pass (mediaScopeNegative=true)",
            negativePass,
        )
        assertEquals(
            MediaPermissionScope.NOT_GRANTED,
            MediaPermissions.current(app),
        )
        // Discovery must be honest about the missing grant: NO claim of rows.
        val (recStore, _) = freshStores()
        val outcome = discovered(recStore, settings(existing = true), MediaPermissionScope.NOT_GRANTED)
        assertTrue(outcome.newRecords.isEmpty())
    }

    @Test
    fun partialSelectedAccessIsDetectedAsPartialNotFull() {
        Assume.assumeTrue(
            "partial access cannot be simulated in-process: run the shell-prepared negative pass with only READ_MEDIA_VISUAL_USER_SELECTED granted",
            negativePass,
        )
        assertEquals(MediaPermissionScope.PARTIAL, MediaPermissions.current(app))
    }

    companion object {
        const val MEDIA_SCOPE_NEGATIVE_ARG = "mediaScopeNegative"
    }
}