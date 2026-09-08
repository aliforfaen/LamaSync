package app.lamasync.companion.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.lamasync.companion.BuildConfig
import app.lamasync.companion.ui.theme.LamaSyncTheme

class MainActivity : ComponentActivity() {

    private val viewModel: SessionViewModel by viewModels()
    private val uploadsViewModel: UploadsViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        viewModel.initialize()
        uploadsViewModel.initialize()

        // Launch/resume check-in only (spec: no background service).
        lifecycle.addObserver(
            LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME) {
                    viewModel.initialize()
                }
            },
        )

        setContent {
            LamaSyncTheme {
                val uiState by viewModel.ui.collectAsStateWithLifecycle()
                val uploadsState by uploadsViewModel.ui.collectAsStateWithLifecycle()
                val snackbarHostState = SnackbarHostState()

                LaunchedEffect(uiState.message, uploadsState.message) {
                    uiState.message?.let {
                        snackbarHostState.showSnackbar(it.text)
                        viewModel.dismissMessage()
                    }
                    uploadsState.message?.let {
                        snackbarHostState.showSnackbar(it)
                        uploadsViewModel.dismissMessage()
                    }
                }

                // LAMA-296 stage 1: document selection (ACTION_OPEN_DOCUMENT).
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

                Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
                    Box(Modifier.fillMaxSize().padding(padding)) {
                        when (uiState.screen) {
                            Screen.WELCOME -> WelcomeScreen(
                                state = uiState,
                                onScan = viewModel::onLaunchFromWelcome,
                                onReset = viewModel::disconnect,
                                onResumePending = viewModel::resumePendingEnrollment,
                                onRetryCleanup = viewModel::retryCleanup,
                            )
                            Screen.SCANNER -> ScannerScreen(
                                onQrScanned = viewModel::onQrScanned,
                                onBack = viewModel::onScannerBack,
                            )
                            Screen.CONFIRM -> ConfirmScreen(
                                state = uiState,
                                onConfirm = viewModel::confirmEnrollment,
                                onBack = viewModel::onConfirmBack,
                                onRetry = viewModel::retryEnrollment,
                            )
                            Screen.PROGRESS -> {
                                BackHandler { /* enrollment in progress */ }
                                ProgressScreen(uiState.progressLabel ?: "Enrolling…")
                            }
                            Screen.MANAGE -> {
                                val registration = uiState.registration
                                if (registration != null) {
                                    ManagementScreen(
                                        registration = registration,
                                        webSessionConnected = uiState.webSessionConnected,
                                        navUrl = uiState.webNavUrl,
                                        onNavUrlConsumed = viewModel::consumeNavUrl,
                                        onOpenConnection = viewModel::openConnectionPanel,
                                        onReconnect = viewModel::reconnectWebSession,
                                        onOpenUploads = viewModel::openUploads,
                                    )
                                }
                            }
                            Screen.CONNECTION -> {
                                val registration = uiState.registration
                                if (registration != null) {
                                    ConnectionScreen(
                                        registration = registration,
                                        appVersion = BuildConfig.VERSION_NAME,
                                        lastCheckInLabel = uiState.lastCheckInLabel,
                                        checkInOk = uiState.checkInOk,
                                        busy = uiState.busy,
                                        onBack = viewModel::closeConnectionPanel,
                                        onReconnect = viewModel::reconnectWebSession,
                                        onDisconnect = viewModel::disconnect,
                                    )
                                }
                            }
                            Screen.UPLOADS -> {
                                val registration = uiState.registration
                                // R5: mount the uploads surface even when
                                // unpaired (a share intent landed while the
                                // device is not paired / credential-lost) —
                                // it renders an onboarding/error block instead
                                // of an empty screen.
                                UploadsScreen(
                                    viewModel = uploadsViewModel,
                                    pairedRegistration = registration,
                                    onBack = {
                                        if (registration != null) {
                                            viewModel.closeUploads()
                                        } else {
                                            viewModel.showWelcome()
                                        }
                                    },
                                    onPairNow = viewModel::onLaunchFromWelcome,
                                    onOpenUrl = { url ->
                                        viewModel.navigateWebTo(url)
                                        viewModel.closeUploads()
                                    },
                                    onOpenDocumentPicker = openDocumentPicker,
                                )
                            }
                        }
                    }
                }
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
        viewModel.initialize()
        uploadsViewModel.initialize()
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