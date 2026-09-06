package app.lamasync.companion.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        viewModel.initialize()

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
                val snackbarHostState = SnackbarHostState()

                LaunchedEffect(uiState.message) {
                    uiState.message?.let {
                        snackbarHostState.showSnackbar(it.text)
                        viewModel.dismissMessage()
                    }
                }

                Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
                    Box(Modifier.fillMaxSize().padding(padding)) {
                        when (uiState.screen) {
                            Screen.WELCOME -> WelcomeScreen(
                                state = uiState,
                                onScan = viewModel::onLaunchFromWelcome,
                                onReset = viewModel::disconnect,
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
                                        onOpenConnection = viewModel::openConnectionPanel,
                                        onReconnect = viewModel::reconnectWebSession,
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
                        }
                    }
                }
            }
        }
    }
}
