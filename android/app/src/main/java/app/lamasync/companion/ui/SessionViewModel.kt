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
enum class Screen { WELCOME, SCANNER, CONFIRM, PROGRESS, MANAGE, CONNECTION }

/** One-shot user-facing message (shown as a snackbar). */
data class UiMessage(val text: String, val isError: Boolean = false)

data class UiState(
    val screen: Screen = Screen.WELCOME,
    val registration: Registration? = null,
    /** Enrolled origin whose key material could not be decrypted (re-pair needed). */
    val credentialLost: Boolean = false,
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
        _ui.update { state ->
            val screen = when {
                registration != null && snapshot.hasUsableNativeCredential -> Screen.MANAGE
                registration != null -> Screen.WELCOME // credentials lost: re-pair required
                else -> Screen.WELCOME
            }
            state.copy(
                screen = screen,
                registration = registration,
                credentialLost = registration != null && !snapshot.hasUsableNativeCredential,
                webSessionConnected = snapshot.hasSessionCookie,
            )
        }
        if (registration != null && snapshot.hasUsableNativeCredential) {
            runCheckIn()
        }
    }

    fun onLaunchFromWelcome() {
        _ui.update { it.copy(screen = Screen.SCANNER, message = null) }
    }

    fun onScannerBack() {
        _ui.update {
            it.copy(screen = Screen.WELCOME, message = null, candidate = null, pendingResume = false)
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
                busy = false,
                progressLabel = null,
                credentialLost = false,
                webSessionConnected = true,
                message = UiMessage("Enrolled with ${registration.origin}."),
            )
        }
        runCheckIn()
    }

    private fun onEnrollFailure(outcome: CompanionRepository.EnrollOutcome.Failure) {
        val cause = outcome.cause
        val stepText = when (outcome.step) {
            CompanionRepository.EnrollStep.EXCHANGE -> "The enrollment could not be exchanged"
            CompanionRepository.EnrollStep.STORE -> "Credentials could not be stored securely"
            CompanionRepository.EnrollStep.IDENTITY -> "The device identity could not be verified"
            CompanionRepository.EnrollStep.WEB_SESSION -> "The web session could not be opened"
        }
        val detail = when (cause) {
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
        val pending = _ui.value.candidate?.let { matchingBinding(it) } != null
        _ui.update {
            it.copy(
                busy = false,
                progressLabel = null,
                screen = Screen.CONFIRM,
                pendingResume = pending,
                message = UiMessage("$stepText. $detail", isError = true),
            )
        }
    }

    fun openConnectionPanel() {
        _ui.update { it.copy(screen = Screen.CONNECTION, message = null) }
    }

    fun closeConnectionPanel() {
        _ui.update { it.copy(screen = Screen.MANAGE, message = null) }
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
            val message = if (result.remoteSucceeded) {
                UiMessage("Disconnected. This device was revoked on the server.")
            } else {
                val why = when {
                    result.grantInvalid -> "the web grant is no longer valid"
                    result.remoteAttempted -> "the server could not be reached"
                    else -> "no authorized web session was available"
                }
                UiMessage(
                    "Local data cleared, but remote revocation could not be completed " +
                        "($why). Revoke this device from the desktop server UI to be safe.",
                    isError = true,
                )
            }
            _ui.update {
                it.copy(
                    screen = Screen.WELCOME,
                    registration = null,
                    credentialLost = false,
                    busy = false,
                    progressLabel = null,
                    candidate = null,
                    pendingResume = false,
                    webSessionConnected = false,
                    checkInOk = null,
                    lastCheckInLabel = null,
                    message = message,
                )
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
