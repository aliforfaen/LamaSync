package app.lamasync.companion.data

import kotlinx.serialization.Serializable

/**
 * Persisted enrollment/registration facts. This is NOT secret material — it
 * is the identity the app shows in the connection panel (server origin,
 * server-assigned host id, device display name). Secrets live only in
 * [SecureCredentialVault].
 */
@Serializable
data class Registration(
    val origin: String,
    val hostId: String,
    val displayName: String,
    val enrolledAtEpochMillis: Long,
    val lastCheckInEpochMillis: Long? = null,
    val lastCheckInAppVersion: String? = null,
)

/**
 * How far an interrupted enrollment got before it stopped. The stage is the
 * highest *completed* step of the exchange→identity→bootstrap chain:
 *
 *  - [EXCHANGED]: the single-use enrollment was exchanged and both secrets
 *    were persisted; the identity probe has not completed (registration
 *    absent). Resume must probe `/mobile/me`, save the registration and then
 *    bootstrap.
 *  - [REGISTERED]: identity succeeded and the [Registration] is saved;
 *    only the web-session cookie bootstrap may still be pending/failed.
 *    Resume must re-bootstrap from the saved grant without re-exchanging,
 *    re-probing identity or clearing credentials.
 */
enum class EnrollmentStage { EXCHANGED, REGISTERED }

/**
 * Persisted binding that ties the vault credentials in [SecureCredentialVault]
 * to exactly one enrollment. This is NOT secret material: it records the
 * canonical origin, the one-time enrollment id, the server-issued host id,
 * the user-chosen display name and the completed [EnrollmentStage].
 *
 * Invariant (finding 1): credentials may only ever be used against
 * [EnrollmentBinding.origin]. Resume is permitted only for the exact
 * (origin, enrollmentId) pair recorded here; a different QR explicitly
 * replaces/clears this binding (and the credentials it bound) before its own
 * exchange runs. Repository methods enforce this — the ViewModel never
 * decides alone where stored credentials may be sent.
 */
@Serializable
data class EnrollmentBinding(
    val origin: String,
    val enrollmentId: String,
    val hostId: String,
    val displayName: String,
    val stage: EnrollmentStage,
)

interface SecureCredentialVault {
    /** Persists both secrets encrypted with Keystore-backed key material. */
    fun saveCredentials(nativeToken: NativeToken, webGrant: WebGrant)

    /** Decrypts and returns the native token, or null when absent/unreadable. */
    fun nativeToken(): NativeToken?

    /** Decrypts and returns the web grant, or null when absent/unreadable. */
    fun webGrant(): WebGrant?

    fun hasCredentials(): Boolean

    /** Wipes ciphertext AND destroys the Keystore key: re-pair is required. */
    fun clear()
}

interface RegistrationStore {
    fun load(): Registration?
    fun save(registration: Registration)
    fun updateCheckIn(registration: Registration, epochMillis: Long, appVersion: String)

    /** Loads the persisted enrollment binding (may be null when none in flight). */
    fun loadBinding(): EnrollmentBinding?

    /** Persists/updates the enrollment binding that ties credentials to an origin. */
    fun saveBinding(binding: EnrollmentBinding)

    /**
     * Loads the origins whose web-session cookie removal is still unconfirmed
     * after a disconnect (R2). Plain non-secret origin strings, kept so a
     * later launch can offer to retry the cleanup even though the
     * registration/binding records were already cleared.
     */
    fun loadCleanupPending(): List<String>

    /** Persists the origins whose cookie removal is still unconfirmed. */
    fun saveCleanupPending(origins: List<String>)

    /** Clears the unconfirmed-cleanup marker (cookie removal now confirmed). */
    fun clearCleanupPending()

    /** Clears BOTH the registration and any pending enrollment binding. */
    fun clear()
}
