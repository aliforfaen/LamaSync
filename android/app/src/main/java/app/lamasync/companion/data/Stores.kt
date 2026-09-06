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
    fun clear()
}
