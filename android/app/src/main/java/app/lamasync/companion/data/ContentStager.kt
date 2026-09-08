package app.lamasync.companion.data

import android.content.ContentResolver
import android.net.Uri
import app.lamasync.companion.network.MobileUploadApi
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * LAMA-296 stage 1 — stage a content URI into bounded private storage while
 * the grant is valid. Transient share grants (ACTION_SEND) are not
 * persistable, so every source is copied immediately into
 * filesDir/uploads/; the transfer later reads the private file, never the
 * content URI. Bounds: per-file cap, free-space floor, and the staged file
 * is deleted as soon as a durable completion/cancellation decision allows.
 *
 * Content URIs are NEVER treated as filesystem paths — all reads go through
 * [ContentResolver.openInputStream].
 */
class ContentStager(
    private val contentResolver: ContentResolver,
    private val uploadsDir: () -> File,
    private val maxStagingBytes: Long = DEFAULT_MAX_STAGING_BYTES,
    private val minFreeBytes: Long = DEFAULT_MIN_FREE_BYTES,
    private val bufferSize: Int = 128 * 1024,
) {

    sealed interface StageResult {
        data class Success(
            val file: File,
            val sizeBytes: Long,
            val sha256: String,
        ) : StageResult

        data class Failure(val reason: StageFailure, val detail: String? = null) : StageResult
    }

    enum class StageFailure { UNREADABLE, TOO_LARGE, NO_SPACE, IO_ERROR }

    /** Stream + hash the URI into a fresh staging file inside [uploadsDir]. */
    suspend fun stage(uri: Uri): StageResult = withContext(Dispatchers.IO) {
        val dir = uploadsDir()
        try {
            dir.mkdirs()
        } catch (e: Exception) {
            return@withContext StageResult.Failure(StageFailure.IO_ERROR, e.message)
        }
        val target = File(dir, "stage-${System.currentTimeMillis()}-${targetName(uri)}")
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        try {
            val input = contentResolver.openInputStream(uri)
                ?: run {
                    // Nothing was readable — never leave an empty placeholder
                    // behind (R7: delete before EVERY post-creation failure).
                    target.delete()
                    return@withContext StageResult.Failure(StageFailure.UNREADABLE)
                }
            input.use { stream ->
                target.outputStream().use { out ->
                    val buffer = ByteArray(bufferSize)
                    while (true) {
                        if (!hasFreeSpaceAtLeast(minFreeBytes)) {
                            // Partial copy would otherwise be left untracked;
                            // delete it so repeated attempts cannot consume
                            // the remaining storage (R7).
                            target.delete()
                            return@withContext StageResult.Failure(StageFailure.NO_SPACE)
                        }
                        val read = stream.read(buffer)
                        if (read == -1) break
                        total += read
                        if (total > maxStagingBytes) {
                            target.delete()
                            return@withContext StageResult.Failure(StageFailure.TOO_LARGE)
                        }
                        out.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                    }
                }
            }
        } catch (e: Exception) {
            target.delete()
            return@withContext StageResult.Failure(StageFailure.UNREADABLE, e.message)
        }
        if (total == 0L) {
            // Empty sources are indistinguishable from a zero-byte file; keep
            // them (a valid empty document should still upload).
        }
        StageResult.Success(
            file = target,
            sizeBytes = total,
            sha256 = digest.digest().joinToString("") { "%02x".format(it) },
        )
    }

    /** Best-effort stable name from a content URI (authority + last segment). */
    fun targetName(uri: Uri): String {
        val last = uri.lastPathSegment?.takeLast(80) ?: "file"
        val safe = last.replace(Regex("[^A-Za-z0-9._-]"), "_").takeLast(60)
        return safe.ifBlank { "file" }
    }

    private fun hasFreeSpaceAtLeast(required: Long): Boolean {
        return try {
            val stat = uploadsDir().let { dir ->
                dir.mkdirs()
                android.os.StatFs(dir.absolutePath)
            }
            stat.availableBytes >= required
        } catch (e: Exception) {
            // Unknown filesystem state: proceed; the per-file cap still holds.
            true
        }
    }

    companion object {
        const val DEFAULT_MAX_STAGING_BYTES = 4L * 1024L * 1024L * 1024L
        const val DEFAULT_MIN_FREE_BYTES = 64L * 1024L * 1024L
    }
}

/** Pure file hash helper (bounded reads — never the whole file in memory). */
object FileSha256 {
    fun of(file: File, bufferSize: Int = MobileUploadApi.MAX_CHUNK_SEND): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(bufferSize)
            while (true) {
                val read = input.read(buffer)
                if (read == -1) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}