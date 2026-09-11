package app.lamasync.companion.ui

import android.webkit.WebView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.platform.LocalContext
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import app.lamasync.companion.BuildConfig
import app.lamasync.companion.web.HardenedWebView
import app.lamasync.companion.web.WebShellSignal

/**
 * LAMA-329 — the WebView's shared handle.
 *
 * The shell's top app bar (refresh) and its Android-back handling both need to
 * reach into the WebView, which lives in a different composable subtree. This
 * object is the single, explicitly-scoped channel between them: it holds no
 * credentials and exposes only history/reload operations, so the security
 * boundary of [HardenedWebView] is unchanged.
 */
@Stable
class ManageWebState {

    internal var webView: WebView? = null
    internal var swipeRefresh: SwipeRefreshLayout? = null

    /** Whether the WebView has history to walk before back leaves the shell. */
    var canGoBack by mutableStateOf(false)
        private set

    /** A page load is in flight. */
    var loading by mutableStateOf(false)
        private set

    /** The refresh indicator is showing (top-bar refresh or a pull gesture). */
    var refreshing by mutableStateOf(false)
        private set

    internal fun onWebStateChanged(canGoBack: Boolean, loading: Boolean) {
        this.canGoBack = canGoBack
        this.loading = loading
        if (!loading) refreshing = false
    }

    /** Walks the WebView's own history. Returns false when there is none. */
    fun goBack(): Boolean {
        val view = webView ?: return false
        if (!view.canGoBack()) return false
        view.goBack()
        return true
    }

    internal fun reload() {
        refreshing = true
        webView?.reload()
    }

    internal fun clear() {
        webView = null
        swipeRefresh = null
        canGoBack = false
        loading = false
        refreshing = false
    }
}

@Composable
fun rememberManageWebState(): ManageWebState = remember { ManageWebState() }

/**
 * The pull-to-refresh gate, as a named function so the acceptance rule it
 * encodes can be tested against a real WebView rather than assumed.
 *
 * A WebView scrolls ITSELF (its document scroll is the view's own scroll), so
 * `scrollY` is the page position — including inside a nested scroller, where it
 * stays 0 and the gesture is therefore allowed. It is never negative.
 */
internal fun webViewAtScrollTop(webView: WebView): Boolean = webView.scrollY <= 0

/**
 * Wires [webView] into this pull-to-refresh container exactly as the Manage
 * destination does.
 *
 * Extracted so the acceptance gate ("pull-to-refresh cannot fire while a nested
 * page is scrolled away from top") can be tested against a real
 * `SwipeRefreshLayout` and a real `WebView`, rather than only reasoned about.
 */
internal fun SwipeRefreshLayout.bindToWebView(webView: WebView, onRefresh: () -> Unit) {
    addView(webView)
    setOnChildScrollUpCallback { _, _ -> !webViewAtScrollTop(webView) }
    setOnRefreshListener(onRefresh)
}

/**
 * The management surface: the hardened WebView on the enrolled origin, inside a
 * pull-to-refresh container.
 *
 * Pull-to-refresh deliberately uses the View-based `SwipeRefreshLayout` rather
 * than Compose's `Modifier.pullToRefresh`: the latter is driven by nested
 * scroll, and an `AndroidView` host does not dispatch nested scroll, so the
 * gesture would never fire. `setOnChildScrollUpCallback` is also the supported
 * way to honour the acceptance gate that a pull can never start while the page
 * is scrolled away from the top — which a nested-scroll-only implementation
 * cannot express for a WebView.
 */
@Composable
fun ManageWebSurface(
    state: ManageWebState,
    origin: String,
    pullToRefreshEnabled: Boolean,
    navUrl: String?,
    onNavUrlConsumed: () -> Unit,
    onOpenExternally: (String) -> Unit,
    onNotify: (String) -> Unit,
) {
    val context = LocalContext.current
    val colorScheme = MaterialTheme.colorScheme

    // The listener is remembered across recompositions, so the callbacks have
    // to be read through rememberUpdatedState or it would hold the first ones.
    val currentOpenExternally by rememberUpdatedState(onOpenExternally)
    val currentNotify by rememberUpdatedState(onNotify)

    val listener = remember(context, origin) {
        object : HardenedWebView.Listener {
            override fun onOpenExternally(url: String) = currentOpenExternally(url)

            override fun onBlockedNavigation(url: String) =
                currentNotify("Blocked navigation to $url")

            override fun onBlockedSsl(url: String) =
                currentNotify("Blocked: certificate error at $url")

            override fun onPageTitle(title: String?) = Unit

            override fun onWebStateChanged(canGoBack: Boolean, loading: Boolean) =
                state.onWebStateChanged(canGoBack, loading)
        }
    }

    AndroidView(
        factory = { ctx ->
            val webView = HardenedWebView.create(
                context = ctx,
                canonicalOrigin = origin,
                debugAllowWebContentsDebugging = BuildConfig.DEBUG,
                listener = listener,
            )
            val refresh = SwipeRefreshLayout(ctx).apply {
                // The acceptance gate: never start a pull while the page is
                // scrolled away from the top, including inside a nested page.
                bindToWebView(webView) { state.reload() }
            }
            state.webView = webView
            state.swipeRefresh = refresh
            webView.loadUrl(WebShellSignal.initialUrl(origin))
            refresh
        },
        onRelease = { refresh ->
            val webView = state.webView
            state.clear()
            refresh.removeAllViews()
            // Destroy explicitly: a leaked WebView keeps its timers and its
            // cookie-scoped session view alive past the screen.
            webView?.destroy()
        },
        modifier = Modifier.fillMaxSize(),
    )

    // Theme + preference changes must reach the View container without
    // rebuilding the WebView (which would drop the session page state).
    SideEffect {
        state.swipeRefresh?.apply {
            isEnabled = pullToRefreshEnabled
            setColorSchemeColors(colorScheme.primary.toArgb(), colorScheme.secondary.toArgb())
            setProgressBackgroundColorSchemeColor(colorScheme.surfaceContainerHigh.toArgb())
        }
    }

    // LAMA-296 stage 1: an upload receipt's open-in-web path (Data Browser).
    LaunchedEffect(navUrl) {
        if (navUrl != null) {
            state.webView?.loadUrl(navUrl)
            onNavUrlConsumed()
        }
    }
}
