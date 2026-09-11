package app.lamasync.companion.ui

import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.core.net.toUri

/**
 * Hands [url] to another application via `ACTION_VIEW`.
 *
 * Used for the two legitimate "leave the app" paths, both of which are
 * deliberate and credential-free:
 *
 *  - the top bar's "Open in browser", which opens the enrolled origin in a
 *    real browser (a separate process that never sees this app's session
 *    cookie jar);
 *  - a cross-origin link the embedded WebView refused to load in-process.
 *
 * Returns false when no activity could handle the intent, so the caller can say
 * so instead of failing silently.
 */
internal fun openInBrowser(context: Context, url: String): Boolean = runCatching {
    context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()))
}.isSuccess

internal fun notifyCouldNotOpen(context: Context, url: String) {
    Toast.makeText(context, "Could not open $url", Toast.LENGTH_SHORT).show()
}
