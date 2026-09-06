package app.lamasync.companion.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The desktop QR payload (spec, pinned shape):
 * `{"kind":"lamasync.android.enroll","version":1,"serverOrigin":"https://…",
 *   "enrollmentId":"…","secret":"…"}`
 *
 * All fields are bounded before use. Case is preserved for [enrollmentId],
 * [secret] and [serverOrigin] — never uppercased (the legacy CLI QR path
 * uppercases; Android must not).
 */
@Serializable
data class EnrollmentQrPayload(
    val kind: String,
    val version: Int,
    val serverOrigin: String,
    val enrollmentId: String,
    val secret: String,
)

const val QR_KIND_ANDROID_ENROLL = "lamasync.android.enroll"
const val QR_PAYLOAD_VERSION = 1

const val MAX_ENROLLMENT_ID_LENGTH = 128
const val MIN_SECRET_LENGTH = 32
const val MAX_SECRET_LENGTH = 512
const val MAX_QR_TEXT_LENGTH = 4096

sealed interface QrPayloadResult {
    data class Valid(val payload: EnrollmentQrPayload) : QrPayloadResult

    /** Machine-readable reason; the UI maps it to user-facing copy. */
    data class Invalid(val reason: QrRejection) : QrPayloadResult
}

enum class QrRejection {
    MALFORMED_JSON,
    UNSUPPORTED_KIND,
    UNSUPPORTED_VERSION,
    MISSING_FIELD,
    FIELD_TOO_LONG,
    SECRET_OUT_OF_BOUNDS,
    BAD_ENROLLMENT_ID,
    BAD_ORIGIN,
    QR_TEXT_TOO_LONG,
}

object QrPayloadParser {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = false
        coerceInputValues = false
        explicitNulls = false
    }

    private val ENROLLMENT_ID_PATTERN = Regex("^[A-Za-z0-9_-]{1,128}$")

    /** Parses and validates raw scanner output. */
    fun parse(raw: String): QrPayloadResult {
        if (raw.length > MAX_QR_TEXT_LENGTH) {
            return QrPayloadResult.Invalid(QrRejection.QR_TEXT_TOO_LONG)
        }
        val payload: EnrollmentQrPayload = try {
            json.decodeFromString(EnrollmentQrPayload.serializer(), raw)
        } catch (e: Exception) {
            return QrPayloadResult.Invalid(QrRejection.MALFORMED_JSON)
        }
        return validate(payload)
    }

    /** Validates an already-decoded payload (used by tests and re-parses). */
    fun validate(payload: EnrollmentQrPayload): QrPayloadResult {
        if (payload.kind != QR_KIND_ANDROID_ENROLL) {
            return QrPayloadResult.Invalid(QrRejection.UNSUPPORTED_KIND)
        }
        if (payload.version != QR_PAYLOAD_VERSION) {
            return QrPayloadResult.Invalid(QrRejection.UNSUPPORTED_VERSION)
        }
        if (payload.serverOrigin.length > OriginPolicy.MAX_ORIGIN_LENGTH ||
            payload.enrollmentId.length > MAX_ENROLLMENT_ID_LENGTH ||
            payload.secret.length > MAX_SECRET_LENGTH
        ) {
            return QrPayloadResult.Invalid(QrRejection.FIELD_TOO_LONG)
        }
        if (payload.serverOrigin.isBlank() || payload.enrollmentId.isBlank() || payload.secret.isBlank()) {
            return QrPayloadResult.Invalid(QrRejection.MISSING_FIELD)
        }
        if (!ENROLLMENT_ID_PATTERN.matches(payload.enrollmentId)) {
            return QrPayloadResult.Invalid(QrRejection.BAD_ENROLLMENT_ID)
        }
        if (payload.secret.length < MIN_SECRET_LENGTH) {
            return QrPayloadResult.Invalid(QrRejection.SECRET_OUT_OF_BOUNDS)
        }
        when (val check = OriginPolicy.parseHttpsOrigin(payload.serverOrigin)) {
            is OriginCheck.Invalid -> return QrPayloadResult.Invalid(QrRejection.BAD_ORIGIN)
            is OriginCheck.Valid -> Unit
        }
        return QrPayloadResult.Valid(payload)
    }
}
