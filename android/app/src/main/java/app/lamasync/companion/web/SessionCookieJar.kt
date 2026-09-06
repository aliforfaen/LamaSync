package app.lamasync.companion.web

import android.webkit.CookieManager
import app.lamasync.companion.network.WebSessionBroker

/**
 * Cookie scope seam: installs/removes the SPA session cookie for the exact
 * enrolled origin. The Android implementation is backed by CookieManager;
 * unit tests substitute a fake so repository logic stays network/device free.
 */
interface WebCookieScope {
    fun installSessionCookie(origin: String, setCookieHeader: String)
    fun readSessionCookie(origin: String): String?
    fun clearSessionCookie(origin: String)
}

/**
 * CookieManager-backed [WebCookieScope]. Only the `__Host-lamasync-mobile`
 * cookie from the bootstrap response is ever transferred — never the native
 * token or web grant, which remain native-side secrets (spec).
 */
class SessionCookieJar : WebCookieScope {

    override fun installSessionCookie(origin: String, setCookieHeader: String) {
        if (WebSessionBroker.cookieName(setCookieHeader) != WebSessionBroker.SESSION_COOKIE_NAME) {
            return
        }
        val manager = CookieManager.getInstance()
        manager.setAcceptCookie(true)
        manager.setCookie(origin, setCookieHeader)
        manager.flush()
    }

    override fun readSessionCookie(origin: String): String? =
        CookieManager.getInstance().getCookie(origin)
            ?.split(';')
            ?.map { it.trim() }
            ?.firstOrNull { it.startsWith("${WebSessionBroker.SESSION_COOKIE_NAME}=") }

    override fun clearSessionCookie(origin: String) {
        val manager = CookieManager.getInstance()
        manager.setCookie(
            origin,
            "${WebSessionBroker.SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        )
        manager.flush()
    }
}
