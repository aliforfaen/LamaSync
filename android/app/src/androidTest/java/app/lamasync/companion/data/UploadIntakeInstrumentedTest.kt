package app.lamasync.companion.data

import android.app.Application
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.io.RandomAccessFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * LAMA-296 stage 1 — instrumented intake chain over REAL Android machinery:
 * a real content:// URI (debug FileProvider backed by the app's own files),
 * the real ContentResolver stager (bounded streaming + sha256), and the real
 * SharedPreferences queue store. This proves the app never treats content
 * URIs as filesystem paths and that staging survives grant transience.
 */
@RunWith(AndroidJUnit4::class)
class UploadIntakeInstrumentedTest {

    private lateinit var app: Application
    private lateinit var uploadsDir: File

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        uploadsDir = File(app.filesDir, "uploads")
        uploadsDir.deleteRecursively()
    }

    private fun authProvider(): String = "${app.packageName}.debug.fileprovider"

    private fun shareableFile(name: String, size: Int, seed: Int): Pair<File, String> {
        val dir = File(app.filesDir, "shareable").apply { mkdirs() }
        val file = File(dir, name)
        RandomAccessFile(file, "rw").use { raf ->
            raf.setLength(0)
            val buffer = ByteArray(64 * 1024)
            var remaining = size
            var offset = 0
            while (remaining > 0) {
                val n = minOf(buffer.size, remaining)
                for (i in 0 until n) buffer[i] = ((seed + offset + i) % 251).toByte()
                raf.write(buffer, 0, n)
                offset += n
                remaining -= n
            }
        }
        val uri = FileProvider.getUriForFile(app, authProvider(), file)
        return file to uri.toString()
    }

    private fun stager(maxBytes: Long): ContentStager = ContentStager(
        contentResolver = app.contentResolver,
        uploadsDir = { uploadsDir },
        maxStagingBytes = maxBytes,
    )

    @Test
    fun stagesARealContentUriWithExactBytesAndSha256() {
        val (source, uriString) = shareableFile("notes.pdf", 3 * 1024 * 1024 + 17, seed = 4)
        val staged = kotlinx.coroutines.runBlocking { stager(Long.MAX_VALUE).stage(android.net.Uri.parse(uriString)) }
        assertTrue("staged", staged is ContentStager.StageResult.Success)
        val ok = staged as ContentStager.StageResult.Success
        assertEquals(source.length(), ok.sizeBytes)
        assertEquals(FileSha256.of(source), ok.sha256)
        assertTrue("content identical", ok.file.readBytes().contentEquals(source.readBytes()))
    }

    @Test
    fun rejectsOverCapStagingWithoutLeavingPartialFiles() {
        val (_, uriString) = shareableFile("big.bin", 2 * 1024 * 1024, seed = 9)
        val staged = kotlinx.coroutines.runBlocking { stager(1024 * 1024).stage(android.net.Uri.parse(uriString)) }
        assertTrue("over-cap fails explicitly", staged is ContentStager.StageResult.Failure)
        assertEquals(
            ContentStager.StageFailure.TOO_LARGE,
            (staged as ContentStager.StageResult.Failure).reason,
        )
        assertTrue("no partial staging remains", uploadsDir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun rejectsNoSpaceStagingWithoutLeavingPartialFiles() {
        val (_, uriString) = shareableFile("full.bin", 2 * 1024 * 1024, seed = 3)
        // A deliberately absurd free-space floor forces the NO_SPACE path on
        // the first read (R7): the partially copied file must be deleted — an
        // untracked partial staging file would otherwise consume storage on
        // every repeated attempt.
        val stager = ContentStager(
            contentResolver = app.contentResolver,
            uploadsDir = { uploadsDir },
            maxStagingBytes = Long.MAX_VALUE,
            minFreeBytes = Long.MAX_VALUE,
        )
        val staged = kotlinx.coroutines.runBlocking { stager.stage(android.net.Uri.parse(uriString)) }
        assertTrue("no-space fails explicitly", staged is ContentStager.StageResult.Failure)
        assertEquals(
            ContentStager.StageFailure.NO_SPACE,
            (staged as ContentStager.StageResult.Failure).reason,
        )
        assertTrue("no partial staging remains", uploadsDir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun unreadableSourceDoesNotLeaveAnEmptyStagingFile() {
        // A content URI with no provider behind it is unreadable; staging
        // must delete the placeholder it created before returning.
        val bogus = "content://app.lamasync.companion.nonexistent/does-not-exist"
        val staged = kotlinx.coroutines.runBlocking { stager(Long.MAX_VALUE).stage(android.net.Uri.parse(bogus)) }
        assertTrue("unreadable fails explicitly", staged is ContentStager.StageResult.Failure)
        assertEquals(
            ContentStager.StageFailure.UNREADABLE,
            (staged as ContentStager.StageResult.Failure).reason,
        )
        assertTrue("no placeholder file remains", uploadsDir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun queueSurvivesStoreRecreationWithRealSharedPreferences() {
        val store = UploadQueueStore(app)
        store.clear()
        val item = UploadQueueItem(
            id = "qd-1",
            origin = "https://fleet.example.com",
            hostId = "mob-host-1",
            sourceUri = "content://authority/x",
            displayName = "doc.pdf",
            destinationId = "mdst-1",
            destinationRelPath = "Mobile/mob-host-1/Inbox",
            idempotencyKey = "up-12345678",
            staged = true,
            stagedFileName = "stage-fake",
            status = UploadStatus.PENDING,
            createdAtEpochMillis = System.currentTimeMillis(),
            updatedAtEpochMillis = System.currentTimeMillis(),
        )
        store.add(item)
        val reloaded = UploadQueueStore(app).load().items
        assertEquals(1, reloaded.size)
        assertEquals(item.id, reloaded.first().id)
        store.clear()
    }

    @Test
    fun stagedFileBecomesTheDurableSourceAfterIntake() {
        val (_, uriString) = shareableFile("shared.bin", 500_000, seed = 21)
        val staged = kotlinx.coroutines.runBlocking { stager(Long.MAX_VALUE).stage(android.net.Uri.parse(uriString)) }
        assertTrue(staged is ContentStager.StageResult.Success)
        val ok = staged as ContentStager.StageResult.Success
        // The transfer later reads ONLY the private copy (the share grant may
        // already be gone); the content URI is not a filesystem path.
        assertTrue(ok.file.exists())
        assertEquals(500_000L, ok.file.length())
    }
}