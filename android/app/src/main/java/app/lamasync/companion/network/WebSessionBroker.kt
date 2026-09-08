package app.lamasync.companion.network

import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.core.HttpErrorMapper
import app.lamasync.companion.data.WebGrant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Bootstrap request body — the grant travels as `grant` (never `webGrant`;
 *  the server schema rejects the wrong key with 422). */
@Serializable
internal data class WebSessionRequestDto(val grant: String)

/** Bootstrap response body (canonical core MobileWebSessionBootstrapResponse).
 *  `csrfToken` is required; the remaining fields ride along for wire
 *  fidelity but are unused by the broker (the SPA re-discovers identity +
 *  CSRF through GET /auth/me once the cookie lands). */
@Serializable
internal data class WebSessionResponseDto(
    val csrfToken: String,
    val hostId: String = "",
    val displayName: String = "",
    val expiresAt: Long = 0L,
)

/** Result of a successful bootstrap: the raw `__Host-lamasync-mobile`
 *  Set-Cookie header (installed into the platform CookieManager for the
 *  exact enrolled origin) plus the session-bound CSRF token that
 *  cookie-authenticated mutations must carry. */
data class BootstrappedSession(
    val cookieHeader: String,
    val csrfToken: String,
)

/**
 * Web-session broker: the ONLY component that touches the [WebGrant]. It
 * bootstraps the SPA session cookie and (as part of disconnect) calls the
 * registration revoke endpoint through an authorized web session.
 *
 * Wire contract (canonical core mobile DTOs, phase-1 spec):
 *   POST {origin}/api/v1/mobile/web-session
 *       body:   {"grant": "<web grant>"} — grant in the JSON body ONLY,
 *               never an Authorization header (a bearer here → 403)
 *       ok 200: sets the `__Host-lamasync-mobile` Set-Cookie header and
 *               returns {"hostId","displayName","expiresAt","csrfToken"}
 *   POST {origin}/api/v1/mobile/registrations/:hostId/revoke
 *       cookie-authenticated admin mutation: requires the session cookie,
 *       the exact enrolled Origin header AND the session CSRF token
 *       (X-CSRF-Token); the server rejects a missing/wrong CSRF with 403.
 *
 * The broker never receives, stores or sends the native token; the native API
 * client never receives the grant.
 */
class WebSessionBroker(
    private val transport: HttpTransport,
    private val json: Json = Json { ignoreUnknownKeys = true },
) {

    /**
     * POSTs the web grant to {origin}/api/v1/mobile/web-session and returns
     * the raw `__Host-lamasync-mobile` Set-Cookie header (name, value and
     * attributes preserved exactly) plus the session-bound CSRF token from
     * the response body. Throws [ApiFailure] on error.
     */
    suspend fun bootstrapWebSession(origin: String, grant: WebGrant): BootstrappedSession {
        val requestBody = json.encodeToString(
            WebSessionRequestDto.serializer(),
            WebSessionRequestDto(grant = grant.value),
        )
        val response = transport.execute(
            HttpRequest(
                method = "POST",
                url = "$origin/api/v1/mobile/web-session",
                headers = mapOf("Content-Type" to "application/json"),
                body = requestBody.toByteArray(Charsets.UTF_8),
            ),
        )
        if (response.status != 200) throw HttpErrorMapper.mapStatus(response.status)
        val sessionCookie = response.headers("set-cookie").firstOrNull { header ->
            cookieName(header) == SESSION_COOKIE_NAME
        }
            ?: throw ApiFailure.MalformedResponse("web session did not issue a session cookie")
        val body = response.bodyText
        val dto = try {
            if (body.isNullOrBlank()) throw IllegalArgumentException("blank body")
            json.decodeFromString(WebSessionResponseDto.serializer(), body)
        } catch (e: Exception) {
            throw ApiFailure.MalformedResponse("web session response missing csrf token")
        }
        if (dto.csrfToken.isBlank()) {
            throw ApiFailure.MalformedResponse("web session response missing csrf token")
        }
        return BootstrappedSession(cookieHeader = sessionCookie, csrfToken = dto.csrfToken)
    }

    /**
     * Best-effort remote revocation through an authorized web session.
     * [cookieHeader] is the `name=value` pair to send (normally re-read from
     * the platform CookieManager); [csrfToken] is the session-bound CSRF
     * token the server requires on every cookie-authenticated mutation. The
     * exact enrolled origin is sent as Origin. Treats 2xx as success.
     */
    suspend fun revokeRegistration(
        origin: String,
        hostId: String,
        cookieHeader: String,
        csrfToken: String,
    ) {
        val response = transport.execute(
            HttpRequest(
                method = "POST",
                url = "$origin/api/v1/mobile/registrations/${hostId}/revoke",
                headers = mapOf(
                    "Cookie" to cookieHeader,
                    "Origin" to origin,
                    CSRF_HEADER to csrfToken,
                    "Content-Type" to "application/json",
                ),
                body = "{}".toByteArray(Charsets.UTF_8),
            ),
        )
        if (response.status !in 200..299) throw HttpErrorMapper.mapStatus(response.status)
    }

    companion object {
        const val SESSION_COOKIE_NAME = "__Host-lamasync-mobile"

        /** Header the session CSRF token travels in (server wave-2 contract). */
        const val CSRF_HEADER = "X-CSRF-Token"

        /** Extracts the cookie name from a full Set-Cookie header value. */
        fun cookieName(setCookieHeader: String): String? {
            val first = setCookieHeader.substringBefore(';').trim()
            val eq = first.indexOf('=')
            return if (eq > 0) first.substring(0, eq).trim() else null
        }

        /** Reduces a full Set-Cookie header to the `name=value` pair. */
        fun cookiePair(setCookieHeader: String): String = setCookieHeader.substringBefore(';').trim()
    }
}
