package app.lamasync.companion.vertical

import android.app.Application
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lamasync.companion.data.FileSha256
import app.lamasync.companion.data.NamedQueueStorage
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.UploadQueueStore
import app.lamasync.companion.data.UploadReceipt
import app.lamasync.companion.data.UploadStatus
import app.lamasync.companion.data.UploadTransferEngine
import app.lamasync.companion.media.AutoProtectSettings
import app.lamasync.companion.media.MediaCollection
import app.lamasync.companion.media.DestinationsResult
import app.lamasync.companion.media.MediaPermissionScope
import app.lamasync.companion.media.MediaProtectionEngine
import app.lamasync.companion.media.MediaProtectionStore
import app.lamasync.companion.media.ContentResolverByteStager
import app.lamasync.companion.media.MediaRecordStatus
import app.lamasync.companion.media.MediaStoreCursorLibrary
import app.lamasync.companion.media.MobileCameraDestinationResolver
import app.lamasync.companion.media.ScopeMode
import app.lamasync.companion.network.HttpRequest
import app.lamasync.companion.network.HttpResponse
import app.lamasync.companion.network.HttpTransport
import app.lamasync.companion.network.HttpUrlConnectionTransport
import app.lamasync.companion.network.MobileApiClient
import app.lamasync.companion.network.MobileUploadApi
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-296 stage 2 vertical HTTPS: the REAL automatic-protection pipeline —
 * real MediaStore rows (a camera photo AND a >64 MiB video), real discovery,
 * real bounded staging, real idempotent enqueue, and the REAL resumable
 * upload engine — proved end-to-end against the disposable lamasync server:
 * checksum-verified arrival in the Data Browser, real host provenance in
 * operation history, no duplicate files on repeated scans, and a local
 * deletion leaving the server copy untouched.
 *
 * Inert without the `verticalOrigin` + `verticalAdminKey` instrumentation
 * args (see docs/development.md).
 */
@RunWith(AndroidJUnit4::class)
class VerticalAutoProtectTest {

    private lateinit var app: Application
    private lateinit var origin: String
    private lateinit var adminKey: String

    private val insertedUris = mutableListOf<Uri>()

    @Before
    fun readArgs() {
        val args = InstrumentationRegistry.getArguments()
        val o = args.getString("verticalOrigin")
        val k = args.getString("verticalAdminKey")
        Assume.assumeTrue("verticalOrigin instrumentation arg missing", o != null)
        Assume.assumeTrue("verticalAdminKey instrumentation arg missing", k != null)
        Assume.assumeTrue("MediaStore insert requires API 29+", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        origin = o!!
        adminKey = k!!
        app = ApplicationProvider.getApplicationContext()
    }

    @After
    fun cleanupMediaStore() {
        insertedUris.forEach { uri ->
            runCatching { app.contentResolver.delete(uri, null, null) }
        }
        insertedUris.clear()
    }

    private fun adminGet(path: String): Pair<Int, String> = request("GET", path, null)
    private fun adminPost(path: String, body: String): Pair<Int, String> = request("POST", path, body)

    private fun request(method: String, path: String, body: String?): Pair<Int, String> {
        val conn = URL(origin + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 20_000
        conn.readTimeout = 60_000
        conn.setRequestProperty("Authorization", "Bearer $adminKey")
        if (body != null) {
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
        }
        val status = conn.responseCode
        val stream = if (status >= 400) conn.errorStream else conn.inputStream
        val text = stream?.use { input ->
            val buf = ByteArrayOutputStream()
            val chunk = ByteArray(8192)
            while (true) {
                val n = input.read(chunk)
                if (n == -1) break
                buf.write(chunk, 0, n)
            }
            if (buf.size() == 0) null else String(buf.toByteArray(), StandardCharsets.UTF_8)
        }
        conn.disconnect()
        return status to (text ?: "")
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
            val buffer = ByteArray(64 * 1024) { ((it + 3) % 251).toByte() }
            var left = size
            while (left > 0) {
                val n = minOf(buffer.size, left)
                out.write(buffer, 0, n)
                left -= n
            }
        }
        app.contentResolver.update(
            uri,
            ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) },
            null,
            null,
        )
        insertedUris += uri
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
        app.contentResolver.update(
            uri,
            ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) },
            null,
            null,
        )
        insertedUris += uri
        return uri
    }

    @Test
    fun autoProtectVertical_arrivesVerified_noDuplicates_localDeletionKeepsServerCopy() = runBlocking {
        val photoName = "vertical-auto-photo-${System.currentTimeMillis()}.jpg"
        val videoName = "vertical-auto-big-${System.currentTimeMillis()}.mp4"
        val photoSize = 480_000
        val videoSize = 65L * 1024 * 1024 + 333
        insertImage("DCIM/Camera", photoName, photoSize)
        insertVideo("DCIM/Camera", videoName, videoSize)

        val (native, hostId) = setupEnv()
        val tag = System.currentTimeMillis()
        val recordStore = MediaProtectionStore(NamedQueueStorage(app, "auto_vertical_$tag"))
        val queue = UploadQueueStore(NamedQueueStorage(app, "queue_vertical_$tag"))
        recordStore.clear()
        queue.clear()

        val settings = AutoProtectSettings(
            cameraPhotosEnabled = true,
            cameraVideosEnabled = true,
            scopeMode = ScopeMode.EXISTING_HISTORY,
        )
        val transport = RecordingTransport(HttpUrlConnectionTransport())
        val api = MobileUploadApi(transport)
        val engine = MediaProtectionEngine(
            queueStore = queue,
            recordStore = recordStore,
            stager = ContentResolverByteStager(app),
        )

        // 1) Discovery over the real MediaStore.
        val summary = engine.discover(
            MediaStoreCursorLibrary(app),
            settings,
            MediaCollection.entries.associateWith { MediaPermissionScope.FULL },
        )
        val ourNew = recordStore.load().records.filter {
            it.displayName == photoName || it.displayName == videoName
        }
        assertEquals("both camera rows discovered", 2, ourNew.size)
        val photoIdentity = recordStore.load().records.first { it.displayName == photoName }.identityKey

        // 2) Real destination resolution + staging + idempotent enqueue.
        val resolver = MobileCameraDestinationResolver(api)
        val destinations = resolver.resolve(origin, native, null)
        assertTrue("destinations resolve", destinations is DestinationsResult.Ok)
        val protect = engine.protectPending(
            settings = recordStore.load().settings,
            origin = origin,
            hostId = hostId,
            destinationsResult = destinations,
        )
        assertTrue("our rows staged+queued (other gallery rows may exist)", protect.stagedCount >= 2)
        val pending = queue.pendingItems().filter {
            it.sourceLabel != null &&
                (it.displayName == photoName || it.displayName == videoName)
        }
        assertEquals(2, pending.size)

        // 3) Transfer every auto item through the REAL resumable engine.
        val transferEngine = UploadTransferEngine(api)
        for (item in pending) {
            val staged = java.io.File(app.filesDir, "uploads").resolve(item.stagedFileName!!)
            val outcome = transferEngine.transfer(item, native, staged, item.sha256!!) {}
            assertTrue(
                "auto item completes (got: $outcome)\nitem=${item.displayName}\nidempotencyKey=${item.idempotencyKey}",
                outcome is UploadTransferEngine.TransferOutcome.Completed,
            )
            val receipt = (outcome as UploadTransferEngine.TransferOutcome.Completed).receipt
            val done = item.copy(
                status = UploadStatus.DONE,
                receipt = receipt,
                serverStatus = "finalized",
                uploadedBytes = receipt.sizeBytes,
                serverBytesReceived = receipt.sizeBytes,
                updatedAtEpochMillis = System.currentTimeMillis(),
            )
            queue.update(done)
            // Mirror receipt into the protection registry through the EXACT
            // completion reconcile the transfer worker now performs (P0-1).
            assertTrue(
                "registry reconciled",
                MediaProtectionEngine.reconcileCompleted(recordStore, done),
            )
        }

        // 4) Verified arrival + provenance.
        assertTrue("chunks bounded", transport.chunkSizes.all { it <= 1024 * 1024 })
        val (listStatus, listText) = adminGet("/api/v1/browse/local?path=Mobile%2F$hostId%2FCamera")
        assertEquals(200, listStatus)
        val entries = JSONObject(listText).getJSONArray("entries")
        val byName = (0 until entries.length()).associateBy({ entries.getJSONObject(it).getString("name") }) { entries.getJSONObject(it) }
        assertTrue("photo in Data Browser", byName.containsKey(photoName))
        assertEquals(photoSize.toLong(), byName[photoName]!!.getLong("size"))
        assertTrue("big video in Data Browser", byName.containsKey(videoName))
        assertEquals(videoSize, byName[videoName]!!.getLong("size"))

        val (opsStatus, opsText) = adminGet("/api/v1/operations?hostId=$hostId")
        assertEquals(200, opsStatus)
        val ops = JSONArray(opsText)
        val successes = (0 until ops.length())
            .map { ops.getJSONObject(it) }
            .filter { it.optString("operation") == "mobile_upload" && it.optString("status") == "success" }
        assertTrue("two verified mobile_upload rows with real host id", successes.size >= 2)
        assertTrue(successes.all { it.getString("hostId") == hostId })

        // 5) Duplicate scan + protect pass: nothing new, nothing duplicated.
        val ourCountBefore = recordStore.load().records.count {
            it.displayName == photoName || it.displayName == videoName
        }
        val dup = engine.discover(
            MediaStoreCursorLibrary(app),
            recordStore.load().settings,
            MediaCollection.entries.associateWith { MediaPermissionScope.FULL },
        )
        val ourCountAfter = recordStore.load().records.count {
            it.displayName == photoName || it.displayName == videoName
        }
        assertEquals(
            "no fresh records for our identities on the repeated scan",
            ourCountBefore,
            ourCountAfter,
        )
        assertTrue("discovery summary reports no new rows", dup.newRecords == 0)
        val protect2 = engine.protectPending(
            recordStore.load().settings, origin, hostId, destinations,
        )
        assertEquals(
            "no fresh queue items for our media on the repeated scan",
            0,
            queue.load().items.count {
                it.mediaIdentity != null &&
                    (it.displayName == photoName || it.displayName == videoName) &&
                    it.status == UploadStatus.PENDING
            },
        )

        // 6) Local deletion NEVER touches the server copy.
        app.contentResolver.delete(insertedUris[0], null, null) // the photo
        engine.discover(
            MediaStoreCursorLibrary(app),
            recordStore.load().settings,
            MediaCollection.entries.associateWith { MediaPermissionScope.FULL },
        )
        assertEquals(
            "local deletion recorded for the photo identity",
            MediaRecordStatus.LOCALLY_DELETED,
            recordStore.recordFor(photoIdentity)?.status,
        )
        val (still, stillText) = adminGet("/api/v1/browse/local?path=Mobile%2F$hostId%2FCamera")
        assertEquals(200, still)
        assertTrue(
            "server copy still present after local deletion",
            JSONObject(stillText).getJSONArray("entries")
                .let { a -> (0 until a.length()).any { a.getJSONObject(it).getString("name") == photoName } },
        )
    }

    /** Records every chunk PUT payload size (bounded-memory evidence). */
    private class RecordingTransport(
        private val delegate: HttpTransport,
    ) : HttpTransport {
        val chunkSizes = mutableListOf<Int>()

        override suspend fun execute(request: HttpRequest): HttpResponse {
            if (request.url.contains("/chunks")) {
                request.body?.let { chunkSizes += it.size }
            }
            return delegate.execute(request)
        }
    }

    private suspend fun setupEnv(): Quad {
        val (status, text) = adminPost(
            "/api/v1/mobile/enrollments",
            """{"webAdmin":true,"clientType":"android"}""",
        )
        assertEquals(201, status)
        val enrollment = JSONObject(text)
        val exchanged = MobileApiClient(HttpUrlConnectionTransport()).exchangeEnrollment(
            origin = origin,
            enrollmentId = enrollment.getString("enrollmentId"),
            secret = enrollment.getString("secret"),
            displayName = "Vertical Auto Protect",
            appVersion = "0.2.0",
        )
        val (destStatus, destText) = adminPost(
            "/api/v1/mobile/registrations/${exchanged.hostId}/destinations",
            """{"label":"Camera"}""",
        )
        assertEquals(201, destStatus)
        return Quad(exchanged.nativeToken, exchanged.hostId)
    }

    private data class Quad(
        val native: NativeToken,
        val hostId: String,
    )
}