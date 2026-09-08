package app.lamasync.companion.web

import android.webkit.CookieManager
import android.webkit.ValueCallback
import app.lamasync.companion.network.WebSessionBroker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * Cookie scope seam: installs/removes the SPA session cookie for the exact
 * enrolled origin and REPORTS whether the platform accepted/rejected the
 * operation. The Android implementation is backed by CookieManager;
 * unit tests substitute a fake so repository logic stays network/device free.
 *
 * Both [installSessionCookie] and [clearSessionCookie] are suspend: the
 * platform only reports completion asynchronously through a
 * [ValueCallback], and enrollment/disconnect must not claim success before
 * that completion is observed (finding 3).
 */
interface WebCookieScope {
    /**
     * Installs the session cookie from a bootstrap Set-Cookie header for
     * [origin]. Returns true only when the platform accepted the cookie AND a
     * follow-up read confirms it is present for [origin].
     */
    suspend fun installSessionCookie(origin: String, setCookieHeader: String): Boolean

    /** Returns the `name=value` session-cookie pair for [origin], or null. */
    fun readSessionCookie(origin: String): String?

    /**
     * Expires the session cookie for [origin]. Returns true only when the
     * platform processed the expiry AND the cookie is confirmed gone.
     */
    suspend fun clearSessionCookie(origin: String): Boolean
}

/**
 * CookieManager-backed [WebCookieScope]. Only the `__Host-lamasync-mobile`
 * cookie from the bootstrap response is ever transferred — never the native
 * token or web grant, which remain native-side secrets (spec).
 *
 * `__Host-` prefix rules (finding 3): a cookie whose name starts with
 * `__Host-` MUST be Secure, host-only (no Domain attribute) and have Path=/
 * — and an *expiry* cookie is not exempt. The deletion header therefore
 * repeats the full valid attribute set (Secure, host-only, Path=/) so the
 * platform accepts the removal instead of silently rejecting it and leaving
 * the old session cookie behind.
 *
 * Platform threading: modern WebView CookieManager requires cookie writes to
 * be issued on a thread with a running Looper (`SetCookie must be called on a
 * thread with a running Looper`), so all writes hop to the main thread and
 * suspend on the completion callback instead of blocking it.
 */
class SessionCookieJar : WebCookieScope {

    override suspend fun installSessionCookie(origin: String, setCookieHeader: String): Boolean =
        withContext(Dispatchers.Main) {
            if (WebSessionBroker.cookieName(setCookieHeader) != WebSessionBroker.SESSION_COOKIE_NAME) {
                return@withContext false
            }
            val manager = CookieManager.getInstance()
            manager.setAcceptCookie(true)
            val accepted = writeAndFlush(manager, origin, setCookieHeader)
            // The callback alone is not proof: confirm the cookie actually
            // landed for this exact origin before reporting success.
            accepted && readSessionCookie(origin) == WebSessionBroker.cookiePair(setCookieHeader)
        }

    override fun readSessionCookie(origin: String): String? {
        val raw = CookieManager.getInstance().getCookie(origin) ?: return null
        return raw.split(';')
            .map { it.trim() }
            .firstOrNull { it.startsWith("${WebSessionBroker.SESSION_COOKIE_NAME}=") }
    }

    override suspend fun clearSessionCookie(origin: String): Boolean =
        withContext(Dispatchers.Main) {
            val manager = CookieManager.getInstance()
            val expiry = buildString {
                append(WebSessionBroker.SESSION_COOKIE_NAME)
                append("=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0; ")
                append("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
            }
            val accepted = writeAndFlush(manager, origin, expiry)
            // Removal is verified by reading the store back after the write
            // completed; absence is the honest signal that cleanup succeeded.
            accepted && readSessionCookie(origin) == null
        }

    /**
     * Issues a platform cookie write with a completion callback and waits for
     * it (on the main thread, which owns the required Looper). `null`
     * (callback not delivered within the timeout — some OEM cookie stores
     * never invoke it) is treated as "unknown", and callers fall back to a
     * read-back verification instead of guessing.
     */
    private suspend fun writeAndFlush(
        manager: CookieManager,
        origin: String,
        header: String,
    ): Boolean {
        val callbackResult: Boolean? = withTimeoutOrNull(CALLBACK_TIMEOUT_MILLIS) {
            suspendCancellableCoroutine { cont ->
                try {
                    manager.setCookie(origin, header, ValueCallback { accepted ->
                        if (cont.isActive) cont.resume(accepted)
                    })
                } catch (e: Exception) {
                    if (cont.isActive) cont.resume(false)
                }
            }
        }
        manager.flush()
        return callbackResult != false
    }

    private companion object {
        /** Platform cookie writes normally complete in milliseconds. */
        const val CALLBACK_TIMEOUT_MILLIS = 15_000L
    }
}
