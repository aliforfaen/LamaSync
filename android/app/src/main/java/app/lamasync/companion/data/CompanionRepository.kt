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
        /**
         * Origins whose web-session cookie removal is still unconfirmed after
         * a previous disconnect (R2). Non-secret; enables a cleanup retry on a
         * later launch even though the registration/binding were cleared.
         */
        val cleanupPendingOrigins: List<String> = emptyList(),
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
            cleanupPendingOrigins = registrationStore.loadCleanupPending(),
        )
    }

    sealed interface EnrollOutcome {
        data class Success(val registration: Registration) : EnrollOutcome
        data class Failure(val step: EnrollStep, val cause: Throwable?) : EnrollOutcome
    }

    enum class EnrollStep { EXCHANGE, CLEANUP, STORE, IDENTITY, WEB_SESSION }

    /**
     * Re-pair cleanup result. [cleared] is true only when every previous-origin
     * cookie removal was confirmed AND the vault/store wipe succeeded;
     * [unconfirmedCookieOrigins] lists the origins whose cookie removal could
     * not be confirmed (the security-relevant leftover, R2).
     */
    data class LocalCleanupResult(
        val cleared: Boolean,
        val unconfirmedCookieOrigins: List<String>,
    )

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
        // can never leak into requests for this one. When the wipe cannot be
        // confirmed (R2) the new exchange must NOT start and the previous
        // pairing's records must survive so cleanup can be retried.
        val cleanup = clearLocalAuth()
        if (!cleanup.cleared) {
            return EnrollOutcome.Failure(
                EnrollStep.CLEANUP,
                LocalCleanupUnconfirmed(cleanup.unconfirmedCookieOrigins),
            )
        }

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
        /**
         * Origins whose web-session cookie removal could not be confirmed.
         * Kept (and persisted non-secretly) so cleanup can be retried later —
         * the cookie may still authenticate its origin (R2).
         */
        val unconfirmedCookieOrigins: List<String> = emptyList(),
    )

    /**
     * Disconnect: attempts server-side revocation through an authorized web
     * session (bootstrapping it from the stored web grant when needed), then
     * ALWAYS attempts local teardown — even when offline or when remote
     * revocation fails. The UI must surface [remoteSucceeded] == false so the
     * user knows to revoke from the desktop, and [localCleared] == false when
     * a local cleanup step could not be confirmed. When a cookie removal is
     * unconfirmed the origin is persisted ([RegistrationStore.loadCleanupPending])
     * so a later launch can still offer the cleanup retry (R2).
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
        val unconfirmedCookieOrigins = mutableListOf<String>()
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
            if (cleared) {
                // confirmed
            } else {
                cookieCleared = false
                unconfirmedCookieOrigins += origin
            }
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

        if (unconfirmedCookieOrigins.isNotEmpty()) {
            // Keep only the plain origins so a later launch (after the
            // registration/binding wipe above) can still offer the retry.
            try {
                registrationStore.saveCleanupPending(unconfirmedCookieOrigins)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Marker persistence is best-effort; the in-process UI still
                // carries the same origins in its state.
            }
        }

        return DisconnectResult(
            remoteAttempted = remoteAttempted,
            remoteSucceeded = remoteSucceeded,
            grantInvalid = grantInvalid,
            localCleared = localCleared,
            unconfirmedCookieOrigins = unconfirmedCookieOrigins,
        )
    }

    /**
     * Retries the cleanup of [origins] whose web-session cookie removal was
     * unconfirmed by a disconnect (R2). Requires no secrets — the origin is
     * enough to ask the platform to expire the cookie. Also re-attempts the
     * vault/store wipe for completeness (both are idempotent).
     */
    suspend fun retryLocalCleanup(origins: List<String>): LocalCleanupResult {
        val unconfirmed = mutableListOf<String>()
        for (origin in origins) {
            val cleared = try {
                cookieScope.clearSessionCookie(origin)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
            if (!cleared) unconfirmed += origin
        }
        if (unconfirmed.isNotEmpty()) {
            try {
                registrationStore.saveCleanupPending(unconfirmed)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // best effort
            }
            return LocalCleanupResult(cleared = false, unconfirmedCookieOrigins = unconfirmed)
        }
        // Cookie removal confirmed: re-attempt the remaining local teardown.
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
        if (!vaultCleared || !storeCleared) {
            // Nothing security-relevant remains unconfirmed (the cookies are
            // gone); report the incomplete wipe honestly. The store wipe also
            // clears any stale marker.
            registrationStore.clearCleanupPending()
            return LocalCleanupResult(cleared = false, unconfirmedCookieOrigins = emptyList())
        }
        // store.clear() already removed the marker together with all records.
        return LocalCleanupResult(cleared = true, unconfirmedCookieOrigins = emptyList())
    }

    /**
     * Wipes previous local auth — cookie(s) for any persisted origin (from the
     * registration, the binding, or an unconfirmed-cleanup marker), vault
     * secrets, and the registration + binding records. Suspend because cookie
     * expiry waits on the platform completion callback.
     *
     * Returns [LocalCleanupResult]: when any cookie removal is unconfirmed the
     * wipe ABORTS before touching the vault/store so the previous pairing's
     * records survive for a retry, and the caller must not start a new
     * exchange (R2).
     */
    private suspend fun clearLocalAuth(): LocalCleanupResult {
        val origins = buildList {
            registrationStore.load()?.origin?.let { add(it) }
            registrationStore.loadBinding()?.origin?.let { add(it) }
            registrationStore.loadCleanupPending().forEach { add(it) }
        }.distinct()
        if (origins.isEmpty()) return LocalCleanupResult(cleared = true, unconfirmedCookieOrigins = emptyList())

        val unconfirmed = mutableListOf<String>()
        for (origin in origins) {
            val cleared = try {
                cookieScope.clearSessionCookie(origin)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
            if (!cleared) unconfirmed += origin
        }
        if (unconfirmed.isNotEmpty()) {
            // A previous-origin cookie may still authenticate; the new pairing
            // must not start, and the previous records must stay so cleanup
            // can be retried (or that origin resumed).
            return LocalCleanupResult(cleared = false, unconfirmedCookieOrigins = unconfirmed)
        }
        val vaultCleared = try {
            vault.clear()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
        if (!vaultCleared) return LocalCleanupResult(cleared = false, unconfirmedCookieOrigins = emptyList())
        val storeCleared = try {
            registrationStore.clear()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
        return LocalCleanupResult(cleared = storeCleared, unconfirmedCookieOrigins = emptyList())
    }

    /**
     * Cause of an [EnrollStep.CLEANUP] failure: the previous pairing's cookie
     * removal could not be confirmed, so no new exchange ran. [unconfirmedOrigins]
     * names the origin(s) whose web session may still be present.
     */
    class LocalCleanupUnconfirmed(val unconfirmedOrigins: List<String>) :
        Exception("previous pairing cleanup unconfirmed for ${unconfirmedOrigins.joinToString()}")
}
