package app.lamasync.companion.data

import android.content.Context
import androidx.core.content.edit
import kotlinx.serialization.json.Json

/**
 * Plain (non-secret) registration metadata in private SharedPreferences.
 * Contains no tokens or grants; secrets live in [KeystoreCredentialVault].
 */
class RegistrationStoreImpl(context: Context) : RegistrationStore {

    private val preferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val json = Json { ignoreUnknownKeys = true }

    override fun load(): Registration? {
        val raw = preferences.getString(KEY_REGISTRATION, null) ?: return null
        return try {
            json.decodeFromString(Registration.serializer(), raw)
        } catch (e: Exception) {
            null
        }
    }

    override fun save(registration: Registration) {
        preferences.edit {
            putString(KEY_REGISTRATION, json.encodeToString(Registration.serializer(), registration))
        }
    }

    override fun updateCheckIn(registration: Registration, epochMillis: Long, appVersion: String) {
        save(registration.copy(lastCheckInEpochMillis = epochMillis, lastCheckInAppVersion = appVersion))
    }

    override fun clear() {
        preferences.edit { clear() }
    }

    private companion object {
        const val PREFS_NAME = "lamasync_registration"
        const val KEY_REGISTRATION = "registration"
    }
}
