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

    // LAMA-296 stage 1 upload flow failures (409/410/413/422/507 semantics
    // differ from enrollment 409/410, so uploads map their own payloads).

    /** 409 — upload protocol conflict (wrong offset, busy, stale state). */
    class UploadConflict(message: String = "upload conflict") : ApiFailure(message)

    /** 409 — finalize refused: expected size not fully received. */
    class UploadIncomplete : ApiFailure("upload is not complete")

    /** 409 — final-name collision; a rename is required. */
    class UploadCollision : ApiFailure("a file with this name already exists at the destination")

    /** 410 — the destination grant was revoked. */
    class DestinationRevoked : ApiFailure("destination revoked")

    /** 413 — chunk or declared size over the server cap. */
    class UploadTooLarge : ApiFailure("file or chunk exceeds the server limit")

    /** 422 — declared checksum mismatch at finalize. */
    class ChecksumMismatch : ApiFailure("checksum mismatch")

    /** 507 — server staging space exhausted. */
    class StagingFull : ApiFailure("server upload staging is full")

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
