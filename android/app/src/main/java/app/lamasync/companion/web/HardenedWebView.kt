package app.lamasync.companion.web

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.http.SslError
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
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

        /**
         * The WebView's back stack changed (`doUpdateVisitedHistory`). This is
         * HISTORY ONLY: the platform fires it before `onPageFinished` on a real
         * page commit, so a host must never treat it as a completed load.
         */
        fun onWebHistoryChanged(canGoBack: Boolean)

        /**
         * A main-frame load started (`loading = true`) or finished
         * (`loading = false`). Only the `false` edge — `onPageFinished` — is a
         * load terminal event for the hosting shell.
         */
        fun onWebLoadStateChanged(canGoBack: Boolean, loading: Boolean)

        /**
         * LAMA-334: a MAIN-FRAME load failed (offline, unreachable host, a
         * refused connection). The WebView shows its own error page; the shell
         * needs this to retire a refresh indicator that would otherwise wait
         * for a `onPageFinished` that a hard failure may never deliver.
         *
         * Defaulted to a no-op so listeners that do not care about load
         * failures do not have to spell one out.
         */
        fun onLoadFailed(url: String, description: String?) = Unit
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

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                listener.onWebLoadStateChanged(view?.canGoBack() == true, loading = true)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                listener.onWebLoadStateChanged(view?.canGoBack() == true, loading = false)
            }

            override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, url, isReload)
                // History only. This can arrive BEFORE onPageFinished, so it must
                // not be reported as a finished load (LAMA-334 review finding 2).
                listener.onWebHistoryChanged(view?.canGoBack() == true)
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                super.onReceivedError(view, request, error)
                // Sub-resource failures are not page failures: a blocked icon
                // must not be reported as "the page did not load".
                if (request?.isForMainFrame != true) return
                listener.onLoadFailed(
                    url = request.url?.toString() ?: "",
                    description = error?.description?.toString(),
                )
            }

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
