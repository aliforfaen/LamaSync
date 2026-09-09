package app.lamasync.companion.ui

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.lamasync.companion.BuildConfig
import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.core.EnrollmentQrPayload
import app.lamasync.companion.core.OriginCheck
import app.lamasync.companion.core.OriginPolicy
import app.lamasync.companion.core.QrPayloadParser
import app.lamasync.companion.core.QrPayloadResult
import app.lamasync.companion.core.QrRejection
import app.lamasync.companion.data.CompanionRepository
import app.lamasync.companion.data.EnrollmentBinding
import app.lamasync.companion.data.EnrollmentStage
import app.lamasync.companion.data.KeystoreCredentialVault
import app.lamasync.companion.data.Registration
import app.lamasync.companion.data.RegistrationStoreImpl
import app.lamasync.companion.network.HttpUrlConnectionTransport
import app.lamasync.companion.network.MobileApiClient
import app.lamasync.companion.network.WebSessionBroker
import app.lamasync.companion.web.SessionCookieJar
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Top-level destinations. The QR payload travels only through the ViewModel. */
enum class Screen { WELCOME, SCANNER, CONFIRM, PROGRESS, MANAGE, CONNECTION, UPLOADS, AUTO_PROTECT }

/** One-shot user-facing message (shown as a snackbar). */
data class UiMessage(val text: String, val isError: Boolean = false)

/**
 * A persisted enrollment whose exchange already succeeded but whose identity
 * probe/registration never completed (stage EXCHANGED with usable secrets).
 * The app can finish it WITHOUT the QR — resuming only ever talks to
 * [origin], and [displayName] is the name the user already chose (R1).
 */
data class PendingEnrollment(
    val origin: String,
    val displayName: String,
)

data class UiState(
    val screen: Screen = Screen.WELCOME,
    val registration: Registration? = null,
    /** Enrolled origin whose key material could not be decrypted (re-pair needed). */
    val credentialLost: Boolean = false,
    /**
     * Interrupted enrollment recoverable without a QR (see [PendingEnrollment]).
     * The WELCOME screen shows an explicit resume action while this is set.
     */
    val pendingEnrollment: PendingEnrollment? = null,
    /** Validated QR candidate awaiting confirmation; never in nav args. */
    val candidate: EnrollmentQrPayload? = null,
    /**
     * True when the current candidate matches a persisted enrollment whose
     * exchange already succeeded. Confirming again must RESUME that
     * enrollment (identity/bootstrap) instead of re-exchanging the consumed
     * one-time QR — the CONFIRM screen shows a Retry action in this state.
     */
    val pendingResume: Boolean = false,
    val suggestedDeviceName: String = "",
    val busy: Boolean = false,
    val progressLabel: String? = null,
    val message: UiMessage? = null,
    val lastCheckInLabel: String? = null,
    val checkInOk: Boolean? = null,
    val webSessionConnected: Boolean = false,
    /** Target URL for the embedded web UI (stage 1: upload receipt browse). */
    val webNavUrl: String? = null,
    /**
     * True while a disconnect's local cleanup is still unconfirmed (R2). The
     * WELCOME screen shows the failure and a retry action; the origin(s)
     * below (plus the remote outcome) let the retry finish without secrets.
     */
    val cleanupUnconfirmed: Boolean = false,
    val cleanupOrigins: List<String> = emptyList(),
    /** Remote outcome of the disconnect whose cleanup is unconfirmed (null = relaunch, unknown). */
    val cleanupRemoteSucceeded: Boolean? = null,
)

class SessionViewModel(application: Application) : AndroidViewModel(application) {

    private val appVersion: String = BuildConfig.VERSION_NAME

    private val vault = KeystoreCredentialVault(application)
    private val registrationStore = RegistrationStoreImpl(application)
    private val transport = HttpUrlConnectionTransport()
    private val api = MobileApiClient(transport)
    private val broker = WebSessionBroker(transport)
    private var repository: CompanionRepository = CompanionRepository(
        api = api,
        broker = broker,
        vault = vault,
        registrationStore = registrationStore,
        cookieScope = SessionCookieJar(),
    )

    /**
     * Instrumented-test seam: swaps in a repository built over fakes so the
     * real ViewModel state machine can be exercised on-device without
     * touching the network or real stores.
     */
    internal constructor(
        application: Application,
        testRepository: CompanionRepository,
    ) : this(application) {
        repository = testRepository
    }

    private val _ui = MutableStateFlow(UiState(suggestedDeviceName = defaultDeviceName()))
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private var initialized = false

    /** Loads persisted state; called once from the activity. */
    fun initialize() {
        if (initialized) return
        initialized = true
        val snapshot = repository.loadSession()
        val registration = snapshot.registration
        // R1: an enrollment whose exchange already succeeded (EXCHANGED
        // binding) but whose identity/registration never completed must be
        // recoverable after a restart WITHOUT re-scanning the consumed QR.
        // Completed enrollments (registration present) are untouched — a web
        // logout that merely cleared the cookie never auto-re-bootstraps.
        val pending = pendingEnrollmentOf(snapshot)
        _ui.update { state ->
            val screen = when {
                registration != null && snapshot.hasUsableNativeCredential -> Screen.MANAGE
                else -> Screen.WELCOME
            }
            state.copy(
                screen = screen,
                registration = registration,
                pendingEnrollment = pending,
                credentialLost = registration != null && !snapshot.hasUsableNativeCredential,
                webSessionConnected = snapshot.hasSessionCookie,
                cleanupUnconfirmed = snapshot.cleanupPendingOrigins.isNotEmpty(),
                cleanupOrigins = snapshot.cleanupPendingOrigins,
                cleanupRemoteSucceeded = null, // remote outcome of an earlier launch is not retained
            )
        }
        if (registration != null && snapshot.hasUsableNativeCredential) {
            runCheckIn()
        }
    }

    /**
     * The pending-enrollment recovery candidate from [snapshot], if any: a
     * registration-less EXCHANGED binding whose secrets are both usable. The
     * display name is the one the user already chose when the QR was
     * confirmed — resume preserves it (R1).
     */
    private fun pendingEnrollmentOf(
        snapshot: CompanionRepository.SessionSnapshot,
    ): PendingEnrollment? {
        val binding = snapshot.pendingBinding ?: return null
        if (snapshot.registration != null) return null
        if (binding.stage != EnrollmentStage.EXCHANGED) return null
        if (!snapshot.hasUsableNativeCredential || !snapshot.hasWebGrant) return null
        return PendingEnrollment(origin = binding.origin, displayName = binding.displayName)
    }

    /**
     * User tapped "Resume enrollment" on the pending-recovery surface. Finishes
     * the interrupted enrollment at its BOUND origin with NO QR secret and NO
     * new exchange; the repository refuses any other origin (R1).
     */
    fun resumePendingEnrollment() {
        val pending = _ui.value.pendingEnrollment ?: return
        _ui.update {
            it.copy(busy = true, progressLabel = "Finishing enrollment…", message = null)
        }
        viewModelScope.launch {
            when (val outcome = repository.completeEnrollment(pending.origin, appVersion)) {
                is CompanionRepository.EnrollOutcome.Success -> onEnrollSuccess(outcome.registration)
                is CompanionRepository.EnrollOutcome.Failure -> onPendingResumeFailure(outcome, pending)
            }
        }
    }

    private fun onPendingResumeFailure(
        outcome: CompanionRepository.EnrollOutcome.Failure,
        pending: PendingEnrollment,
    ) {
        val detail = enrollFailureDetail(outcome)
        _ui.update {
            it.copy(
                busy = false,
                progressLabel = null,
                screen = Screen.WELCOME,
                // The recovery surface stays: credentials + EXCHANGED binding
                // are still persisted, so the user can retry the resume.
                pendingEnrollment = it.pendingEnrollment ?: pending,
                message = UiMessage("The interrupted enrollment could not be finished. $detail", isError = true),
            )
        }
    }

    fun onLaunchFromWelcome() {
        _ui.update { it.copy(screen = Screen.SCANNER, message = null) }
    }

    fun onScannerBack() {
        // Re-derive the recovery surface from the CURRENT persisted state:
        // starting a different-QR flow may have cleared the in-flight binding
        // (a stale EXCHANGED candidate must not reappear on WELCOME).
        val snapshot = repository.loadSession()
        _ui.update {
            it.copy(
                screen = Screen.WELCOME,
                message = null,
                candidate = null,
                pendingResume = false,
                pendingEnrollment = pendingEnrollmentOf(snapshot),
                cleanupUnconfirmed = snapshot.cleanupPendingOrigins.isNotEmpty(),
                cleanupOrigins = snapshot.cleanupPendingOrigins,
                cleanupRemoteSucceeded = if (snapshot.cleanupPendingOrigins.isEmpty()) null else it.cleanupRemoteSucceeded,
            )
        }
    }

    /** Receives raw scanner output and validates it. */
    fun onQrScanned(raw: String) {
        when (val result = QrPayloadParser.parse(raw)) {
            is QrPayloadResult.Valid -> _ui.update {
                it.copy(
                    screen = Screen.CONFIRM,
                    candidate = result.payload,
                    message = null,
                    pendingResume = matchingBinding(result.payload) != null,
                )
            }
            is QrPayloadResult.Invalid -> _ui.update {
                it.copy(message = UiMessage(qrRejectionText(result.reason), isError = true))
            }
        }
    }

    fun onConfirmBack() {
        _ui.update {
            it.copy(screen = Screen.SCANNER, candidate = null, pendingResume = false, message = null)
        }
    }

    /**
     * The persisted in-flight enrollment matching [candidate], if any. Only
     * that exact (origin, enrollmentId) may resume with stored credentials;
     * the repository independently enforces the same rule.
     */
    private fun matchingBinding(candidate: EnrollmentQrPayload): EnrollmentBinding? {
        val canonical = canonicalOrigin(candidate) ?: return null
        val binding = repository.loadSession().pendingBinding ?: return null
        return binding.takeIf { it.origin == canonical && it.enrollmentId == candidate.enrollmentId }
    }

    private fun canonicalOrigin(candidate: EnrollmentQrPayload): String? =
        (OriginPolicy.parseHttpsOrigin(candidate.serverOrigin) as? OriginCheck.Valid)?.origin

    fun confirmEnrollment(displayName: String) {
        val candidate = _ui.value.candidate ?: return
        val name = sanitizeDisplayName(displayName)
        if (name == null) {
            _ui.update { it.copy(message = UiMessage("Enter a device name (up to 64 characters).", true)) }
            return
        }
        // If this QR already exchanged and persists a binding, the repository
        // resumes that enrollment at its bound origin instead of re-exchanging
        // (the server would answer 409). The label reflects which path runs.
        val resuming = matchingBinding(candidate) != null
        _ui.update {
            it.copy(
                screen = Screen.PROGRESS,
                busy = true,
                progressLabel = if (resuming) "Finishing enrollment…" else "Exchanging enrollment…",
            )
        }
        viewModelScope.launch {
            when (val outcome = repository.enroll(candidate, name, appVersion)) {
                is CompanionRepository.EnrollOutcome.Success -> onEnrollSuccess(outcome.registration)
                is CompanionRepository.EnrollOutcome.Failure -> onEnrollFailure(outcome)
            }
        }
    }

    /**
     * Retry after a mid-flow failure (the CONFIRM screen's Retry action).
     * When the candidate matches the persisted enrollment, retry resumes it
     * from its saved stage — re-bootstrapping from the stored grant without
     * re-exchanging the consumed QR or clearing credentials (finding 5). A
     * mismatched candidate falls back to a full enrollment run.
     */
    fun retryEnrollment() {
        val state = _ui.value
        val candidate = state.candidate ?: return
        val binding = matchingBinding(candidate)
        if (binding == null) {
            // Exchange never completed for this QR (or credentials lost):
            // full re-run.
            confirmEnrollment(state.suggestedDeviceName)
            return
        }
        val canonical = canonicalOrigin(candidate)
        if (canonical == null) {
            confirmEnrollment(state.suggestedDeviceName)
            return
        }
        _ui.update { it.copy(busy = true, progressLabel = "Finishing enrollment…") }
        viewModelScope.launch {
            when (val outcome = repository.completeEnrollment(canonical, appVersion)) {
                is CompanionRepository.EnrollOutcome.Success -> onEnrollSuccess(outcome.registration)
                is CompanionRepository.EnrollOutcome.Failure -> onEnrollFailure(outcome)
            }
        }
    }

    private fun onEnrollSuccess(registration: Registration) {
        _ui.update {
            it.copy(
                screen = Screen.MANAGE,
                registration = registration,
                candidate = null,
                pendingResume = false,
                pendingEnrollment = null,
                busy = false,
                progressLabel = null,
                credentialLost = false,
                webSessionConnected = true,
                cleanupUnconfirmed = false,
                cleanupOrigins = emptyList(),
                cleanupRemoteSucceeded = null,
                message = UiMessage("Enrolled with ${registration.origin}."),
            )
        }
        runCheckIn()
    }

    private fun onEnrollFailure(outcome: CompanionRepository.EnrollOutcome.Failure) {
        val stepText = when (outcome.step) {
            CompanionRepository.EnrollStep.EXCHANGE -> "The enrollment could not be exchanged"
            CompanionRepository.EnrollStep.CLEANUP -> "The previous pairing could not be cleared"
            CompanionRepository.EnrollStep.STORE -> "Credentials could not be stored securely"
            CompanionRepository.EnrollStep.IDENTITY -> "The device identity could not be verified"
            CompanionRepository.EnrollStep.WEB_SESSION -> "The web session could not be opened"
        }
        val detail = enrollFailureDetail(outcome)
        val pending = _ui.value.candidate?.let { matchingBinding(it) } != null
        val snapshot = repository.loadSession()
        _ui.update {
            it.copy(
                busy = false,
                progressLabel = null,
                screen = Screen.CONFIRM,
                pendingResume = pending,
                cleanupUnconfirmed = snapshot.cleanupPendingOrigins.isNotEmpty(),
                cleanupOrigins = snapshot.cleanupPendingOrigins,
                cleanupRemoteSucceeded = if (snapshot.cleanupPendingOrigins.isEmpty()) null else it.cleanupRemoteSucceeded,
                message = UiMessage("$stepText. $detail", isError = true),
            )
        }
    }

    private fun enrollFailureDetail(outcome: CompanionRepository.EnrollOutcome.Failure): String {
        val cause = outcome.cause
        if (cause is CompanionRepository.LocalCleanupUnconfirmed) {
            val origins = cause.unconfirmedOrigins.joinToString()
            return "The web session for $origins could not be removed, so the new enrollment " +
                "did not start. Retry, or revoke the old device from the desktop server UI first."
        }
        return when (cause) {
            is ApiFailure.EnrollmentExpired ->
                "This enrollment expired. Ask the desktop to generate a new QR code."
            is ApiFailure.EnrollmentConsumed ->
                "This enrollment was already used. Ask the desktop to generate a new QR code."
            is ApiFailure.Throttled -> "Too many attempts — wait a minute and try again."
            is ApiFailure.Unauthorized ->
                "The server rejected this enrollment. Ask the desktop to generate a new QR code."
            is ApiFailure.Network -> "Cannot reach the server. Check the connection and retry."
            else -> "Retry or ask the desktop to generate a new QR code."
        }
    }

    fun openConnectionPanel() {
        _ui.update { it.copy(screen = Screen.CONNECTION, message = null) }
    }

    fun closeConnectionPanel() {
        _ui.update { it.copy(screen = Screen.MANAGE, message = null) }
    }

    /** Stage 1: the upload queue screen (native surface for manual uploads). */
    fun openUploads() {
        _ui.update { it.copy(screen = Screen.UPLOADS, message = null) }
    }

    fun closeUploads() {
        _ui.update { it.copy(screen = Screen.MANAGE, message = null) }
    }

    /** Stage 2: automatic camera-protection setup + status surface. */
    fun openAutoProtect() {
        _ui.update { it.copy(screen = Screen.AUTO_PROTECT, message = null) }
    }

    fun closeAutoProtect() {
        _ui.update { it.copy(screen = Screen.MANAGE, message = null) }
    }

    /** Back/home target for surfaces reachable while UNPAIRED (share-intent
     *  landing): the MANAGE screen renders nothing without a registration,
     *  so an unpaired uploads surface must return to the renderable
     *  WELCOME screen instead (R5). */
    fun showWelcome() {
        _ui.update { it.copy(screen = Screen.WELCOME, message = null) }
    }

    /** Navigate the embedded web UI (receipts' open-in-web path). */
    fun navigateWebTo(url: String) {
        _ui.update { it.copy(webNavUrl = url) }
    }

    fun consumeNavUrl() {
        _ui.update { it.copy(webNavUrl = null) }
    }

    fun reloadWebSession() = reconnectWebSession()

    /** Re-bootstraps the web session from the stored web grant. */
    fun reconnectWebSession() {
        val registration = _ui.value.registration ?: return
        _ui.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            when (repository.reconnectWebSession(registration.origin)) {
                is CompanionRepository.ReconnectOutcome.Success -> _ui.update {
                    it.copy(
                        busy = false,
                        webSessionConnected = true,
                        message = UiMessage("Web session restored."),
                    )
                }
                is CompanionRepository.ReconnectOutcome.Failure -> _ui.update {
                    it.copy(
                        busy = false,
                        webSessionConnected = false,
                        message = UiMessage(
                            "Could not restore the web session. If the grant was revoked, " +
                                "disconnect and ask the desktop to generate a new QR code.",
                            isError = true,
                        ),
                    )
                }
            }
        }
    }

    /** Launch/resume check-in (fire and report into the connection panel). */
    fun runCheckIn() {
        if (repository.loadSession().registration == null) return
        viewModelScope.launch {
            when (val result = repository.checkIn(appVersion)) {
                is CompanionRepository.CheckInOutcome.Success -> {
                    val registration = _ui.value.registration
                    _ui.update { state ->
                        state.copy(
                            registration = registration,
                            lastCheckInLabel = "Checked in",
                            checkInOk = true,
                        )
                    }
                }
                is CompanionRepository.CheckInOutcome.Skipped -> Unit
                is CompanionRepository.CheckInOutcome.Failure -> {
                    val text = when (val c = result.cause) {
                        is ApiFailure.Network -> "Check-in failed: unreachable (will retry on next launch)"
                        is ApiFailure.Unauthorized -> "Check-in failed: credential revoked"
                        else -> "Check-in failed"
                    }
                    _ui.update {
                        it.copy(
                            lastCheckInLabel = text,
                            checkInOk = false,
                        )
                    }
                }
            }
        }
    }

    fun disconnect() {
        _ui.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            val result = repository.disconnect()
            val localIncomplete = !result.localCleared
            val message = disconnectMessage(result)
            _ui.update {
                it.copy(
                    screen = Screen.WELCOME,
                    registration = null,
                    credentialLost = false,
                    pendingEnrollment = null,
                    busy = false,
                    progressLabel = null,
                    candidate = null,
                    pendingResume = false,
                    webSessionConnected = false,
                    checkInOk = null,
                    lastCheckInLabel = null,
                    cleanupUnconfirmed = localIncomplete,
                    cleanupOrigins = result.unconfirmedCookieOrigins,
                    cleanupRemoteSucceeded = if (localIncomplete) result.remoteSucceeded else null,
                    message = message,
                )
            }
        }
    }

    /**
     * Renders the remote and local disconnect outcomes INDEPENDENTLY: the
     * message never claims "Local data cleared" (or implies a successful local
     * disconnection) when [DisconnectResult.localCleared] is false, and it
     * always says which remote outcome happened.
     */
    private fun disconnectMessage(result: CompanionRepository.DisconnectResult): UiMessage {
        val localIncomplete = !result.localCleared
        if (result.remoteSucceeded && !localIncomplete) {
            return UiMessage("Disconnected. This device was revoked on the server.")
        }
        if (!result.remoteSucceeded && !localIncomplete) {
            val why = when {
                result.grantInvalid -> "the web grant is no longer valid"
                result.remoteAttempted -> "the server could not be reached"
                else -> "no authorized web session was available"
            }
            return UiMessage(
                "Local data cleared, but remote revocation could not be completed " +
                    "($why). Revoke this device from the desktop server UI to be safe.",
                isError = true,
            )
        }
        if (result.remoteSucceeded) {
            return UiMessage(
                "Disconnected from the server, but this device could not be fully cleaned " +
                    "locally (its web session could not be removed). Use Retry cleanup below " +
                    "to finish.",
                isError = true,
            )
        }
        val why = when {
            result.grantInvalid -> "the web grant is no longer valid"
            result.remoteAttempted -> "the server could not be reached"
            else -> "no authorized web session was available"
        }
        return UiMessage(
            "Disconnect is incomplete: remote revocation could not be completed ($why), and " +
                "the web session on this device could not be removed locally. Revoke this device " +
                "from the desktop server UI, then use Retry cleanup below.",
            isError = true,
        )
    }

    /**
     * User tapped "Retry cleanup" after a disconnect whose local cleanup was
     * unconfirmed (R2). Re-attempts removal of the retained origin cookie(s) —
     * no secrets needed — and reports the outcome, including the earlier
     * remote result so the guidance stays accurate.
     */
    fun retryCleanup() {
        if (!_ui.value.cleanupUnconfirmed) return
        val origins = _ui.value.cleanupOrigins
        val remoteSucceeded = _ui.value.cleanupRemoteSucceeded
        _ui.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            val result = repository.retryLocalCleanup(origins)
            if (result.cleared) {
                val message = when (remoteSucceeded) {
                    true if result.preservedNewerEnrollment ->
                        UiMessage("Old web-session data removed. The current enrollment is preserved.")
                    false if result.preservedNewerEnrollment -> UiMessage(
                        "Old web-session data removed and the current enrollment is preserved. " +
                            "Remote revocation was not completed — revoke the old device from the desktop server UI to be safe.",
                        isError = true,
                    )
                    null if result.preservedNewerEnrollment ->
                        UiMessage("Old web-session data removed. The current enrollment is preserved.")
                    true -> UiMessage("Local data removed. This device stays revoked on the server.")
                    false -> UiMessage(
                        "Local data removed. Remote revocation was not completed — revoke this " +
                            "device from the desktop server UI to be safe.",
                        isError = true,
                    )
                    null -> UiMessage("Local data removed.")
                }
                _ui.update {
                    it.copy(
                        busy = false,
                        cleanupUnconfirmed = false,
                        cleanupOrigins = emptyList(),
                        cleanupRemoteSucceeded = null,
                        message = message,
                    )
                }
            } else {
                _ui.update {
                    it.copy(
                        busy = false,
                        cleanupOrigins = result.unconfirmedCookieOrigins,
                        message = UiMessage(
                            "Cleanup is still incomplete — the web session could not be removed. " +
                                "Retry again, or revoke this device from the desktop server UI " +
                                "to be safe.",
                            isError = true,
                        ),
                    )
                }
            }
        }
    }

    fun dismissMessage() {
        _ui.update { it.copy(message = null) }
    }

    private fun qrRejectionText(reason: QrRejection): String = when (reason) {
        QrRejection.QR_TEXT_TOO_LONG -> "This QR code is too large to be an enrollment code."
        QrRejection.MALFORMED_JSON -> "Not a LamaSync enrollment QR code."
        QrRejection.UNSUPPORTED_KIND -> "Not a LamaSync Android enrollment QR code."
        QrRejection.UNSUPPORTED_VERSION -> "This enrollment format is not supported by this app version."
        QrRejection.MISSING_FIELD -> "The enrollment code is missing required fields."
        QrRejection.FIELD_TOO_LONG -> "The enrollment code contains overly long fields."
        QrRejection.SECRET_OUT_OF_BOUNDS -> "The enrollment code secret is invalid."
        QrRejection.BAD_ENROLLMENT_ID -> "The enrollment code identifier is invalid."
        QrRejection.BAD_ORIGIN ->
            "The server address must be a plain https URL (no credentials, path, query or fragment)."
    }

    private fun sanitizeDisplayName(input: String): String? {
        val trimmed = input.trim()
        if (trimmed.isEmpty() || trimmed.length > 64) return null
        if (trimmed.any { it.code < 0x20 || it.code == 0x7F }) return null
        return trimmed
    }

    private fun defaultDeviceName(): String {
        val model = (Build.MANUFACTURER.takeIf { !it.isNullOrBlank() && !it.equals("unknown", true) }?.let { "$it " }
            ?: "") + (Build.MODEL ?: "")
        return model.take(64).ifBlank { "Android device" }
    }
}
