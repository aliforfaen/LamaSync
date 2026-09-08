package app.lamasync.companion.vertical

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.lamasync.companion.data.FileSha256
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.UploadQueueItem
import app.lamasync.companion.data.UploadStatus
import app.lamasync.companion.data.UploadTransferEngine
import app.lamasync.companion.network.HttpRequest
import app.lamasync.companion.network.HttpResponse
import app.lamasync.companion.network.HttpTransport
import app.lamasync.companion.network.HttpUrlConnectionTransport
import app.lamasync.companion.network.MobileApiClient
import app.lamasync.companion.network.MobileUploadApi
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-296 stage 1 vertical HTTPS upload: the REAL app transfer stack (real
 * HTTPS transport, real MobileApiClient exchange, REAL MobileUploadApi +
 * UploadTransferEngine) against the disposable lamasync server behind the
 * vertical front door — including a file larger than the old 64 MiB base64
 * cap, with every chunk payload bounded. The server's landing tree and
 * operation history are verified through the same admin REST the desktop UI
 * uses.
 *
 * Inert without the `verticalOrigin` + `verticalAdminKey` instrumentation
 * args (the harness that provisions the disposable server sets them), so a
 * plain connectedDebugAndroidTest run stays green.
 */
@RunWith(AndroidJUnit4::class)
class VerticalUploadFlowTest {

    private lateinit var app: Application
    private var origin: String? = null
    private var adminKey: String? = null

    @Before
    fun readArgs() {
        val args = InstrumentationRegistry.getArguments()
        origin = args.getString("verticalOrigin")
        adminKey = args.getString("verticalAdminKey")
        Assume.assumeTrue("verticalOrigin instrumentation arg missing", origin != null)
        Assume.assumeTrue("verticalAdminKey instrumentation arg missing", adminKey != null)
        app = ApplicationProvider.getApplicationContext()
    }

    private fun adminGet(path: String): Pair<Int, String> {
        val conn = URL(origin + path).openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.connectTimeout = 20_000
        conn.readTimeout = 60_000
        conn.setRequestProperty("Authorization", "Bearer $adminKey")
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

    private fun adminPost(path: String, body: String): Pair<Int, String> {
        val conn = URL(origin + path).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 20_000
        conn.readTimeout = 60_000
        conn.setRequestProperty("Authorization", "Bearer $adminKey")
        conn.setRequestProperty("Content-Type", "application/json")
        conn.doOutput = true
        conn.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
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

    @Test
    fun largeVerifiedUpload_reachesTheLandingTree_withBoundedChunks_andAuditHistory() = runBlocking {
        val (native, hostId, destId) = setupEnv()
        val transport = RecordingTransport(HttpUrlConnectionTransport())
        val api = MobileUploadApi(transport)
        val engine = UploadTransferEngine(api)

        // A 65 MiB + change file (larger than the retired base64 cap).
        val size = 65 * 1024 * 1024 + 4096
        val file = File(app.filesDir, "vertical-big.bin").apply { delete() }
        RandomAccessFile(file, "rw").use { raf ->
            raf.setLength(0)
            val buffer = ByteArray(128 * 1024)
            var offset = 0
            while (offset < size) {
                val n = minOf(buffer.size, size - offset)
                for (i in 0 until n) buffer[i] = ((offset + i) % 251).toByte()
                raf.write(buffer, 0, n)
                offset += n
            }
        }

        val item = UploadQueueItem(
            id = UUID.randomUUID().toString(),
            origin = origin!!,
            hostId = hostId,
            sourceUri = "content://vertical/big",
            displayName = "vertical-big.mp4",
            sizeBytes = size.toLong(),
            destinationId = destId,
            destinationRelPath = "Mobile/$hostId/Inbox",
            idempotencyKey = "vertical-" + UUID.randomUUID(),
            sha256 = FileSha256.of(file),
            staged = true,
            stagedFileName = file.name,
            status = UploadStatus.PENDING,
            createdAtEpochMillis = System.currentTimeMillis(),
            updatedAtEpochMillis = System.currentTimeMillis(),
        )

        val outcome = engine.transfer(item, native, file, item.sha256!!) {}
        assertTrue(
            "upload must complete over the real server",
            outcome is UploadTransferEngine.TransferOutcome.Completed,
        )
        val receipt = (outcome as UploadTransferEngine.TransferOutcome.Completed).receipt
        assertEquals("verified size == source size", size.toLong(), receipt.sizeBytes)
        assertEquals("verified sha256 == source sha256", FileSha256.of(file), receipt.sha256)
        assertEquals("Mobile/$hostId/Inbox/vertical-big.mp4", receipt.finalRelPath)

        // Memory bound: every chunk payload ≤ 1 MiB, ~66 chunks for 65 MiB+.
        assertTrue("no chunk exceeded the 1 MiB client cap", transport.chunkSizes.all { it <= 1024 * 1024 })
        assertTrue("enough chunks to prove streaming", transport.chunkSizes.size >= 65)

        // The final, verified file exists under the landing root in the
        // existing Data Browser surface.
        val (listStatus, listText) = adminGet("/api/v1/browse/local?path=Mobile%2F$hostId%2FInbox")
        assertEquals("browse listing of the inbox should succeed", 200, listStatus)
        val listing = JSONObject(listText)
        val entries = listing.getJSONArray("entries")
        var found = false
        for (i in 0 until entries.length()) {
            val e = entries.getJSONObject(i)
            if (e.getString("name") == "vertical-big.mp4") {
                found = true
                assertEquals("server-side size matches", size.toLong(), e.getLong("size"))
            }
        }
        assertTrue("published file visible in the Data Browser", found)

        // Operation history carries the REAL mobile host id + operation.
        val (opsStatus, opsText) = adminGet("/api/v1/operations?hostId=$hostId")
        assertEquals(200, opsStatus)
        val ops = JSONArray(opsText)
        val row = (0 until ops.length())
            .map { ops.getJSONObject(it) }
            .firstOrNull { it.optString("operation") == "mobile_upload" && it.optString("status") == "success" }
        assertTrue("one verified mobile_upload row exists in operation history", row != null)
        assertEquals(hostId, row!!.getString("hostId"))
    }

    @Test
    fun declaredChecksumMismatch_failsExplicitly_neverPublishes() = runBlocking {
        val (native, hostId, destId) = setupEnv()
        val api = MobileUploadApi(HttpUrlConnectionTransport())
        val engine = UploadTransferEngine(api)
        val file = File(app.filesDir, "vertical-wrong.bin").apply {
            delete()
            writeBytes("not the declared digest content".toByteArray())
        }
        val item = UploadQueueItem(
            id = UUID.randomUUID().toString(),
            origin = origin!!,
            hostId = hostId,
            sourceUri = "content://vertical/wrong",
            displayName = "vertical-wrong.bin",
            sizeBytes = file.length(),
            destinationId = destId,
            destinationRelPath = "Mobile/$hostId/Inbox",
            idempotencyKey = "vertical-" + UUID.randomUUID(),
            sha256 = "0".repeat(64), // deliberately wrong
            staged = true,
            stagedFileName = file.name,
            status = UploadStatus.PENDING,
            createdAtEpochMillis = System.currentTimeMillis(),
            updatedAtEpochMillis = System.currentTimeMillis(),
        )
        val outcome = engine.transfer(item, native, file, "0".repeat(64)) {}
        assertTrue(outcome is UploadTransferEngine.TransferOutcome.Blocked)
        // Never published: the server's own upload row is failed with no
        // receipt, and no operation-history success row exists for it.
        val uploads = MobileUploadApi(HttpUrlConnectionTransport()).listUploads(origin!!, native)
        val row = uploads.firstOrNull { it.fileName == "vertical-wrong.bin" }
        assertTrue("the rejected upload is recorded", row != null)
        assertEquals("failed", row!!.status)
        assertTrue("no finalized receipt", row.receipt == null)
        val (opsStatus, opsText) = adminGet("/api/v1/operations?hostId=$hostId")
        assertEquals(200, opsStatus)
        val ops = JSONArray(opsText)
        val success = (0 until ops.length())
            .map { ops.getJSONObject(it) }
            .any {
                it.optString("operation") == "mobile_upload" &&
                    it.optString("status") == "success" &&
                    it.optString("summary").contains("vertical-wrong.bin")
            }
        val failed = (0 until ops.length())
            .map { ops.getJSONObject(it) }
            .any {
                it.optString("operation") == "mobile_upload" && it.optString("status") == "failed"
            }
        assertTrue("no success history for the rejected file", !success)
        assertTrue("a failed row records the rejection", failed)
    }

    /** Suspend setup: enroll + exchange via the REAL mobile client, assign
     *  the inbox through the admin surface, and return the identity. */
    private suspend fun setupEnv(): Triple<NativeToken, String, String> {
        val (status, text) = adminPost(
            "/api/v1/mobile/enrollments",
            """{"webAdmin":true,"clientType":"android"}""",
        )
        assertEquals(201, status)
        val enrollment = JSONObject(text)
        val exchanged = MobileApiClient(HttpUrlConnectionTransport()).exchangeEnrollment(
            origin = origin!!,
            enrollmentId = enrollment.getString("enrollmentId"),
            secret = enrollment.getString("secret"),
            displayName = "Vertical Upload Test",
            appVersion = "0.1.0",
        )
        val destId = assignDestination(exchanged.hostId)
        return Triple(exchanged.nativeToken, exchanged.hostId, destId)
    }

    private fun assignDestination(hostId: String): String {
        val (status, text) = adminPost(
            "/api/v1/mobile/registrations/$hostId/destinations",
            """{"label":"Inbox"}""",
        )
        assertEquals(201, status)
        return JSONObject(text).getJSONObject("destination").getString("id")
    }
}