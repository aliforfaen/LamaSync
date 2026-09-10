package app.lamasync.companion.web

/**
 * LAMA-329 — the embedded display-mode signal.
 *
 * The Compose shell tells the SPA it is running inside the hardened WebView so
 * the web UI can adjust *presentation only* (for example to suppress browser-only
 * affordances such as "install app"). It is delivered as an initial URL
 * parameter on the enrolled origin and consumed by the SPA into session state.
 *
 * Contract, deliberately narrow:
 *
 *  - it is **not** a credential, a capability or an authorization input. A
 *    browser that set the parameter by hand gains nothing: the parameter never
 *    reaches the server (the SPA's requests are unchanged) and every
 *    authorization decision stays on the session cookie and the API key;
 *  - it is carried on the **enrolled origin only** (the WebView refuses to load
 *    any other origin in-process — see [app.lamasync.companion.core.WebViewNavigationPolicy]),
 *    so it cannot be reflected cross-origin;
 *  - it is idempotent and additive: because the SPA is hash-routed, the
 *    parameter survives client-side navigation, and the deep-link path
 *    ([app.lamasync.companion.ui.SessionViewModel.navigateWebTo]) may load a
 *    plain same-origin URL without it — the SPA is expected to remember the
 *    signal for the session rather than re-read it per navigation.
 */
object WebShellSignal {

    /** Query parameter name. Mirrored by `packages/web-ui/src/shell.ts`. */
    const val PARAM = "lamasyncShell"

    /** The only value this app sends. */
    const val EMBEDDED_VALUE = "android"

    /** The initial document URL for [origin], carrying the embedded signal. */
    fun initialUrl(origin: String): String {
        val base = origin.trimEnd('/')
        return "$base/?$PARAM=$EMBEDDED_VALUE"
    }

    /**
     * True when [url] already carries the embedded signal. Used to keep the
     * parameter on a reload/rewrite instead of silently dropping it.
     */
    fun carriesEmbeddedSignal(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        val query = url.substringAfter('?', missingDelimiterValue = "")
        if (query.isEmpty()) return false
        return query.substringBefore('#').split('&').any { pair ->
            val name = pair.substringBefore('=', pair)
            val value = pair.substringAfter('=', "")
            name == PARAM && value == EMBEDDED_VALUE
        }
    }
}
