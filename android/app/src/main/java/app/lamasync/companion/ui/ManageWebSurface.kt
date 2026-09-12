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
import app.lamasync.companion.BuildConfig
import app.lamasync.companion.web.HardenedWebView
import app.lamasync.companion.web.WebShellSignal
import kotlinx.coroutines.delay

/**
 * How long a requested reload may stay on screen before the indicator is
 * retired. The SPA is one inlined document, so a reload that has not completed
 * in this long is either a stalled connection or a load that will never report
 * back — the top-bar reload action stays available as the retry path.
 */
internal const val REFRESH_TIMEOUT_MS = 20_000L

/**
 * How a refresh ended. Surfaced to the shell so a stalled or failed reload is
 * announced instead of silently leaving a spinner (LAMA-334 item 2).
 */
sealed interface RefreshOutcome {
    data object Loaded : RefreshOutcome
    data class Failed(val detail: String?) : RefreshOutcome
    data object TimedOut : RefreshOutcome
    data object Cancelled : RefreshOutcome
}

/**
 * LAMA-329 — the WebView's shared handle.
 *
 * The shell's top app bar (refresh) and its Android-back handling both need to
 * reach into the WebView, which lives in a different composable subtree. This
 * object is the single, explicitly-scoped channel between them: it holds no
 * credentials and exposes only history/reload operations, so the security
 * boundary of [HardenedWebView] is unchanged.
 *
 * LAMA-334 item 2: the refresh indicator is a STATE, not a View property. It is
 * raised by [reload] and lowered by exactly one terminal event — the load
 * finishing (`onPageFinished`), a main-frame load failure, the
 * [REFRESH_TIMEOUT_MS] watchdog, or [cancelRefresh]. The View container mirrors
 * this state ([SwipeRefreshLayout.isRefreshing]), so the spinner cannot outlive
 * the gesture that started it.
 *
 * LAMA-334 review finding 2: a history/back-stack update
 * (`doUpdateVisitedHistory`) is NOT one of those terminal events. It can arrive
 * before `onPageFinished`, so it only updates [canGoBack]; treating it as a
 * completed load hid the spinner while the page was still loading.
 */
@Stable
class ManageWebState {

    internal var webView: WebView? = null
    internal var swipeRefresh: PullToRefreshLayout? = null

    /** Whether the WebView has history to walk before back leaves the shell. */
    var canGoBack by mutableStateOf(false)
        private set

    /** A page load is in flight. */
    var loading by mutableStateOf(false)
        private set

    /** The refresh indicator is showing (top-bar refresh or a pull gesture). */
    var refreshing by mutableStateOf(false)
        private set

    /** Increments per requested refresh; the watchdog keys off it. */
    var refreshGeneration by mutableStateOf(0)
        private set

    /** How the last refresh ended, until the shell consumes it. */
    var refreshOutcome by mutableStateOf<RefreshOutcome?>(null)
        private set

    /**
     * Back-stack only (`doUpdateVisitedHistory`). It can arrive before
     * `onPageFinished`, so it updates [canGoBack] and nothing else — in
     * particular it must not settle a refresh that is still loading.
     */
    internal fun onWebHistoryChanged(canGoBack: Boolean) {
        this.canGoBack = canGoBack
    }

    /**
     * A main-frame load started (`loading = true`) or finished
     * (`loading = false`). Only the `false` edge is a refresh terminal event.
     */
    internal fun onWebLoadStateChanged(canGoBack: Boolean, loading: Boolean) {
        this.canGoBack = canGoBack
        this.loading = loading
        if (!loading) endRefresh(RefreshOutcome.Loaded)
    }

    /**
     * A main-frame load failure (offline, DNS, TLS refusal past the keystore
     * check). The WebView shows its own error page; the shell stops claiming a
     * refresh is in progress and says so.
     */
    internal fun onLoadFailed(detail: String?) {
        loading = false
        endRefresh(RefreshOutcome.Failed(detail))
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
        refreshOutcome = null
        refreshGeneration += 1
        // A null view is a one-frame window before the AndroidView factory
        // runs; the load that follows (`onPageStarted` → `onPageFinished`) or
        // the watchdog retires the indicator either way.
        webView?.reload()
    }

    /** The watchdog fired: stop waiting, keep the page. */
    internal fun refreshTimedOut() {
        if (refreshing) endRefresh(RefreshOutcome.TimedOut)
    }

    /** The surface is going away while a refresh was pending. */
    internal fun cancelRefresh() {
        if (refreshing) endRefresh(RefreshOutcome.Cancelled)
    }

    /** One-shot read of the last outcome. */
    fun consumeRefreshOutcome(): RefreshOutcome? {
        val outcome = refreshOutcome
        refreshOutcome = null
        return outcome
    }

    private fun endRefresh(outcome: RefreshOutcome) {
        if (!refreshing) return
        refreshing = false
        refreshOutcome = outcome
    }

    internal fun clear() {
        webView = null
        swipeRefresh = null
        canGoBack = false
        loading = false
        refreshing = false
        // Deliberately keep refreshOutcome: a refresh that ends exactly as the
        // surface is released still deserves its message.
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
 * stays 0 and the gesture is therefore allowed by THIS half of the gate. It is
 * never negative. The overlay half of the gate lives in [PullToRefreshLayout].
 */
internal fun webViewAtScrollTop(webView: WebView): Boolean = webView.scrollY <= 0

/**
 * The management surface: the hardened WebView on the enrolled origin, inside a
 * pull-to-refresh container.
 *
 * Pull-to-refresh deliberately uses the View-based [PullToRefreshLayout] rather
 * than Compose's `Modifier.pullToRefresh`: the latter is driven by nested
 * scroll, and an `AndroidView` host does not dispatch nested scroll, so the
 * gesture would never fire.
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

            override fun onWebHistoryChanged(canGoBack: Boolean) =
                state.onWebHistoryChanged(canGoBack)

            override fun onWebLoadStateChanged(canGoBack: Boolean, loading: Boolean) =
                state.onWebLoadStateChanged(canGoBack, loading)

            override fun onLoadFailed(url: String, description: String?) =
                state.onLoadFailed(description)
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
            val refresh = PullToRefreshLayout(ctx).apply {
                bindToWebView(webView) { state.reload() }
            }
            state.webView = webView
            state.swipeRefresh = refresh
            webView.loadUrl(WebShellSignal.initialUrl(origin))
            refresh
        },
        onRelease = { refresh ->
            val webView = state.webView
            // Retire the indicator before the View that owns it goes away, so a
            // refresh interrupted by navigation is not reported as a load.
            state.cancelRefresh()
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
            // LAMA-334 item 2 — the terminal-state fix. SwipeRefreshLayout raises
            // its own spinner when a pull completes and NEVER lowers it on its
            // own; the shell's state is the single source of truth for both the
            // gesture and the top-bar action, so mirror it here. Without this
            // the indicator outlived every load it was waiting for.
            isRefreshing = state.refreshing
        }
    }

    // Watchdog: a requested refresh always reaches a terminal state, even when
    // the WebView reports neither a finish nor an error (a stalled connection,
    // a page that never commits).
    LaunchedEffect(state.refreshGeneration) {
        if (state.refreshGeneration == 0) return@LaunchedEffect
        delay(REFRESH_TIMEOUT_MS)
        state.refreshTimedOut()
    }

    // LAMA-296 stage 1: an upload receipt's open-in-web path (Data Browser).
    LaunchedEffect(navUrl) {
        if (navUrl != null) {
            state.webView?.loadUrl(navUrl)
            onNavUrlConsumed()
        }
    }
}
