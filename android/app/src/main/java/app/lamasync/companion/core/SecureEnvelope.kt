package app.lamasync.companion.core

import java.security.GeneralSecurityException
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Versioned AES-256-GCM envelope for secrets at rest. Pure JVM: the cipher
 * logic is unit tested here with an in-memory key, while the Android
 * Keystore-backed key material lives in [app.lamasync.companion.data.KeystoreCredentialVault].
 *
 * Envelope format: `v1:<base64url(iv || ciphertext + tag)>`
 * (12-byte random IV, 128-bit GCM tag, no plaintext fallback).
 */
object SecureEnvelope {

    private const val VERSION_PREFIX = "v1:"
    private const val IV_LENGTH = 12
    private const val TAG_BITS = 128
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    private val random: SecureRandom = SecureRandom()

    fun seal(key: SecretKey, plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        // Randomized encryption: let the provider (Android Keystore / JCE)
        // pick the fresh IV. Caller-supplied IVs are rejected by Android
        // Keystore2 whenever the key has randomized encryption required —
        // which is the default and the secure choice, so the key material is
        // never weakened to permit app-supplied IVs.
        cipher.init(Cipher.ENCRYPT_MODE, key)
        var iv = cipher.iv
        val plain = plaintext.toByteArray(Charsets.UTF_8)
        val ciphertext = if (iv != null && iv.size == IV_LENGTH) {
            cipher.doFinal(plain)
        } else {
            // Defensive fallback for providers without auto-generated IVs:
            // re-initialize with a CSPRNG IV (never weakens Keystore keys —
            // they already generated their own IV above).
            iv = ByteArray(IV_LENGTH)
            random.nextBytes(iv)
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
            cipher.doFinal(plain)
        }
        val encoded = iv + ciphertext
        return VERSION_PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(encoded)
    }

    /**
     * @throws EnvelopeException.Tampered on wrong key, corruption or truncation.
     * @throws EnvelopeException.Malformed on structural decode failures.
     */
    fun open(key: SecretKey, envelope: String): String {
        if (!envelope.startsWith(VERSION_PREFIX)) throw EnvelopeException.Malformed()
        val raw = try {
            Base64.getUrlDecoder().decode(envelope.removePrefix(VERSION_PREFIX))
        } catch (e: IllegalArgumentException) {
            throw EnvelopeException.Malformed()
        }
        if (raw.size < IV_LENGTH + 16) throw EnvelopeException.Malformed()
        val iv = raw.copyOfRange(0, IV_LENGTH)
        val ciphertext = raw.copyOfRange(IV_LENGTH, raw.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        try {
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
            return cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
        } catch (e: javax.crypto.AEADBadTagException) {
            throw EnvelopeException.Tampered()
        } catch (e: GeneralSecurityException) {
            // Wrong key material, truncated tag, or provider mismatch: fail
            // closed — never return partial/plaintext data.
            throw EnvelopeException.Tampered()
        }
    }
}

sealed class EnvelopeException(message: String) : Exception(message) {
    class Malformed : EnvelopeException("malformed envelope")
    class Tampered : EnvelopeException("envelope failed authentication")
}
