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
    private val repository = CompanionRepository(
        api = api,
        broker = broker,
        vault = vault,
        registrationStore = registrationStore,
        cookieScope = SessionCookieJar(),
    )

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
        _ui.update { it.copy(screen = Screen.WELCOME, message = null) }
    }

    /** Receives raw scanner output and validates it. */
    fun onQrScanned(raw: String) {
        when (val result = QrPayloadParser.parse(raw)) {
            is QrPayloadResult.Valid -> _ui.update {
                it.copy(screen = Screen.CONFIRM, candidate = result.payload, message = null)
            }
            is QrPayloadResult.Invalid -> _ui.update {
                it.copy(message = UiMessage(qrRejectionText(result.reason), isError = true))
            }
        }
    }

    fun onConfirmBack() {
        _ui.update { it.copy(screen = Screen.SCANNER, candidate = null, message = null) }
    }

    fun confirmEnrollment(displayName: String) {
        val candidate = _ui.value.candidate ?: return
        val name = sanitizeDisplayName(displayName)
        if (name == null) {
            _ui.update { it.copy(message = UiMessage("Enter a device name (up to 64 characters).", true)) }
            return
        }
        _ui.update { it.copy(screen = Screen.PROGRESS, busy = true, progressLabel = "Exchanging enrollment…") }
        viewModelScope.launch {
            // If an earlier attempt already exchanged the (single-use)
            // enrollment and persisted credentials, resume from the stored
            // state instead of re-exchanging (the server would answer 409).
            val alreadyExchanged = repository.loadSession().registration == null && vault.hasCredentials()
            if (!alreadyExchanged) {
                when (val outcome = repository.enroll(candidate, name, appVersion)) {
                    is CompanionRepository.EnrollOutcome.Success -> onEnrollSuccess(outcome.registration)
                    is CompanionRepository.EnrollOutcome.Failure -> onEnrollFailure(outcome)
                }
            } else {
                val origin = (OriginPolicy.parseHttpsOrigin(candidate.serverOrigin) as? OriginCheck.Valid)?.origin
                if (origin == null) {
                    _ui.update {
                        it.copy(busy = false, screen = Screen.CONFIRM,
                            message = UiMessage("The server address in this QR code is invalid.", isError = true))
                    }
                    return@launch
                }
                _ui.update { it.copy(progressLabel = "Verifying identity…") }
                when (val outcome = repository.completeEnrollment(origin, name, appVersion)) {
                    is CompanionRepository.EnrollOutcome.Success -> onEnrollSuccess(outcome.registration)
                    is CompanionRepository.EnrollOutcome.Failure -> onEnrollFailure(outcome)
                }
            }
        }
    }

    /** Retry after a mid-flow failure; never re-exchanges a consumed enrollment. */
    fun retryEnrollment() {
        val state = _ui.value
        val candidate = state.candidate ?: return
        val registrationExists = repository.loadSession().registration != null
        val canResume = vault.hasCredentials() && !registrationExists
        if (!canResume) {
            // Exchange never completed or credentials were lost: full re-run.
            confirmEnrollment(state.suggestedDeviceName)
            return
        }
        val origin = candidate.serverOrigin.let {
            app.lamasync.companion.core.OriginPolicy.parseHttpsOrigin(it)
        }
        val canonical = (origin as? app.lamasync.companion.core.OriginCheck.Valid)?.origin
        if (canonical == null) {
            confirmEnrollment(state.suggestedDeviceName)
            return
        }
        _ui.update { it.copy(busy = true, progressLabel = "Verifying identity…") }
        viewModelScope.launch {
            when (val outcome = repository.completeEnrollment(canonical, state.suggestedDeviceName, appVersion)) {
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
        _ui.update {
            it.copy(
                busy = false,
                progressLabel = null,
                screen = Screen.CONFIRM,
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
