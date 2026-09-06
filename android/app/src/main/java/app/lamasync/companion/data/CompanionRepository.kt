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
 * Enrollment binding invariant (review findings 1/5): once the single-use
 * enrollment is exchanged, an [EnrollmentBinding] ties the persisted secrets
 * to the canonical origin, the enrollment id, the issued host id and the
 * completed [EnrollmentStage]. Resume is possible ONLY for that exact
 * (origin, enrollmentId); a different QR explicitly clears the pending state
 * (and the credentials bound to the previous origin) before running its own
 * exchange. The repository enforces this independent of ViewModel checks:
 * [completeEnrollment] refuses any origin that does not match the persisted
 * binding, so stored credentials are never sent to a different server.
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
        /** In-flight enrollment binding, if any (see [EnrollmentBinding]). */
        val pendingBinding: EnrollmentBinding?,
        val hasUsableNativeCredential: Boolean,
        val hasWebGrant: Boolean,
        val hasSessionCookie: Boolean,
    )

    /** Loads persisted state at launch. */
    fun loadSession(): SessionSnapshot {
        val registration = registrationStore.load()
        return SessionSnapshot(
            registration = registration,
            pendingBinding = registrationStore.loadBinding(),
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
     * Full enrollment. When the same (origin, enrollmentId) is confirmed again
     * while its exchange has already succeeded and credentials are persisted,
     * this resumes that enrollment instead of re-exchanging the consumed
     * single-use code. A different QR — or no usable in-flight binding —
     * explicitly replaces/clears any previous local auth (re-pairing, spec:
     * one enrolled server per installation) and performs its own exchange.
     */
    suspend fun enroll(
        payload: EnrollmentQrPayload,
        displayName: String,
        appVersion: String,
    ): EnrollOutcome {
        val canonicalOrigin = when (val check = OriginPolicy.parseHttpsOrigin(payload.serverOrigin)) {
            is OriginCheck.Invalid -> return EnrollOutcome.Failure(EnrollStep.EXCHANGE, ApiFailure.InvalidRequest())
            is OriginCheck.Valid -> check.origin
        }

        val binding = registrationStore.loadBinding()
        if (binding != null &&
            binding.origin == canonicalOrigin &&
            binding.enrollmentId == payload.enrollmentId &&
            vault.hasCredentials()
        ) {
            // Same enrollment confirmed again after an interruption: resume at
            // the bound origin. completeEnrollment() re-validates the origin,
            // so the stored credentials can never be pointed at another server.
            return completeEnrollment(canonicalOrigin, appVersion)
        }

        // Re-pair / replacement: wipe previous local auth and its cookie
        // BEFORE the new exchange, so credentials bound to an earlier origin
        // can never leak into requests for this one.
        clearLocalAuth()

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

        try {
            vault.saveCredentials(exchanged.nativeToken, exchanged.webGrant)
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            return EnrollOutcome.Failure(EnrollStep.STORE, e)
        }
        registrationStore.saveBinding(
            EnrollmentBinding(
                origin = canonicalOrigin,
                enrollmentId = payload.enrollmentId,
                hostId = exchanged.hostId,
                displayName = displayName,
                stage = EnrollmentStage.EXCHANGED,
            ),
        )

        return resumeEnrollment(canonicalOrigin, appVersion)
    }

    /**
     * Resumes the persisted enrollment at [origin] from wherever it stopped
     * (see [EnrollmentStage]). This is the recovery entry point used by the
     * UI Retry action and after process death; it never re-exchanges a
     * consumed enrollment.
     *
     * Invariant: stored credentials are bound to [EnrollmentBinding.origin];
     * if [origin] does not match, this refuses instead of sending them there.
     */
    suspend fun completeEnrollment(origin: String, appVersion: String): EnrollOutcome {
        val binding = registrationStore.loadBinding()
            ?: return EnrollOutcome.Failure(EnrollStep.IDENTITY, ApiFailure.Unauthorized())
        if (binding.origin != origin) {
            // The stored credentials belong to another enrollment/origin. They
            // must never be used for this origin — the caller has to run a
            // fresh exchange (which itself clears the stale binding first).
            return EnrollOutcome.Failure(EnrollStep.IDENTITY, ApiFailure.Unauthorized())
        }
        return resumeEnrollment(origin, appVersion)
    }

    private suspend fun resumeEnrollment(origin: String, appVersion: String): EnrollOutcome {
        val binding = registrationStore.loadBinding()
            ?: return EnrollOutcome.Failure(EnrollStep.IDENTITY, ApiFailure.Unauthorized())
        if (binding.origin != origin) {
            return EnrollOutcome.Failure(EnrollStep.IDENTITY, ApiFailure.Unauthorized())
        }
        if (binding.stage == EnrollmentStage.EXCHANGED) {
            // Exchange completed; identity probe + registration not yet done.
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
                displayName = profile.displayName.ifBlank { binding.displayName },
                enrolledAtEpochMillis = now(),
            )
            registrationStore.save(registration)
            registrationStore.saveBinding(
                binding.copy(hostId = profile.hostId, stage = EnrollmentStage.REGISTERED),
            )
        }
        return finishRegisteredEnrollment(origin)
    }

    /**
     * Bootstraps the web session from the stored grant for a registration that
     * already completed identity (stage REGISTERED). The registration — and
     * with it the user's display name — is preserved untouched, and the
     * secrets are never cleared or re-exchanged (finding 5).
     */
    private suspend fun finishRegisteredEnrollment(origin: String): EnrollOutcome {
        val registration = registrationStore.load()
            ?: return EnrollOutcome.Failure(EnrollStep.WEB_SESSION, ApiFailure.Unauthorized())
        if (registration.origin != origin) {
            return EnrollOutcome.Failure(EnrollStep.WEB_SESSION, ApiFailure.Unauthorized())
        }
        val grant = vault.webGrant()
            ?: return EnrollOutcome.Failure(EnrollStep.WEB_SESSION, ApiFailure.Unauthorized())

        val session = try {
            broker.bootstrapWebSession(origin, grant)
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            return EnrollOutcome.Failure(EnrollStep.WEB_SESSION, e)
        }
        val installed = try {
            cookieScope.installSessionCookie(origin, session.cookieHeader)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return EnrollOutcome.Failure(EnrollStep.WEB_SESSION, e)
        }
        if (!installed) {
            // Enrollment must not be reported as success before the platform
            // accepted the session cookie (finding 3): the WebView would open
            // without a usable session.
            return EnrollOutcome.Failure(
                EnrollStep.WEB_SESSION,
                ApiFailure.MalformedResponse("session cookie was rejected by the platform"),
            )
        }
        return EnrollOutcome.Success(registration)
    }

    sealed interface ReconnectOutcome {
        data object Success : ReconnectOutcome
        data class Failure(val cause: Throwable?) : ReconnectOutcome
    }

    /** Re-bootstraps the web session from the stored web grant (no QR). */
    suspend fun reconnectWebSession(origin: String): ReconnectOutcome {
        val registration = registrationStore.load()
        if (registration != null && registration.origin != origin) {
            return ReconnectOutcome.Failure(ApiFailure.Unauthorized())
        }
        val binding = registrationStore.loadBinding()
        if (binding != null && binding.origin != origin) {
            return ReconnectOutcome.Failure(ApiFailure.Unauthorized())
        }
        val grant = vault.webGrant()
            ?: return ReconnectOutcome.Failure(ApiFailure.Unauthorized())
        return try {
            val session = broker.bootstrapWebSession(origin, grant)
            val installed = cookieScope.installSessionCookie(origin, session.cookieHeader)
            if (!installed) {
                return ReconnectOutcome.Failure(
                    ApiFailure.MalformedResponse("session cookie was rejected by the platform"),
                )
            }
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
        /**
         * True only when every local cleanup step reported success (cookie
         * expiry confirmed by the platform, vault wiped, stores cleared).
         * Never assumed — reported honestly (finding 3).
         */
        val localCleared: Boolean,
    )

    /**
     * Disconnect: attempts server-side revocation through an authorized web
     * session (bootstrapping it from the stored web grant when needed), then
     * ALWAYS attempts local teardown — even when offline or when remote
     * revocation fails. The UI must surface [remoteSucceeded] == false so the
     * user knows to revoke from the desktop, and [localCleared] == false when
     * a local cleanup step could not be confirmed.
     */
    suspend fun disconnect(): DisconnectResult {
        val registration = registrationStore.load()
        val remoteOrigin = registration?.origin
        var remoteAttempted = false
        var remoteSucceeded = false
        var grantInvalid = false

        if (registration != null && remoteOrigin != null) {
            val grant = vault.webGrant()
            if (grant == null) {
                grantInvalid = true
            } else {
                try {
                    remoteAttempted = true
                    val session = broker.bootstrapWebSession(remoteOrigin, grant)
                    // Finding 2: the native revoke request presents the cookie
                    // AND the CSRF token from the SAME fresh bootstrap
                    // response. The platform CookieManager is never consulted
                    // here — it may hold a stale/expired cookie from an
                    // earlier session, which the server rejects (403/401).
                    val freshCookiePair = WebSessionBroker.cookiePair(session.cookieHeader)
                    broker.revokeRegistration(
                        origin = remoteOrigin,
                        hostId = registration.hostId,
                        cookieHeader = freshCookiePair,
                        csrfToken = session.csrfToken,
                    )
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

        // Local teardown always runs; each step reports honestly instead of
        // unconditionally claiming success. Each step executes even when an
        // earlier one failed (no short-circuiting).
        var cookieCleared = true
        val cookieOrigins = buildList {
            registrationStore.load()?.origin?.let { add(it) }
            registrationStore.loadBinding()?.origin?.let { add(it) }
        }.distinct()
        for (origin in cookieOrigins) {
            val cleared = try {
                cookieScope.clearSessionCookie(origin)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
            cookieCleared = cookieCleared && cleared
        }
        val vaultCleared = try {
            vault.clear()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
        val storeCleared = try {
            registrationStore.clear()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
        val localCleared = cookieCleared && vaultCleared && storeCleared

        return DisconnectResult(
            remoteAttempted = remoteAttempted,
            remoteSucceeded = remoteSucceeded,
            grantInvalid = grantInvalid,
            localCleared = localCleared,
        )
    }

    /**
     * Wipes previous local auth — cookie(s) for any persisted origin, vault
     * secrets, and the registration + binding records. Suspend because cookie
     * expiry waits on the platform completion callback.
     */
    private suspend fun clearLocalAuth() {
        val origins = buildList {
            registrationStore.load()?.origin?.let { add(it) }
            registrationStore.loadBinding()?.origin?.let { add(it) }
        }.distinct()
        for (origin in origins) {
            try {
                cookieScope.clearSessionCookie(origin)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Best effort during re-pair; the new cookie replaces it.
            }
        }
        vault.clear()
        registrationStore.clear()
    }
}
