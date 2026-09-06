package app.lamasync.companion.testutil

import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.core.OriginPolicy
import app.lamasync.companion.core.OriginCheck
import app.lamasync.companion.core.EnrollmentQrPayload
import app.lamasync.companion.data.NativeToken
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.RegistrationStore
import app.lamasync.companion.data.SecureCredentialVault
import app.lamasync.companion.data.WebGrant
import app.lamasync.companion.network.HttpRequest
import app.lamasync.companion.network.HttpResponse
import app.lamasync.companion.network.HttpTransport
import app.lamasync.companion.web.WebCookieScope
import java.net.URI

/** Scripted HTTP fake — records requests, returns canned responses or throws. */
class FakeTransport : HttpTransport {

    data class Rule(
        val method: String? = null,
        val urlContains: String? = null,
        val respond: HttpResponse? = null,
        val failWith: ApiFailure? = null,
    )

    val requests = mutableListOf<HttpRequest>()

    private val rules = mutableListOf<Rule>()

    fun enqueue(rule: Rule) {
        rules += rule
    }

    /** Wipes recorded requests AND remaining rules (rules are FIFO). */
    fun clearAll() {
        requests.clear()
        rules.clear()
    }

    override suspend fun execute(request: HttpRequest): HttpResponse {
        requests += request
        for (rule in rules) {
            if (rule.method != null && rule.method != request.method) continue
            if (rule.urlContains != null && !request.url.contains(rule.urlContains)) continue
            rule.failWith?.let { throw it }
            return rule.respond ?: error("rule without response")
        }
        error("no fake rule matched ${request.method} ${request.url}")
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

fun cookieResponse(cookie: String): HttpResponse = HttpResponse(
    status = 200,
    headers = mapOf(
        "set-cookie" to listOf(cookie),
        "content-type" to listOf("application/json; charset=utf-8"),
    ),
    bodyText = """{"csrfToken":"fake-csrf-token"}""",
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

    override fun load(): Registration? = registration
    override fun save(registration: Registration) {
        this.registration = registration
    }

    override fun updateCheckIn(registration: Registration, epochMillis: Long, appVersion: String) {
        save(registration.copy(lastCheckInEpochMillis = epochMillis, lastCheckInAppVersion = appVersion))
    }

    override fun clear() {
        registration = null
    }
}

class FakeCookieScope : WebCookieScope {
    val installed = mutableListOf<String>()
    val cleared = mutableListOf<String>()
    private val cookies = mutableMapOf<String, String>()

    override fun installSessionCookie(origin: String, setCookieHeader: String) {
        installed += origin
        cookies[origin] = setCookieHeader.substringBefore(';')
    }

    override fun readSessionCookie(origin: String): String? = cookies[origin]

    override fun clearSessionCookie(origin: String) {
        cleared += origin
        cookies.remove(origin)
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

fun uriHost(url: String): String = URI(url).host ?: error("no host in $url")
