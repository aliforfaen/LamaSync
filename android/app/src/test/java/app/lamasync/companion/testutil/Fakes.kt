package app.lamasync.companion.testutil

import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.core.OriginPolicy
import app.lamasync.companion.core.OriginCheck
import app.lamasync.companion.core.EnrollmentQrPayload
import app.lamasync.companion.data.EnrollmentBinding
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.RegistrationStore
import app.lamasync.companion.data.SecureCredentialVault
import app.lamasync.companion.data.WebGrant
import app.lamasync.companion.network.HttpRequest
import app.lamasync.companion.network.HttpResponse
import app.lamasync.companion.network.HttpTransport
import app.lamasync.companion.network.WebSessionBroker
import app.lamasync.companion.web.WebCookieScope
import java.net.URI
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Scripted HTTP fake — records requests, returns canned responses or throws.
 *
 * Server-fidelity enforcement (finding 2): a real Elysia deployment accepts a
 * cookie-authenticated mutation only when the presented cookie AND CSRF token
 * belong to the SAME live session. The fake mirrors that for `/revoke`: when a
 * `/web-session` call has issued a cookie, any later `/revoke` whose Cookie
 * header (or CSRF token) does not match that issuance is rejected with 403 —
 * so a disconnect implementation that mixes a stale CookieManager cookie with
 * a fresh bootstrap CSRF fails loudly here instead of passing.
 */
class FakeTransport : HttpTransport {

    data class Rule(
        val method: String? = null,
        val urlContains: String? = null,
        val respond: HttpResponse? = null,
        val failWith: ApiFailure? = null,
    )

    val requests = mutableListOf<HttpRequest>()

    private val rules = mutableListOf<Rule>()
    private var issuedCookiePair: String? = null
    private var issuedCsrf: String? = null

    fun enqueue(rule: Rule) {
        rules += rule
    }

    /** Wipes recorded requests AND remaining rules (rules are FIFO). */
    fun clearAll() {
        requests.clear()
        rules.clear()
        issuedCookiePair = null
        issuedCsrf = null
    }

    override suspend fun execute(request: HttpRequest): HttpResponse {
        requests += request
        // Rules are consumed FIFO: each scripted call (including a failing
        // one) is removed once matched, so a scenario can be expressed as
        // "bootstrap fails once, then succeeds" by enqueueing in order.
        val index = rules.indexOfFirst { rule ->
            (rule.method == null || rule.method == request.method) &&
                (rule.urlContains == null || request.url.contains(rule.urlContains))
        }
        if (index < 0) error("no fake rule matched ${request.method} ${request.url}")
        val rule = rules.removeAt(index)
        rule.failWith?.let { throw it }
        val response = rule.respond ?: error("rule without response")

        val setCookie = response.headers("set-cookie").firstOrNull()
        if (setCookie != null && request.url.contains("/web-session")) {
            issuedCookiePair = WebSessionBroker.cookiePair(setCookie)
            issuedCsrf = csrfFromBody(response.bodyText)
        }

        if (request.url.contains("/revoke")) {
            enforceSessionCorrespondence(request)
        }
        return response
    }

    /**
     * The fake server accepts the revoke only when the request presents the
     * cookie and CSRF token issued by the most recent bootstrap. A mismatch —
     * stale cookie from CookieManager, missing cookie, or a foreign CSRF —
     * yields 403, exactly like the real route.
     */
    private fun enforceSessionCorrespondence(request: HttpRequest) {
        val presentedCookie = request.headers["Cookie"]
        val presentedCsrf = request.headers[WebSessionBroker.CSRF_HEADER]
        val expectedCookie = issuedCookiePair
        val expectedCsrf = issuedCsrf
        val cookieOk = expectedCookie != null && presentedCookie == expectedCookie
        val csrfOk = expectedCsrf == null || presentedCsrf == expectedCsrf
        if (!cookieOk || !csrfOk) {
            throw ApiFailure.Forbidden()
        }
    }

    private fun csrfFromBody(body: String?): String? = try {
        Json.parseToJsonElement(body.orEmpty()).jsonObject["csrfToken"]?.jsonPrimitive?.content
    } catch (e: Exception) {
        null
    }

    /** Wire-text helpers for role-separation assertions. */
    fun wireOf(request: HttpRequest): String {
        val bodyText = request.body?.toString(Charsets.UTF_8).orEmpty()
        return request.headers.entries.joinToString("\n") { "${it.key}: ${it.value}" } +
            "\n" + bodyText
    }
}

fun jsonResponse(status: Int, body: String): HttpResponse {
    val bytes = body.toByteArray(Charsets.UTF_8)
    return HttpResponse(
        status = status,
        headers = mapOf(
            "content-type" to listOf("application/json; charset=utf-8"),
            "content-length" to listOf(bytes.size.toString()),
        ),
        bodyText = body,
        finalUrl = "",
    )
}

/** 200 web-session bootstrap response carrying [cookie] and [csrf]. */
fun cookieResponse(cookie: String, csrf: String = "fake-csrf-token"): HttpResponse = HttpResponse(
    status = 200,
    headers = mapOf(
        "set-cookie" to listOf(cookie),
        "content-type" to listOf("application/json; charset=utf-8"),
    ),
    bodyText = """{"csrfToken":"$csrf"}""",
    finalUrl = "",
)

/** In-memory vault fake: secrets are held off-wire only for test assertions. */
class FakeVault : SecureCredentialVault {
    var native: NativeToken? = null
    var grant: WebGrant? = null
    var cleared = false

    override fun saveCredentials(nativeToken: NativeToken, webGrant: WebGrant) {
        native = nativeToken
        grant = webGrant
    }

    override fun nativeToken(): NativeToken? = native
    override fun webGrant(): WebGrant? = grant
    override fun hasCredentials(): Boolean = native != null

    override fun clear() {
        native = null
        grant = null
        cleared = true
    }
}

class FakeRegistrationStore : RegistrationStore {
    var registration: Registration? = null
    var binding: EnrollmentBinding? = null

    override fun load(): Registration? = registration
    override fun save(registration: Registration) {
        this.registration = registration
    }

    override fun updateCheckIn(registration: Registration, epochMillis: Long, appVersion: String) {
        save(registration.copy(lastCheckInEpochMillis = epochMillis, lastCheckInAppVersion = appVersion))
    }

    override fun loadBinding(): EnrollmentBinding? = binding
    override fun saveBinding(binding: EnrollmentBinding) {
        this.binding = binding
    }

    override fun clear() {
        registration = null
        binding = null
    }
}

class FakeCookieScope : WebCookieScope {
    val installed = mutableListOf<String>()
    val cleared = mutableListOf<String>()
    private val cookies = mutableMapOf<String, String>()

    /** When true, installs are rejected (platform refused the cookie). */
    var rejectInstall = false

    /** When true, expiry reports failure (platform could not remove the cookie). */
    var failClear = false

    override suspend fun installSessionCookie(origin: String, setCookieHeader: String): Boolean {
        if (rejectInstall) return false
        installed += origin
        cookies[origin] = WebSessionBroker.cookiePair(setCookieHeader)
        return true
    }

    override fun readSessionCookie(origin: String): String? = cookies[origin]

    override suspend fun clearSessionCookie(origin: String): Boolean {
        cleared += origin
        if (failClear) return false
        cookies.remove(origin)
        return true
    }
}

/** Builds a canonical origin or fails the test. */
fun canonicalOrigin(url: String): String =
    (OriginPolicy.parseHttpsOrigin(url) as OriginCheck.Valid).origin

fun sampleQr(origin: String = "https://fleet.example.com"): EnrollmentQrPayload =
    EnrollmentQrPayload(
        kind = "lamasync.android.enroll",
        version = 1,
        serverOrigin = origin,
        enrollmentId = "enr_AbC123",
        secret = "aBcD1234567890aBcD1234567890aBcD1234567890aBcD1234567890",
    )

fun sampleQrWith(origin: String, enrollmentId: String): EnrollmentQrPayload =
    sampleQr(origin = origin).copy(enrollmentId = enrollmentId)

fun uriHost(url: String): String = URI(url).host ?: error("no host in $url")
