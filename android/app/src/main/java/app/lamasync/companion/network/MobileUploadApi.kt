package app.lamasync.companion.network

import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.core.HttpErrorMapper
import app.lamasync.companion.data.NativeToken
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * LAMA-296 stage 1 — native upload API client. Mirrors the core wire DTOs
 * (packages/core/src/types.ts MobileUpload*). Owns ONLY the native token;
 * never the web grant. All methods take an https [origin] produced by
 * [app.lamasync.companion.core.OriginPolicy].
 *
 * Protocol (server spec-296-stage-1-manual-uploads.md):
 *   GET  {origin}/api/v1/mobile/destinations  (native) -> { destinations[] }
 *   POST {origin}/api/v1/mobile/uploads       (native; Idempotency-Key header)
 *   PUT  {origin}/api/v1/mobile/uploads/:id/chunks (X-Upload-Offset, raw body)
 *   GET  {origin}/api/v1/mobile/uploads[:/:id]
 *   POST {origin}/api/v1/mobile/uploads/:id/finalize -> { receipt }
 *   POST {origin}/api/v1/mobile/uploads/:id/cancel
 *
 * Chunk bodies are bounded (never whole files): [MAX_CHUNK_SEND] caps each
 * PUT payload at 1 MiB regardless of the server's negotiated chunk size.
 */

@Serializable
data class MobileUploadDestinationDto(
    val id: String,
    val registrationId: String = "",
    val label: String,
    val relPath: String,
    val createdAt: Long = 0L,
    val revokedAt: Long? = null,
)

@Serializable
data class MobileUploadDto(
    val id: String,
    val destinationId: String,
    val destinationLabel: String = "",
    val fileName: String,
    val finalRelPath: String,
    val sizeBytes: Long? = null,
    val bytesReceived: Long,
    val sha256: String? = null,
    val status: String,
    val error: String? = null,
    val createdAt: Long,
    val updatedAt: Long,
    val finalizedAt: Long? = null,
    val receipt: MobileUploadReceiptDto? = null,
    val chunkSizeBytes: Long = 0L,
    val maxSizeBytes: Long = 0L,
)

@Serializable
data class MobileUploadReceiptDto(
    val uploadId: String,
    val fileName: String,
    val finalRelPath: String,
    val browseRef: MobileBrowseRefDto? = null,
    val sizeBytes: Long,
    val sha256: String,
    val finalizedAt: Long,
)

@Serializable
data class MobileBrowseRefDto(val kind: String = "local", val path: String)

@Serializable
private data class DestinationsEnvelope(val destinations: List<MobileUploadDestinationDto>)

@Serializable
private data class CreateUploadRequest(
    val destinationId: String,
    val fileName: String,
    val sizeBytes: Long? = null,
    val sha256: String? = null,
)

@Serializable
private data class UploadEnvelope(val upload: MobileUploadDto)

@Serializable
private data class UploadsEnvelope(val uploads: List<MobileUploadDto>)

@Serializable
private data class FinalizeEnvelope(val receipt: MobileUploadReceiptDto)

/** One staged file ready to stream (see engine). */
data class StagedSource(
    val fileName: String,
    val sizeBytes: Long,
    val sha256: String,
)

/** Upload protocol seam — the engine + tests depend on this, not the
 *  transport-backed implementation. */
interface MobileUploadService {
    suspend fun listDestinations(origin: String, native: NativeToken): List<MobileUploadDestinationDto>

    suspend fun createUpload(
        origin: String,
        native: NativeToken,
        destinationId: String,
        fileName: String,
        sizeBytes: Long?,
        sha256: String?,
        idempotencyKey: String,
    ): MobileUploadDto

    suspend fun sendChunk(
        origin: String,
        native: NativeToken,
        uploadId: String,
        offset: Long,
        data: ByteArray,
    ): MobileUploadDto

    suspend fun uploadState(origin: String, native: NativeToken, uploadId: String): MobileUploadDto

    suspend fun listUploads(origin: String, native: NativeToken): List<MobileUploadDto>

    suspend fun finalize(origin: String, native: NativeToken, uploadId: String): MobileUploadReceiptDto

    suspend fun cancel(origin: String, native: NativeToken, uploadId: String): MobileUploadDto
}

class MobileUploadApi(
    private val transport: HttpTransport,
    private val json: Json = defaultJson(),
) : MobileUploadService {

    override suspend fun listDestinations(origin: String, native: NativeToken): List<MobileUploadDestinationDto> {
        val response = getJson(origin, native, "/api/v1/mobile/destinations")
        return decodeOrThrow(response, DestinationsEnvelope.serializer()).destinations
            .filter { it.revokedAt == null }
    }

    override suspend fun createUpload(
        origin: String,
        native: NativeToken,
        destinationId: String,
        fileName: String,
        sizeBytes: Long?,
        sha256: String?,
        idempotencyKey: String,
    ): MobileUploadDto {
        val body = json.encodeToString(
            CreateUploadRequest.serializer(),
            CreateUploadRequest(destinationId, fileName, sizeBytes, sha256),
        )
        val response = transport.execute(
            HttpRequest(
                method = "POST",
                url = "$origin/api/v1/mobile/uploads",
                headers = bearerHeaders(native) +
                    mapOf(
                        "Content-Type" to "application/json",
                        "Idempotency-Key" to idempotencyKey,
                    ),
                body = body.toByteArray(Charsets.UTF_8),
            ),
        )
        when (response.status) {
            201 -> return decodeOrThrow(response, UploadEnvelope.serializer()).upload
            404 -> throw ApiFailure.InvalidRequest() // destination not found
            410 -> throw ApiFailure.DestinationRevoked()
            409 -> {
                val err = errorText(response)
                throw if (err.contains("same name", ignoreCase = true) ||
                    err.contains("collision", ignoreCase = true)
                ) {
                    ApiFailure.UploadCollision()
                } else {
                    ApiFailure.UploadConflict(err)
                }
            }
            413 -> throw ApiFailure.UploadTooLarge()
            else -> throw mapUploadStatus(response.status)
        }
    }

    override suspend fun sendChunk(
        origin: String,
        native: NativeToken,
        uploadId: String,
        offset: Long,
        data: ByteArray,
    ): MobileUploadDto {
        val response = transport.execute(
            HttpRequest(
                method = "PUT",
                url = "$origin/api/v1/mobile/uploads/$uploadId/chunks",
                headers = bearerHeaders(native) +
                    mapOf(
                        "Content-Type" to "application/octet-stream",
                        "X-Upload-Offset" to offset.toString(),
                    ),
                body = data,
            ),
        )
        when (response.status) {
            200 -> return decodeOrThrow(response, UploadEnvelope.serializer()).upload
            409 -> {
                val err = errorText(response)
                throw if (err.contains("complete", ignoreCase = true)) {
                    ApiFailure.UploadIncomplete()
                } else if (err.contains("collision", ignoreCase = true) ||
                    err.contains("taken", ignoreCase = true)
                ) {
                    ApiFailure.UploadCollision()
                } else {
                    ApiFailure.UploadConflict(err)
                }
            }
            413 -> throw ApiFailure.UploadTooLarge()
            507 -> throw ApiFailure.StagingFull()
            else -> throw mapUploadStatus(response.status)
        }
    }

    override suspend fun uploadState(origin: String, native: NativeToken, uploadId: String): MobileUploadDto {
        val response = getJson(origin, native, "/api/v1/mobile/uploads/$uploadId")
        return decodeOrThrow(response, UploadEnvelope.serializer()).upload
    }

    override suspend fun listUploads(origin: String, native: NativeToken): List<MobileUploadDto> {
        val response = getJson(origin, native, "/api/v1/mobile/uploads")
        return decodeOrThrow(response, UploadsEnvelope.serializer()).uploads
    }

    override suspend fun finalize(origin: String, native: NativeToken, uploadId: String): MobileUploadReceiptDto {
        val response = transport.execute(
            HttpRequest(
                method = "POST",
                url = "$origin/api/v1/mobile/uploads/$uploadId/finalize",
                headers = bearerHeaders(native),
            ),
        )
        when (response.status) {
            200 -> {
                val parsed = decodeOrThrow(response, FinalizeEnvelope.serializer()).receipt
                return parsed
            }
            401 -> throw ApiFailure.Unauthorized()
            403 -> throw ApiFailure.Forbidden()
            409 -> {
                val err = errorText(response)
                throw if (err.contains("complete", ignoreCase = true)) {
                    ApiFailure.UploadIncomplete()
                } else if (err.contains("collision", ignoreCase = true) ||
                    err.contains("taken", ignoreCase = true)
                ) {
                    ApiFailure.UploadCollision()
                } else {
                    ApiFailure.UploadConflict(err)
                }
            }
            410 -> throw ApiFailure.DestinationRevoked()
            422 -> throw ApiFailure.ChecksumMismatch()
            else -> throw mapUploadStatus(response.status)
        }
    }

    override suspend fun cancel(origin: String, native: NativeToken, uploadId: String): MobileUploadDto {
        val response = transport.execute(
            HttpRequest(
                method = "POST",
                url = "$origin/api/v1/mobile/uploads/$uploadId/cancel",
                headers = bearerHeaders(native),
            ),
        )
        when (response.status) {
            200 -> return decodeOrThrow(response, UploadEnvelope.serializer()).upload
            401 -> throw ApiFailure.Unauthorized()
            403 -> throw ApiFailure.Forbidden()
            404 -> throw ApiFailure.InvalidRequest()
            else -> throw mapUploadStatus(response.status)
        }
    }

    private suspend fun getJson(origin: String, native: NativeToken, path: String): HttpResponse {
        return transport.execute(
            HttpRequest(method = "GET", url = "$origin$path", headers = bearerHeaders(native)),
        )
    }

    private fun bearerHeaders(native: NativeToken): Map<String, String> =
        mapOf("Authorization" to "Bearer ${native.value}")

    private fun errorText(response: HttpResponse): String = response.bodyText.orEmpty()

    /** Uploads map 409/410/413/422/507 to their own typed failures; anything
     *  else falls through to the shared status mapper. */
    private fun mapUploadStatus(status: Int): ApiFailure = when (status) {
        401 -> ApiFailure.Unauthorized()
        403 -> ApiFailure.Forbidden()
        410 -> ApiFailure.DestinationRevoked()
        413 -> ApiFailure.UploadTooLarge()
        422 -> ApiFailure.ChecksumMismatch()
        507 -> ApiFailure.StagingFull()
        else -> HttpErrorMapper.mapStatus(status)
    }

    private fun <T> decodeOrThrow(response: HttpResponse, serializer: kotlinx.serialization.KSerializer<T>): T {
        if (response.bodyText.isNullOrBlank()) throw ApiFailure.MalformedResponse("empty response body")
        return try {
            json.decodeFromString(serializer, response.bodyText)
        } catch (e: Exception) {
            throw ApiFailure.MalformedResponse("invalid json response")
        }
    }

    companion object {
        /** Client-side chunk cap — the protocol never sends a larger body. */
        const val MAX_CHUNK_SEND: Int = 1024 * 1024

        fun defaultJson(): Json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    }
}