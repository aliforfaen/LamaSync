package app.lamasync.companion.core

import java.net.URI

/**
 * Navigation policy for the management WebView (pure JVM so it is fully unit
 * testable; [app.lamasync.companion.web.HardenedWebView] wires it into a real
 * WebViewClient).
 *
 * Rules (spec):
 *  - top-level navigation is allowed only to the exact enrolled origin
 *    (https, same host and effective port);
 *  - external https links open in the system browser — without app
 *    credentials (a separate browser process never sees the session cookie);
 *  - http links are treated as external too (never loaded inside the
 *    credential-bearing WebView);
 *  - every other scheme (file, data, blob, javascript, intent, …) is
 *    rejected;
 *  - SSL errors are never proceeded past (handled by the WebView client).
 */
sealed interface NavigationDecision {
    data object Allow : NavigationDecision
    data object OpenExternally : NavigationDecision
    data object Blocked : NavigationDecision
}

object WebViewNavigationPolicy {

    private val SUPPORTED_SCHEMES = setOf("http", "https")

    fun decide(canonicalOrigin: String, requestUrl: String?): NavigationDecision {
        if (requestUrl.isNullOrBlank()) return NavigationDecision.Blocked
        if (requestUrl.length > 4096) return NavigationDecision.Blocked
        val uri = try {
            URI(requestUrl)
        } catch (e: Exception) {
            return NavigationDecision.Blocked
        }
        val scheme = uri.scheme?.lowercase() ?: return NavigationDecision.Blocked
        if (scheme !in SUPPORTED_SCHEMES) return NavigationDecision.Blocked
        if (uri.rawUserInfo != null) return NavigationDecision.Blocked
        return if (scheme == "https" && OriginPolicy.isSameOrigin(canonicalOrigin, requestUrl)) {
            NavigationDecision.Allow
        } else {
            // http(s) on a different origin: hand off, never load in-process.
            NavigationDecision.OpenExternally
        }
    }
}
