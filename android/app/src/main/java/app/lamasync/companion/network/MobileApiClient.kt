package app.lamasync.companion.network

import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.core.HttpErrorMapper
import app.lamasync.companion.data.NativeToken
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Wire contract mirror (phase 1) — canonical DTOs live in packages/core;
 * these Kotlin mirrors follow the spec-pinned route/status contract:
 *
 * Routes (spec):
 *   POST {origin}/api/v1/mobile/enrollments/:id/exchange
 *       body:   {"secret","displayName","appVersion"}   (enrollmentId is the path param)
 *       ok 200: {"hostId","nativeToken","webGrant","serverOrigin","displayName","clientType"}
 *   GET  {origin}/api/v1/mobile/me            (Authorization: Bearer <native token>)
 *       ok 200: {"hostId","displayName","clientType","appVersion","pairedAt","serverOrigin"}
 *   POST {origin}/api/v1/mobile/check-in      (Authorization: Bearer <native token>)
 *       body:   {"appVersion"}
 *       ok 200: {"hostId","lastSeenAt"}
 *   POST {origin}/api/v1/mobile/web-session   (web grant in JSON body — never a bearer header)
 *       body:   {"grant"}                      (WebSessionBroker owns this call)
 *   POST {origin}/api/v1/mobile/registrations/:hostId/revoke (authorized web session)
 *
 * Errors: 400 invalid shape/origin; 401 absent/invalid/revoked authority;
 * 403 wrong permission; 409 consumed; 410 expired; 429 throttled.
 *
 * The native client NEVER sends the web grant and the broker NEVER sends the
 * native token: [NativeToken] and [WebGrant] are distinct, non-interchangeable
 * types (see data/Credentials.kt).
 */

@Serializable
internal data class ExchangeRequestDto(
    val secret: String,
    val displayName: String,
    val appVersion: String,
)

@Serializable
data class ExchangeResponseDto(
    val hostId: String,
    val displayName: String,
    val nativeToken: String,
    val webGrant: String,
    val serverOrigin: String = "",
    val clientType: String = "android",
)

@Serializable
data class MeResponseDto(
    val hostId: String,
    val displayName: String,
    val clientType: String,
    val appVersion: String,
    val pairedAt: Long = 0L,
    val serverOrigin: String = "",
)

@Serializable
internal data class CheckInRequestDto(val appVersion: String)

/** Parsed exchange/identity results handed to the repository. */
data class ExchangeResult(
    val hostId: String,
    val displayName: String,
    val nativeToken: NativeToken,
    val webGrant: app.lamasync.companion.data.WebGrant,
)

data class MeProfile(
    val hostId: String,
    val displayName: String,
    val clientType: String,
    val appVersion: String,
)

/**
 * Native API client. Owns ONLY the native token ([NativeToken]) — it has no
 * code path, parameter or storage reference for the web grant. All methods
 * take an https [origin] produced by [OriginPolicy].
 */
class MobileApiClient(
    private val transport: HttpTransport,
    private val json: Json = defaultJson(),
) {

    suspend fun exchangeEnrollment(
        origin: String,
        enrollmentId: String,
        secret: String,
        displayName: String,
        appVersion: String,
    ): ExchangeResult {
        val requestBody = json.encodeToString(
            ExchangeRequestDto.serializer(),
            ExchangeRequestDto(secret, displayName, appVersion),
        )
        val response = postJsonBody("$origin/api/v1/mobile/enrollments/$enrollmentId/exchange", requestBody)
        if (response.status != 200) throw HttpErrorMapper.mapStatus(response.status)
        val dto = decodeOrThrow(response.bodyText, ExchangeResponseDto.serializer())
        if (dto.hostId.isBlank() || dto.nativeToken.isBlank() || dto.webGrant.isBlank()) {
            throw ApiFailure.MalformedResponse("exchange response missing fields")
        }
        return ExchangeResult(
            hostId = dto.hostId,
            displayName = dto.displayName,
            nativeToken = NativeToken.of(dto.nativeToken),
            webGrant = app.lamasync.companion.data.WebGrant.of(dto.webGrant),
        )
    }

    suspend fun me(origin: String, nativeToken: NativeToken): MeProfile {
        val response = transport.execute(
            HttpRequest(
                method = "GET",
                url = "$origin/api/v1/mobile/me",
                headers = bearerHeaders(nativeToken),
            ),
        )
        if (response.status != 200) throw HttpErrorMapper.mapStatus(response.status)
        val dto = decodeOrThrow(response.bodyText, MeResponseDto.serializer())
        return MeProfile(
            hostId = dto.hostId,
            displayName = dto.displayName,
            clientType = dto.clientType,
            appVersion = dto.appVersion,
        )
    }

    suspend fun checkIn(origin: String, nativeToken: NativeToken, appVersion: String) {
        val requestBody = json.encodeToString(
            CheckInRequestDto.serializer(),
            CheckInRequestDto(appVersion = appVersion),
        )
        val response = postJsonBody(
            "$origin/api/v1/mobile/check-in",
            requestBody,
            bearerHeaders(nativeToken),
        )
        if (response.status != 200) throw HttpErrorMapper.mapStatus(response.status)
    }

    /** Authorization header built from the native token only. */
    private fun bearerHeaders(nativeToken: NativeToken): Map<String, String> =
        mapOf("Authorization" to "Bearer ${nativeToken.value}")

    private suspend fun postJsonBody(
        url: String,
        jsonBody: String,
        headers: Map<String, String> = emptyMap(),
    ): HttpResponse = transport.execute(
        HttpRequest(
            method = "POST",
            url = url,
            headers = headers + mapOf("Content-Type" to "application/json"),
            body = jsonBody.toByteArray(Charsets.UTF_8),
        ),
    )

    private fun <T> decodeOrThrow(bodyText: String?, serializer: kotlinx.serialization.KSerializer<T>): T {
        if (bodyText.isNullOrBlank()) throw ApiFailure.MalformedResponse("empty response body")
        return try {
            json.decodeFromString(serializer, bodyText)
        } catch (e: Exception) {
            throw ApiFailure.MalformedResponse("invalid json response")
        }
    }

    companion object {
        fun defaultJson(): Json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    }
}
