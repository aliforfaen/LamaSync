package app.lamasync.companion.data

import app.lamasync.companion.core.ApiFailure
import app.lamasync.companion.core.OriginCheck
import app.lamasync.companion.core.OriginPolicy
import app.lamasync.companion.core.EnrollmentQrPayload
import app.lamasync.companion.network.MobileApiClient
import app.lamasync.companion.network.WebSessionBroker
import app.lamasync.companion.web.WebCookieScope
import kotlinx.coroutines.CancellationException

/**
 * Orchestrates the pinned phase-1 flow:
 * scan → confirm → exchange → persist (encrypted) → identity probe → cookie
 * bootstrap → management WebView, plus check-in, web-session reconnect and
 * disconnect.
 *
 * Role separation is structural: [MobileApiClient] is constructed here with
 * only [SecureCredentialVault.nativeToken] values; [WebSessionBroker] only
 * with [SecureCredentialVault.webGrant] values. The repository is the single
 * place that splits the vault between the two.
 *
 * All collaborators are interfaces/fakes, so the repository (including
 * offline-disconnect behavior) is unit tested without network or Android.
 */
class CompanionRepository(
    private val api: MobileApiClient,
    private val broker: WebSessionBroker,
    private val vault: SecureCredentialVault,
    private val registrationStore: RegistrationStore,
    private val cookieScope: WebCookieScope,
    private val now: () -> Long = System::currentTimeMillis,
) {

    data class SessionSnapshot(
        val registration: Registration?,
        val hasUsableNativeCredential: Boolean,
        val hasWebGrant: Boolean,
        val hasSessionCookie: Boolean,
    )

    /** Loads persisted state at launch. */
    fun loadSession(): SessionSnapshot {
        val registration = registrationStore.load()
        return SessionSnapshot(
            registration = registration,
            hasUsableNativeCredential = vault.nativeToken() != null,
            hasWebGrant = vault.webGrant() != null,
            hasSessionCookie = registration != null &&
                cookieScope.readSessionCookie(registration.origin) != null,
        )
    }

    sealed interface EnrollOutcome {
        data class Success(val registration: Registration) : EnrollOutcome
        data class Failure(val step: EnrollStep, val cause: Throwable?) : EnrollOutcome
    }

    enum class EnrollStep { EXCHANGE, STORE, IDENTITY, WEB_SESSION }

    /**
     * Full enrollment. Re-pairing is explicit and resets any previous local
     * auth before the new server is activated (spec: one enrolled server per
     * installation).
     */
    suspend fun enroll(payload: EnrollmentQrPayload, displayName: String, appVersion: String): EnrollOutcome {
        val canonicalOrigin = when (val check = OriginPolicy.parseHttpsOrigin(payload.serverOrigin)) {
            is OriginCheck.Invalid -> return EnrollOutcome.Failure(EnrollStep.EXCHANGE, ApiFailure.InvalidRequest())
            is OriginCheck.Valid -> check.origin
        }
        // Re-pair: clear previous local auth and its cookie before activating.
        registrationStore.load()?.let { previous ->
            runCatching { cookieScope.clearSessionCookie(previous.origin) }
        }
        vault.clear()
        registrationStore.clear()

        val exchanged = try {
            api.exchangeEnrollment(
                origin = canonicalOrigin,
                enrollmentId = payload.enrollmentId,
                secret = payload.secret,
                displayName = displayName,
                appVersion = appVersion,
            )
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            return EnrollOutcome.Failure(EnrollStep.EXCHANGE, e)
        }

        val nativeToken = exchanged.nativeToken
        val webGrant = exchanged.webGrant
        try {
            vault.saveCredentials(nativeToken, webGrant)
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            return EnrollOutcome.Failure(EnrollStep.STORE, e)
        }

        return completeEnrollment(canonicalOrigin, displayName, webGrant, appVersion)
    }

    /**
     * Continues an interrupted enrollment after exchange+persist succeeded
     * (identity or web-session step failed): probes identity from the stored
     * native token, saves registration, then bootstraps the web session.
     */
    suspend fun completeEnrollment(
        origin: String,
        requestedDisplayName: String,
        appVersion: String,
    ): EnrollOutcome {
        val storedGrant = vault.webGrant()
        if (storedGrant == null) {
            return EnrollOutcome.Failure(EnrollStep.STORE, ApiFailure.Unauthorized())
        }
        return completeEnrollment(origin, requestedDisplayName, storedGrant, appVersion)
    }

    private suspend fun completeEnrollment(
        origin: String,
        requestedDisplayName: String,
        webGrant: WebGrant,
        appVersion: String,
    ): EnrollOutcome {
        val nativeToken = vault.nativeToken()
            ?: return EnrollOutcome.Failure(EnrollStep.IDENTITY, ApiFailure.Unauthorized())

        val profile = try {
            api.me(origin, nativeToken)
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            return EnrollOutcome.Failure(EnrollStep.IDENTITY, e)
        }

        val registration = Registration(
            origin = origin,
            hostId = profile.hostId,
            displayName = profile.displayName.ifBlank { requestedDisplayName },
            enrolledAtEpochMillis = now(),
        )
        registrationStore.save(registration)

        return bootstrapAndReturn(origin, webGrant, registration)
    }

    private suspend fun bootstrapAndReturn(
        origin: String,
        webGrant: WebGrant,
        registration: Registration,
    ): EnrollOutcome {
        return try {
            val session = broker.bootstrapWebSession(origin, webGrant)
            cookieScope.installSessionCookie(origin, session.cookieHeader)
            EnrollOutcome.Success(registration)
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            EnrollOutcome.Failure(EnrollStep.WEB_SESSION, e)
        }
    }

    sealed interface ReconnectOutcome {
        data object Success : ReconnectOutcome
        data class Failure(val cause: Throwable?) : ReconnectOutcome
    }

    /** Re-bootstraps the web session from the stored web grant (no QR). */
    suspend fun reconnectWebSession(origin: String): ReconnectOutcome {
        val grant = vault.webGrant()
        if (grant == null) {
            return ReconnectOutcome.Failure(ApiFailure.Unauthorized())
        }
        return try {
            val session = broker.bootstrapWebSession(origin, grant)
            cookieScope.installSessionCookie(origin, session.cookieHeader)
            ReconnectOutcome.Success
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            ReconnectOutcome.Failure(e)
        }
    }

    sealed interface CheckInOutcome {
        data class Success(val atEpochMillis: Long) : CheckInOutcome
        data object Skipped : CheckInOutcome
        data class Failure(val cause: Throwable?) : CheckInOutcome
    }

    /** Launch/resume check-in; host identity comes from the principal server-side. */
    suspend fun checkIn(appVersion: String): CheckInOutcome {
        val registration = registrationStore.load() ?: return CheckInOutcome.Skipped
        val nativeToken = vault.nativeToken() ?: return CheckInOutcome.Failure(ApiFailure.Unauthorized())
        return try {
            api.checkIn(registration.origin, nativeToken, appVersion)
            registrationStore.updateCheckIn(registration, now(), appVersion)
            CheckInOutcome.Success(registrationStore.load()?.lastCheckInEpochMillis ?: 0L)
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            CheckInOutcome.Failure(e)
        }
    }

    data class DisconnectResult(
        val remoteAttempted: Boolean,
        val remoteSucceeded: Boolean,
        val grantInvalid: Boolean,
        /** Always true: local secrets and the cookie are cleared even offline. */
        val localCleared: Boolean,
    )

    /**
     * Disconnect: attempts server-side revocation through an authorized web
     * session (bootstrapping it from the stored web grant when needed), then
     * ALWAYS clears local data — even when offline or when remote revocation
     * fails. The UI must surface [remoteSucceeded] == false so the user knows
     * to revoke from the desktop.
     */
    suspend fun disconnect(): DisconnectResult {
        val registration = registrationStore.load()
        val origin = registration?.origin
        var remoteAttempted = false
        var remoteSucceeded = false
        var grantInvalid = false

        if (registration != null && origin != null) {
            val grant = vault.webGrant()
            if (grant == null) {
                grantInvalid = true
            } else {
                try {
                    remoteAttempted = true
                    val session = broker.bootstrapWebSession(origin, grant)
                    val cookiePair = cookieScope.readSessionCookie(origin)
                        ?: WebSessionBroker.cookiePair(session.cookieHeader)
                    broker.revokeRegistration(origin, registration.hostId, cookiePair, session.csrfToken)
                    remoteSucceeded = true
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiFailure) {
                    grantInvalid = e is ApiFailure.Unauthorized
                } catch (e: Exception) {
                    // Offline, TLS failure, etc.: local clear still happens.
                }
            }
        }

        // Local teardown is unconditional.
        if (origin != null) {
            runCatching { cookieScope.clearSessionCookie(origin) }
        }
        runCatching { vault.clear() }
        runCatching { registrationStore.clear() }

        return DisconnectResult(
            remoteAttempted = remoteAttempted,
            remoteSucceeded = remoteSucceeded,
            grantInvalid = grantInvalid,
            localCleared = true,
        )
    }
}
