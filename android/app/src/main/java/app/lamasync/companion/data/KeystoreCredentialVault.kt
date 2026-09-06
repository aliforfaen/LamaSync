package app.lamasync.companion.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.core.content.edit
import app.lamasync.companion.core.EnvelopeException
import app.lamasync.companion.core.SecureEnvelope
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * Secret vault backed by Android Keystore key material (AES-256-GCM) with
 * ciphertext in private SharedPreferences. No plaintext fallback exists: when
 * key material is lost (data clear, restore, keystore wipe) reads return null
 * and the app must be re-paired — the old ciphertext is permanently
 * unreadable.
 *
 * The whole app opts out of backup (android:allowBackup="false"), so
 * ciphertext never leaves the device through cloud backup or device
 * transfer.
 */
class KeystoreCredentialVault(context: Context) : SecureCredentialVault {

    private val preferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val keyStore: KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    override fun saveCredentials(nativeToken: NativeToken, webGrant: WebGrant) {
        val key = getOrCreateKey()
        preferences.edit {
            putString(KEY_NATIVE_TOKEN, SecureEnvelope.seal(key, nativeToken.value))
            putString(KEY_WEB_GRANT, SecureEnvelope.seal(key, webGrant.value))
        }
    }

    override fun nativeToken(): NativeToken? {
        val encrypted = preferences.getString(KEY_NATIVE_TOKEN, null) ?: return null
        val key = currentKey() ?: return null
        return try {
            NativeToken.of(SecureEnvelope.open(key, encrypted))
        } catch (e: EnvelopeException) {
            null
        }
    }

    override fun webGrant(): WebGrant? {
        val encrypted = preferences.getString(KEY_WEB_GRANT, null) ?: return null
        val key = currentKey() ?: return null
        return try {
            WebGrant.of(SecureEnvelope.open(key, encrypted))
        } catch (e: EnvelopeException) {
            null
        }
    }

    override fun hasCredentials(): Boolean = preferences.contains(KEY_NATIVE_TOKEN)

    override fun clear() {
        preferences.edit { clear() }
        runCatching { keyStore.deleteEntry(KEY_ALIAS) }
    }

    private fun currentKey(): SecretKey? = keyStore.getKey(KEY_ALIAS, null) as? SecretKey

    private fun getOrCreateKey(): SecretKey {
        currentKey()?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val PREFS_NAME = "lamasync_secure_vault"
        const val KEY_ALIAS = "lamasync_credentials_v1"
        const val KEY_NATIVE_TOKEN = "native_token"
        const val KEY_WEB_GRANT = "web_grant"
    }
}
