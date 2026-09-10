package app.lamasync.companion.ui

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.toArgb
import androidx.core.graphics.drawable.toDrawable
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.lamasync.companion.ui.theme.LamaSyncPalette
import app.lamasync.companion.ui.theme.LamaSyncTheme
import app.lamasync.companion.ui.theme.isLamaSyncDark

class MainActivity : ComponentActivity() {

    private val viewModel: SessionViewModel by viewModels()
    private val uploadsViewModel: UploadsViewModel by viewModels()
    private val autoProtectViewModel: AutoProtectViewModel by viewModels()
    private val shellViewModel: ShellPreferencesViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        initializeViewModels()

        // LAMA-329: Android 15 (target SDK 35) enforces edge-to-edge. Opting in
        // explicitly keeps the behaviour identical on older releases, and lets
        // the framework pick the right system-bar icon appearance for the
        // resolved theme instead of forcing it per API level.
        enableEdgeToEdge()

        // Launch/resume check-in only (spec: no background service).
        lifecycle.addObserver(
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME) {
                    viewModel.initialize()
                }
            },
        )

        // Stage 2: prompt discovery when the app surfaces (cheap, unique,
        // local-only); periodic work is the safety net for missed triggers.
        lifecycle.addObserver(
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME) {
                    app.lamasync.companion.work.AutoProtectWorkScheduler.scheduleDiscovery(this)
                    autoProtectViewModel.refreshScope()
                }
            },
        )

        setContent {
            val preferences by shellViewModel.preferences.collectAsStateWithLifecycle()
            val dark = isLamaSyncDark(preferences)

            // The window background and the system-bar icon appearance must
            // match the RESOLVED theme, not the system's: a user who chose
            // "Always dark" on a light phone would otherwise get dark-on-dark
            // status-bar icons and one frame of the wrong canvas on cold start.
            SideEffect {
                enableEdgeToEdge(
                    statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark },
                    navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark },
                )
                val canvas = if (dark) LamaSyncPalette.Dark.canvas else LamaSyncPalette.Light.canvas
                window.setBackgroundDrawable(canvas.toArgb().toDrawable())
            }

            LamaSyncTheme(preferences = preferences) {
                val pickLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.StartActivityForResult(),
                ) { result ->
                    val intent = result.data ?: return@rememberLauncherForActivityResult
                    val grantFlags = intent.flags
                    val uris = if (intent.clipData != null) {
                        (0 until intent.clipData!!.itemCount)
                            .map { intent.clipData!!.getItemAt(it).uri }
                    } else {
                        listOfNotNull(intent.data)
                    }
                    uploadsViewModel.acceptShare(uris, grantFlags)
                }
                val openDocumentPicker = {
                    pickLauncher.launch(
                        Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = "*/*"
                            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                            flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
                                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                        },
                    )
                }

                LamaSyncApp(
                    sessionViewModel = viewModel,
                    uploadsViewModel = uploadsViewModel,
                    autoProtectViewModel = autoProtectViewModel,
                    shellViewModel = shellViewModel,
                    openDocumentPicker = openDocumentPicker,
                )
            }
        }

        // A share intent may have launched the activity fresh (cold start).
        handleShareIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareIntent(intent)
    }

    private fun initializeViewModels() {
        viewModel.initialize()
        uploadsViewModel.initialize()
        autoProtectViewModel.initialize()
        shellViewModel.initialize()
    }

    /**
     * LAMA-296 stage 1 — ACTION_SEND / ACTION_SEND_MULTIPLE intake. Content
     * URIs are parsed here and handed to the upload flow; they are NEVER
     * treated as filesystem paths. Unpaired intake is an explicit failure
     * (the upload flow surfaces the message; the app also switches to the
     * queue screen so the user sees it).
     */
    private fun handleShareIntent(intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
        val uris = shareUrisOf(intent)
        if (uris.isEmpty()) return
        initializeViewModels()
        uploadsViewModel.acceptShare(uris, intent.flags)
        // Surface the queue (and any intake failure) immediately — whether or
        // not the device is paired yet (unpaired intake fails explicitly in
        // the queue screen instead of silently dropping the share).
        viewModel.openUploads()
    }

    private fun shareUrisOf(intent: Intent): List<Uri> {
        val stream = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        val clip = intent.clipData
        val uris = mutableListOf<Uri>()
        if (clip != null) {
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i).uri?.let { uris += it }
            }
        } else if (stream != null) {
            uris += stream
        }
        return uris
    }
}
