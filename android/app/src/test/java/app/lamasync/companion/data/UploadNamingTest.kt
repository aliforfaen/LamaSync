package app.lamasync.companion.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Versioned-name collision retries (repeated/edited camera names). */
class UploadNamingTest {

    @Test
    fun versionedNamesKeepTheExtensionAndNumberUp() {
        assertEquals("IMG_0001 (2).jpg", UploadNaming.versionedName("IMG_0001.jpg", 1))
        assertEquals("IMG_0001 (3).jpg", UploadNaming.versionedName("IMG_0001.jpg", 2))
        assertEquals("no-extension (2)", UploadNaming.versionedName("no-extension", 1))
        // The LAST segment is treated as the extension.
        assertEquals("file.TAR (2).GZ", UploadNaming.versionedName("file.TAR.GZ", 1))
    }

    @Test
    fun derivedKeysAreDeterministicAndBounded() {
        val base = "autop:images:1@external_primary:aabbccddeeff"
        val k1a = UploadNaming.derivedKey(base, 1)
        val k1b = UploadNaming.derivedKey(base, 1)
        val k2 = UploadNaming.derivedKey(base, 2)
        assertEquals(k1a, k1b)
        assertTrue(k1a.length <= UploadNaming.MAX_KEY)
        assertFalse(k1a == k2)
        assertTrue(k1a.endsWith("#v1"))
    }

    @Test
    fun longKeysStayUnderTheServerLimit() {
        val longBase = "autop:" + "x".repeat(200)
        val derived = UploadNaming.derivedKey(longBase, 9)
        assertTrue(derived.length <= 128)
        assertTrue(derived.endsWith("#v9"))
    }
}