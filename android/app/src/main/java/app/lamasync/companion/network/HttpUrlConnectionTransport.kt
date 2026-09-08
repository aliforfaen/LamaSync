package app.lamasync.companion.network

import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.core.OriginPolicy
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * HttpsURLConnection-backed transport (Android).
 *
 * Security properties:
 *  - HTTPS only: callers build https URLs from validated origins; no cleartext
 *    transport exists (the debug network-security-config permits no cleartext
 *    either).
 *  - Auto-following of redirects is disabled. GET/HEAD may follow up to
 *    [MAX_REDIRECTS] redirects, but only when the Location target is the same
 *    origin as the request; POST (credential exchange / web-session bootstrap
 *    / revoke) redirects are always rejected so secrets can never be replayed
 *    to another origin.
 *  - Standard platform certificate validation (release and debug; debug adds
 *    user-installed CAs only for local TLS development).
 *  - Response bodies are read up to [HttpRequest.maxResponseBytes].
 */
class HttpUrlConnectionTransport : HttpTransport {

    override suspend fun execute(request: HttpRequest): HttpResponse =
        withContext(Dispatchers.IO) { executeBlocking(request) }

    private fun executeBlocking(request: HttpRequest): HttpResponse {
        var connection: HttpURLConnection? = null
        try {
            var currentUrl = request.url
            var redirects = 0
            while (true) {
                val url = URL(currentUrl)
                require(url.protocol == "https") { "only https urls are supported" }
                val conn = url.openConnection() as HttpsURLConnection
                connection = conn
                conn.requestMethod = request.method
                conn.instanceFollowRedirects = false
                conn.connectTimeout = CONNECT_TIMEOUT_MS
                conn.readTimeout = READ_TIMEOUT_MS
                conn.setRequestProperty("Accept", "application/json")
                conn.setRequestProperty("User-Agent", USER_AGENT)
                request.headers.forEach { (name, value) -> conn.setRequestProperty(name, value) }
                if (request.body != null) {
                    conn.doOutput = true
                    conn.setFixedLengthStreamingMode(request.body.size)
                    conn.outputStream.use { it.write(request.body) }
                }
                val status = conn.responseCode
                val location = conn.getHeaderField("Location")
                if (status !in REDIRECT_STATUSES) {
                    val headers = conn.headerFields
                        .filterKeys { it != null }
                        .mapKeys { (name, _) -> name!!.lowercase() }
                    val body = readBody(conn, status, request.maxResponseBytes)
                    return HttpResponse(status, headers, body, currentUrl)
                }
                // Redirect handling.
                if (request.method != "GET" && request.method != "HEAD") {
                    throw ApiFailure.MalformedResponse("redirects are not allowed for ${request.method}")
                }
                if (location == null) {
                    throw ApiFailure.MalformedResponse("redirect without Location")
                }
                val target = URL(URL(currentUrl), location).toString()
                if (!OriginPolicy.isSameOrigin(request.url, target)) {
                    throw ApiFailure.MalformedResponse("cross-origin redirect rejected")
                }
                redirects += 1
                if (redirects > MAX_REDIRECTS) {
                    throw ApiFailure.MalformedResponse("too many redirects")
                }
                conn.disconnect()
                connection = null
                currentUrl = target
            }
        } catch (e: ApiFailure) {
            throw e
        } catch (e: SSLException) {
            throw TransportErrors.networkFailure(ApiFailure.Network.CauseKind.TLS, e)
        } catch (e: java.net.SocketTimeoutException) {
            throw TransportErrors.networkFailure(ApiFailure.Network.CauseKind.TIMEOUT, e)
        } catch (e: java.net.UnknownHostException) {
            throw TransportErrors.networkFailure(ApiFailure.Network.CauseKind.CONNECT, e)
        } catch (e: java.net.ConnectException) {
            throw TransportErrors.networkFailure(ApiFailure.Network.CauseKind.CONNECT, e)
        } catch (e: IOException) {
            throw TransportErrors.networkFailure(ApiFailure.Network.CauseKind.IO, e)
        } catch (e: IllegalArgumentException) {
            throw ApiFailure.MalformedResponse(e.message ?: "invalid request url")
        } finally {
            connection?.disconnect()
        }
    }

    private fun readBody(conn: HttpURLConnection, status: Int, maxBytes: Int): String? {
        val stream = if (status >= 400) conn.errorStream else conn.inputStream
            ?: return null
        val bytes = stream.use { input ->
            val buffer = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(8192)
            var total = 0
            while (true) {
                val read = input.read(chunk)
                if (read == -1) break
                total += read
                if (total > maxBytes) {
                    throw ApiFailure.MalformedResponse("response body exceeds $maxBytes bytes")
                }
                buffer.write(chunk, 0, read)
            }
            buffer.toByteArray()
        }
        if (bytes.isEmpty()) return null
        val contentType = conn.contentType?.lowercase() ?: ""
        val charset = Regex("charset=([a-z0-9_-]+)")
            .find(contentType)
            ?.groupValues
            ?.get(1)
            ?.let { runCatching { java.nio.charset.Charset.forName(it) }.getOrNull() }
            ?: StandardCharsets.UTF_8
        return String(bytes, charset)
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 30_000
        const val MAX_REDIRECTS = 3
        val REDIRECT_STATUSES = setOf(301, 302, 303, 307, 308)
        const val USER_AGENT = "lamasync-android-companion/0.1.0"
    }
}
