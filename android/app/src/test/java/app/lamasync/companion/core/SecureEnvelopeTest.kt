package app.lamasync.companion.core

import java.util.Base64
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Round-trip and failure-mode tests for the AES-GCM envelope using an
 * in-JVM key (the real Android Keystore key path is covered by the
 * instrumented vault test on a device).
 */
class SecureEnvelopeTest {

    private lateinit var keyA: SecretKey
    private lateinit var keyB: SecretKey

    @Before
    fun setUp() {
        keyA = newAesKey()
        keyB = newAesKey()
    }

    private fun newAesKey(): SecretKey {
        val generator = KeyGenerator.getInstance("AES")
        generator.init(256)
        return generator.generateKey()
    }

    @Test
    fun `round trip preserves bytes`() {
        for (plaintext in listOf(
            "native-token-value",
            "web grant value with spaces/unicode: ✓ / \\ \"",
            "a".repeat(1024),
            "",
        )) {
            assertEquals(plaintext, SecureEnvelope.open(keyA, SecureEnvelope.seal(keyA, plaintext)))
        }
    }

    @Test
    fun `encryption is randomized per call`() {
        val plaintext = "same secret"
        assertNotEquals(SecureEnvelope.seal(keyA, plaintext), SecureEnvelope.seal(keyA, plaintext))
    }

    @Test
    fun `wrong key fails closed`() {
        val envelope = SecureEnvelope.seal(keyA, "secret")
        val error = assertThrows(EnvelopeException.Tampered::class.java) {
            SecureEnvelope.open(keyB, envelope)
        }
        assertTrue(error.message.isNullOrBlank().not())
    }

    @Test
    fun `tampered ciphertext fails authentication`() {
        val envelope = SecureEnvelope.seal(keyA, "secret")
        val bytes = Base64.getUrlDecoder().decode(envelope.removePrefix("v1:"))
        bytes[bytes.size - 1] = (bytes.last().toInt() xor 0x01).toByte()
        val tampered = "v1:" + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        assertThrows(EnvelopeException.Tampered::class.java) {
            SecureEnvelope.open(keyA, tampered)
        }
    }

    @Test
    fun `structurally invalid envelopes are malformed`() {
        assertThrows(EnvelopeException.Malformed::class.java) {
            SecureEnvelope.open(keyA, "v2:AAAA")
        }
        assertThrows(EnvelopeException.Malformed::class.java) {
            SecureEnvelope.open(keyA, "v1:!!!not-base64!!!")
        }
        // Truncated payload (no room for IV + tag).
        val short = "v1:" + Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(8))
        assertThrows(EnvelopeException.Malformed::class.java) {
            SecureEnvelope.open(keyA, short)
        }
        // Empty envelope.
        assertThrows(EnvelopeException.Malformed::class.java) {
            SecureEnvelope.open(keyA, "")
        }
    }

    @Test
    fun `no plaintext appears in the envelope bytes`() {
        val plaintext = "super-secret-native-token-value"
        val envelope = SecureEnvelope.seal(keyA, plaintext)
        assertTrue(!envelope.contains(plaintext))
    }
}
