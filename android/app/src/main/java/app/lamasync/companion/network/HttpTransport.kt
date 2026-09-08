package app.lamasync.companion.network

import app.lamasync.companion.core.ApiFailure

/** Transport-level request. Bodies are bytes so tests stay byte-exact. */
data class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray? = null,
    val maxResponseBytes: Int = DEFAULT_MAX_RESPONSE_BYTES,
) {
    companion object {
        const val DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024
    }
}

data class HttpResponse(
    val status: Int,
    /** Header names lowercased; values keep original casing. */
    val headers: Map<String, List<String>>,
    val bodyText: String?,
    val finalUrl: String,
) {
    fun header(name: String): String? = headers[name.lowercase()]?.firstOrNull()
    fun headers(name: String): List<String> = headers[name.lowercase()].orEmpty()
}

/**
 * Minimal HTTP seam. Implementations MUST NOT follow cross-origin redirects
 * and MUST NOT leak credentials to a different origin. The Android
 * implementation ([HttpUrlConnectionTransport]) enforces same-origin redirect
 * policy; unit tests use fakes, so tests never touch the network.
 */
interface HttpTransport {
    suspend fun execute(request: HttpRequest): HttpResponse
}

/** Helper for transport implementations. */
object TransportErrors {
    fun networkFailure(causeKind: ApiFailure.Network.CauseKind, cause: Exception): ApiFailure.Network =
        ApiFailure.Network(causeKind, cause)
}
