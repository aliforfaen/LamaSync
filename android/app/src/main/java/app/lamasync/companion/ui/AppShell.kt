package app.lamasync.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.Image
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.lamasync.companion.R
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import app.lamasync.companion.BuildConfig
import kotlinx.coroutines.launch

/**
 * LAMA-329 — the app shell.
 *
 * Two surfaces, one window:
 *
 *  - the **enrollment flow** (welcome / scanner / confirm / progress), which owns
 *    the whole window and is still driven by [SessionViewModel.ui]'s `screen`.
 *    Its state machine carries invariants that took real work to get right
 *    (resume-from-EXCHANGED, unconfirmed disconnect cleanup), so it is
 *    deliberately left alone rather than re-expressed as navigation;
 *  - the **managed shell**, which owns the post-enrollment destinations through
 *    a Navigation Compose back stack. `screen == MANAGE` means "the managed
 *    shell is active"; the current destination lives in the back stack and
 *    nowhere else.
 *
 * Edge-to-edge: backgrounds paint behind the system bars, while every tappable
 * thing and every row of content is padded inside `safeDrawing` (system bars,
 * display cutout and IME). The app bar itself consumes the status-bar inset
 * through `TopAppBarDefaults`.
 */
@Composable
fun LamaSyncApp(
    sessionViewModel: SessionViewModel,
    uploadsViewModel: UploadsViewModel,
    autoProtectViewModel: AutoProtectViewModel,
    shellViewModel: ShellPreferencesViewModel,
    openDocumentPicker: () -> Unit,
) {
    val uiState by sessionViewModel.ui.collectAsStateWithLifecycle()
    val uploadsState by uploadsViewModel.ui.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    LaunchedEffect(uiState.message, uploadsState.message) {
        uiState.message?.let {
            snackbarHostState.showSnackbar(it.text)
            sessionViewModel.dismissMessage()
        }
        uploadsState.message?.let {
            snackbarHostState.showSnackbar(it)
            uploadsViewModel.dismissMessage()
        }
    }

    val notify: (String) -> Unit = { text ->
        // Fire-and-forget, but scoped to the composition: the snackbar host is
        // hoisted above both surfaces, so a message that arrives at the same
        // moment the managed shell replaces the enrollment flow still lands.
        scope.launch { snackbarHostState.showSnackbar(text) }
    }

    Box(Modifier.fillMaxSize()) {
        when (uiState.screen) {
            Screen.MANAGE -> ManagedShell(
                sessionViewModel = sessionViewModel,
                uploadsViewModel = uploadsViewModel,
                autoProtectViewModel = autoProtectViewModel,
                shellViewModel = shellViewModel,
                uiState = uiState,
                context = context,
                notify = notify,
                openDocumentPicker = openDocumentPicker,
            )

            Screen.WELCOME -> EnrollmentScaffold {
                WelcomeScreen(
                    state = uiState,
                    onScan = sessionViewModel::onLaunchFromWelcome,
                    onReset = sessionViewModel::disconnect,
                    onResumePending = sessionViewModel::resumePendingEnrollment,
                    onRetryCleanup = sessionViewModel::retryCleanup,
                )
            }

            Screen.SCANNER -> EnrollmentScaffold {
                ScannerScreen(
                    onQrScanned = sessionViewModel::onQrScanned,
                    onBack = sessionViewModel::onScannerBack,
                )
            }

            Screen.CONFIRM -> EnrollmentScaffold {
                ConfirmScreen(
                    state = uiState,
                    onConfirm = sessionViewModel::confirmEnrollment,
                    onBack = sessionViewModel::onConfirmBack,
                    onRetry = sessionViewModel::retryEnrollment,
                )
            }

            Screen.PROGRESS -> EnrollmentScaffold {
                // Back must not abandon a half-finished enrollment exchange.
                BackHandler { /* enrollment in progress */ }
                ProgressScreen(uiState.progressLabel ?: "Enrolling…")
            }
        }

        // Hoisted above both surfaces: a message that arrives at the same moment
        // the managed shell replaces the enrollment flow (for example
        // "Enrolled with …") must not be dropped with the outgoing Scaffold.
        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .windowInsetsPadding(
                    WindowInsets.safeDrawing.only(
                        WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal,
                    ),
                ),
        )
    }
}

@Composable
private fun EnrollmentScaffold(content: @Composable () -> Unit) {
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        // No app bar here: `safeDrawing` keeps the whole flow out of the system
        // bars, the cutout and the keyboard.
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) { content() }
    }
}

/**
 * Where the managed shell starts.
 *
 * R5: an unpaired device can still receive a share intent, and the only
 * renderable surface for it is Uploads. Starting there (rather than on Manage,
 * which renders nothing without a registration) is what keeps back navigation
 * from pointing at an empty screen.
 *
 * Extracted as a pure function because getting it wrong is a blank-app bug and
 * it is otherwise buried in a composable.
 */
internal fun shellStartDestination(paired: Boolean): String =
    if (paired) Destination.MANAGE.route else Destination.UPLOADS.route

@Composable
private fun ManagedShell(
    sessionViewModel: SessionViewModel,
    uploadsViewModel: UploadsViewModel,
    autoProtectViewModel: AutoProtectViewModel,
    shellViewModel: ShellPreferencesViewModel,
    uiState: UiState,
    context: android.content.Context,
    notify: (String) -> Unit,
    openDocumentPicker: () -> Unit,
) {
    val uploadsState by uploadsViewModel.ui.collectAsStateWithLifecycle()
    val autoProtectState by autoProtectViewModel.ui.collectAsStateWithLifecycle()
    val preferences by shellViewModel.preferences.collectAsStateWithLifecycle()

    val registration = uiState.registration
    val navController = rememberNavController()
    val webState = rememberManageWebState()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route ?: Destination.MANAGE.route

    // A shell with no registration starts on Uploads. That is the only
    // renderable surface for unpaired share intake (R5): starting on Manage
    // would leave back navigation pointing at a screen with nothing on it.
    val startDestination = shellStartDestination(paired = registration != null)

    // One-shot programmatic entry (share intake, upload receipts). Consumed
    // immediately so a later user-initiated back is never fought by a stale
    // request.
    LaunchedEffect(uiState.requestedDestination, startDestination) {
        val requested = uiState.requestedDestination ?: return@LaunchedEffect
        sessionViewModel.consumeDestination()
        if (registration != null && requested.route != startDestination) {
            navController.navigate(requested.route) { launchSingleTop = true }
        }
    }

    val destination = Destination.entries.firstOrNull { it.route == currentRoute }
        ?: Destination.MANAGE
    val connection = connectionStateOf(
        webSessionConnected = uiState.webSessionConnected,
        checkInOk = uiState.checkInOk,
        lastCheckInLabel = uiState.lastCheckInLabel,
    )

    Scaffold(
        topBar = {
            Column {
                ManagedTopBar(
                    destination = destination,
                    serverIdentity = serverIdentity(registration?.origin),
                    connection = connection,
                    onBack = { navController.popBackStack() },
                    onRefresh = { webState.reload() },
                    onReconnect = sessionViewModel::reconnectWebSession,
                    onOpenInBrowser = {
                        val origin = registration?.origin
                        if (origin == null) {
                            notify("This device is not paired")
                        } else if (!openInBrowser(context, origin)) {
                            notifyCouldNotOpen(context, origin)
                        }
                    },
                    onNavigate = { target ->
                        navController.navigate(target.route) { launchSingleTop = true }
                    },
                )
                // LAMA-334: the reload affordance says what it is doing. The
                // thin bar sits under the app bar and covers both the top-bar
                // action and a pull gesture, so neither can look inert.
                if (webState.loading) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                }
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
        // The app bar consumes the top inset itself; this hands the remaining
        // safe-drawing insets (bottom bar, cutout, IME) to the content.
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = startDestination,
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            composable(Destination.MANAGE.route) {
                if (registration != null) {
                    ManageWebSurface(
                        state = webState,
                        origin = registration.origin,
                        pullToRefreshEnabled = preferences.pullToRefresh,
                        navUrl = uiState.webNavUrl,
                        onNavUrlConsumed = sessionViewModel::consumeNavUrl,
                        onOpenExternally = { url ->
                            when {
                                // The preference chooses between handing the
                                // link out and refusing it — never between
                                // handing it out and loading it in-process.
                                !preferences.openExternalLinks ->
                                    notify("Blocked external link: $url")
                                !openInBrowser(context, url) ->
                                    notifyCouldNotOpen(context, url)
                                else -> Unit
                            }
                        },
                        onNotify = notify,
                    )
                }
            }

            composable(Destination.UPLOADS.route) {
                UploadsScreen(
                    viewModel = uploadsViewModel,
                    pairedRegistration = registration,
                    onBack = {
                        // Unpaired shells start here, so there is nothing behind
                        // this destination: return to onboarding rather than an
                        // empty Manage screen (R5).
                        if (registration != null) {
                            navController.popBackStack()
                        } else {
                            sessionViewModel.showWelcome()
                        }
                    },
                    onPairNow = sessionViewModel::onLaunchFromWelcome,
                    onOpenUrl = { url ->
                        sessionViewModel.navigateWebTo(url)
                        navController.popBackStack(Destination.MANAGE.route, inclusive = false)
                    },
                    onOpenDocumentPicker = openDocumentPicker,
                    onOpenCameraProtection = {
                        navController.navigate(Destination.CAMERA_PROTECTION.route) {
                            launchSingleTop = true
                        }
                    },
                )
            }

            composable(Destination.CAMERA_PROTECTION.route) {
                AutoProtectScreen(viewModel = autoProtectViewModel)
            }

            composable(Destination.CONNECTION.route) {
                if (registration != null) {
                    ConnectionScreen(
                        registration = registration,
                        connected = uiState.webSessionConnected,
                        busy = uiState.busy,
                        onReconnect = sessionViewModel::reconnectWebSession,
                        onDisconnect = sessionViewModel::disconnect,
                    )
                }
            }

            composable(Destination.SETTINGS.route) {
                val currentRegistration = registration
                if (currentRegistration != null) {
                    SettingsScreen(
                        registration = currentRegistration,
                        appVersion = BuildConfig.VERSION_NAME,
                        preferences = preferences,
                        connected = uiState.webSessionConnected,
                        busy = uiState.busy,
                        uploadPolicy = uploadsState.policy,
                        autoProtect = autoProtectState,
                        onTheme = shellViewModel::setTheme,
                        onDynamicColor = shellViewModel::setDynamicColor,
                        onUnmeteredOnly = uploadsViewModel::setUnmeteredOnly,
                        onChargingOnly = uploadsViewModel::setChargingOnly,
                        onPullToRefresh = shellViewModel::setPullToRefresh,
                        onOpenExternalLinks = shellViewModel::setOpenExternalLinks,
                        onOpenCameraProtection = {
                            navController.navigate(Destination.CAMERA_PROTECTION.route) {
                                launchSingleTop = true
                            }
                        },
                        onOpenConnection = {
                            navController.navigate(Destination.CONNECTION.route) {
                                launchSingleTop = true
                            }
                        },
                        onOpenAbout = {
                            navController.navigate(Destination.ABOUT.route) {
                                launchSingleTop = true
                            }
                        },
                        onReconnect = sessionViewModel::reconnectWebSession,
                        onDisconnect = sessionViewModel::disconnect,
                    )
                }
            }

            composable(Destination.ABOUT.route) {
                if (registration != null) {
                    AboutScreen(
                        registration = registration,
                        appVersion = BuildConfig.VERSION_NAME,
                        lastCheckInLabel = uiState.lastCheckInLabel,
                        checkInOk = uiState.checkInOk,
                    )
                }
            }
        }
    }

    // LAMA-334 item 2: a refresh that ended badly says so once, and the retry
    // path is the reload action that is already on screen.
    LaunchedEffect(webState.refreshOutcome) {
        when (val outcome = webState.consumeRefreshOutcome()) {
            null, RefreshOutcome.Loaded -> Unit
            is RefreshOutcome.Failed -> notify(
                outcome.detail
                    ?.takeIf { it.isNotBlank() }
                    ?.let { "Could not load the page: $it" }
                    ?: "Could not load the page. Pull down or tap reload to retry.",
            )
            RefreshOutcome.TimedOut ->
                notify("The page is taking longer than expected. Tap reload to try again.")
            RefreshOutcome.Cancelled -> Unit
        }
    }

    // Declared AFTER the NavHost on purpose. Back callbacks resolve
    // most-recently-registered first, so this one is consulted before the
    // NavHost's own predictive-back handler: inside a WebView with history,
    // Android back walks that history first, and only then unwinds the
    // managed back stack (or exits). NavHost's handler is disabled on the
    // start destination, so the two can never both claim a gesture.
    BackHandler(enabled = destination == Destination.MANAGE && webState.canGoBack) {
        webState.goBack()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ManagedTopBar(
    destination: Destination,
    serverIdentity: String,
    connection: ConnectionState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onReconnect: () -> Unit,
    onOpenInBrowser: () -> Unit,
    onNavigate: (Destination) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }

    TopAppBar(
        title = {
            if (destination == Destination.MANAGE) {
                // LAMA-334 item 7: the header belongs to the app, not to the
                // WebView. "LamaSync" is the title; the server and the live
                // connection state are the supporting line. The full origin is
                // deliberately not here — it is one tap away under
                // "Connection details", where verbose endpoint detail belongs.
                Column {
                    Text(
                        text = "LamaSync",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        // One announcement for the pair, so TalkBack does not
                        // read a bare dot before the state it stands for.
                        modifier = Modifier.semantics(mergeDescendants = true) {},
                    ) {
                        Box(
                            Modifier
                                .size(8.dp)
                                .background(connection.level.indicatorColor(), CircleShape),
                        )
                        Text(
                            text = "$serverIdentity · ${connection.label}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            } else {
                Text(
                    text = destination.title,
                    style = MaterialTheme.typography.titleLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        },
        navigationIcon = {
            if (destination != Destination.MANAGE) {
                IconButton(onClick = onBack) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back",
                    )
                }
            } else {
                BrandMark()
            }
        },
        actions = {
            if (destination == Destination.MANAGE) {
                if (connection.needsReconnect) {
                    TextButton(onClick = onReconnect) {
                        Text("Reconnect", color = MaterialTheme.colorScheme.error)
                    }
                }
                IconButton(onClick = onRefresh) {
                    Icon(
                        imageVector = Icons.Default.Refresh,
                        contentDescription = "Reload the management UI",
                    )
                }
                Box {
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(
                            imageVector = Icons.Default.MoreVert,
                            contentDescription = "More actions",
                        )
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        for (target in listOf(
                            Destination.UPLOADS,
                            Destination.CAMERA_PROTECTION,
                            Destination.SETTINGS,
                        )) {
                            DropdownMenuItem(
                                text = { Text(target.title) },
                                onClick = {
                                    menuOpen = false
                                    onNavigate(target)
                                },
                            )
                        }
                        HorizontalDivider()
                        // The diagnostic home for the origin, the device id and
                        // the check-in state the header deliberately omits.
                        DropdownMenuItem(
                            text = { Text("Connection details") },
                            onClick = {
                                menuOpen = false
                                onNavigate(Destination.CONNECTION)
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Open in browser") },
                            onClick = {
                                menuOpen = false
                                onOpenInBrowser()
                            },
                        )
                    }
                }
            }
        },
    )
}

/**
 * The LamaSync mark in the app bar.
 *
 * Decorative on purpose (`contentDescription = null`): the adjacent title
 * already reads "LamaSync", so announcing the mark would say it twice. It is
 * the launcher art the device already shows, so the header and the home screen
 * agree about what this app is.
 */
@Composable
private fun BrandMark() {
    Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
        Image(
            painter = painterResource(R.drawable.lama_courier_launcher),
            contentDescription = null,
            modifier = Modifier.size(26.dp),
        )
    }
}
