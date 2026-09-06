package app.lamasync.companion.web

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.http.SslError
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import app.lamasync.companion.core.NavigationDecision
import app.lamasync.companion.core.WebViewNavigationPolicy

/**
 * Management WebView construction and hardening (spec).
 *
 *  - top-level navigation only to the exact enrolled origin
 *    ([WebViewNavigationPolicy]);
 *  - external https links are handed to [Listener.onOpenExternally] — the
 *    system browser is a separate process and never sees app credentials;
 *  - unsafe schemes are blocked; SSL errors are always cancelled;
 *  - file access, content access and mixed content are disabled;
 *  - JavaScript is enabled only because the SPA needs it; no native bridge,
 *    no per-request auth injection.
 */
object HardenedWebView {

    interface Listener {
        fun onOpenExternally(url: String)
        fun onBlockedNavigation(url: String)
        fun onBlockedSsl(url: String)
        fun onPageTitle(title: String?)
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun create(
        context: Context,
        canonicalOrigin: String,
        debugAllowWebContentsDebugging: Boolean,
        listener: Listener,
    ): WebView {
        val webView = WebView(context)
        webView.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )

        val settings = webView.settings
        // The SPA is a real web app: JS + DOM storage are required.
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = false
        // No local file/content access of any kind.
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.allowFileAccessFromFileURLs = false
        settings.allowUniversalAccessFromFileURLs = false
        // Never load mixed content inside the credential-bearing WebView.
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.mediaPlaybackRequiresUserGesture = true
        settings.setSupportMultipleWindows(false)
        WebView.setWebContentsDebuggingEnabled(debugAllowWebContentsDebugging)

        // Third-party cookies are not needed by the SPA (SameSite=Strict
        // session cookie); disable them to shrink the tracking surface.
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView?, title: String?) {
                listener.onPageTitle(title)
            }
        }

        webView.webViewClient = object : WebViewClient() {

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?,
            ): Boolean {
                val url = request?.url?.toString() ?: return false
                // Sub-resources load normally; only top-level navigation is
                // policy gated. Host-only cookie scope already prevents the
                // session cookie from reaching other origins.
                if (request?.isForMainFrame == false) return false
                return when (WebViewNavigationPolicy.decide(canonicalOrigin, url)) {
                    NavigationDecision.Allow -> false
                    NavigationDecision.OpenExternally -> {
                        listener.onOpenExternally(url)
                        true
                    }
                    NavigationDecision.Blocked -> {
                        listener.onBlockedNavigation(url)
                        true
                    }
                }
            }

            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                // Never proceed past certificate errors (spec).
                handler?.cancel()
                listener.onBlockedSsl(error?.url ?: canonicalOrigin)
            }
        }
        return webView
    }
}
