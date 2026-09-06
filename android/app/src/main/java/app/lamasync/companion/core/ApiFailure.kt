package app.lamasync.companion.core

/**
 * Typed enrollment/API errors mapped from HTTP status codes.
 *
 * Status contract (spec — shared with the server wave):
 * 400 invalid shape/origin, 401 absent/invalid/revoked authority,
 * 403 valid authority without permission, 409 consumed enrollment,
 * 410 expired enrollment, 429 throttled.
 */
sealed class ApiFailure(message: String) : Exception(message) {
    /** 400 — malformed request body/origin. */
    class InvalidRequest : ApiFailure("invalid request")

    /** 401 — the enrollment secret (or native token) was rejected or revoked. */
    class Unauthorized : ApiFailure("unauthorized")

    /** 403 — valid authority without the required permission. */
    class Forbidden : ApiFailure("forbidden")

    /** 409 — enrollment already consumed by an earlier exchange. */
    class EnrollmentConsumed : ApiFailure("enrollment already used")

    /** 410 — enrollment expired (ten-minute lifetime, spec). */
    class EnrollmentExpired : ApiFailure("enrollment expired")

    /** 429 — exchange rate limit exceeded. */
    class Throttled : ApiFailure("throttled")

    /** 5xx or unexpected status. */
    class Server(status: Int) : ApiFailure("server error $status")

    /** Transport failure: DNS, connect, timeout, TLS. */
    class Network(val causeKind: CauseKind, cause: Exception) : ApiFailure("network failure") {
        enum class CauseKind { CONNECT, TIMEOUT, TLS, IO }
    }

    /** Unexpected non-HTTP failure while producing a request/response. */
    class MalformedResponse(message: String) : ApiFailure(message)
}

/** Maps raw HTTP results onto [ApiFailure]; transport exceptions map to [ApiFailure.Network]. */
object HttpErrorMapper {

    /**
     * @param phase distinguishes exchange semantics (409/410 apply) from
     *   credentialed calls (401 means revoked authority) so user copy can be
     *   precise; the status->failure mapping itself is uniform.
     */
    fun mapStatus(status: Int): ApiFailure = when (status) {
        400 -> ApiFailure.InvalidRequest()
        401 -> ApiFailure.Unauthorized()
        403 -> ApiFailure.Forbidden()
        409 -> ApiFailure.EnrollmentConsumed()
        410 -> ApiFailure.EnrollmentExpired()
        429 -> ApiFailure.Throttled()
        in 500..599 -> ApiFailure.Server(status)
        else -> ApiFailure.Server(status)
    }
}
