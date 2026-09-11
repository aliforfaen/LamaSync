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
        val base = "autop-images-1-external_primary-aabbccddeeff"
        val k1a = UploadNaming.derivedKey(base, 1)
        val k1b = UploadNaming.derivedKey(base, 1)
        val k2 = UploadNaming.derivedKey(base, 2)
        assertEquals(k1a, k1b)
        assertTrue(k1a.length <= UploadNaming.MAX_KEY)
        assertFalse(k1a == k2)
        assertTrue(k1a.endsWith(".v1"))
        assertTrue(k1a.matches(Regex("^[A-Za-z0-9._-]+$")))
    }

    @Test
    fun longKeysStayUnderTheServerLimit() {
        val longBase = "autop-" + "x".repeat(200)
        val derived = UploadNaming.derivedKey(longBase, 9)
        assertTrue(derived.length <= 128)
        assertTrue(derived.endsWith(".v9"))
        assertTrue(derived.matches(Regex("^[A-Za-z0-9._-]+$")))
    }

    // ---- P1: restart-deterministic collision retry series ----

    @Test
    fun baseStrippingRecoversTheImmutableOriginals() {
        assertEquals("IMG_0001.jpg", UploadNaming.baseDisplayName("IMG_0001.jpg"))
        assertEquals("IMG_0001.jpg", UploadNaming.baseDisplayName("IMG_0001 (2).jpg"))
        assertEquals("IMG_0001.jpg", UploadNaming.baseDisplayName("IMG_0001 (3).jpg"))
        assertEquals("no-extension", UploadNaming.baseDisplayName("no-extension (2)"))
        assertEquals(
            "autop-images-1-vol-aabb",
            UploadNaming.baseIdempotencyKey("autop-images-1-vol-aabb.v2"),
        )
        assertEquals("autop-images-1-vol-aabb", UploadNaming.baseIdempotencyKey("autop-images-1-vol-aabb"))
    }

    @Test
    fun restartAfterCollisionsProducesNestedFreeSeries() {
        val baseName = "IMG_0001.jpg"
        val baseKey = "autop-images-1-vol-aabb"
        // Run 1: two collisions → attempt 2 persisted.
        val attempt2Name = UploadNaming.versionedName(UploadNaming.baseDisplayName("IMG_0001 (2).jpg"), 2)
        val attempt2Key = UploadNaming.derivedKey(UploadNaming.baseIdempotencyKey("$baseKey.v1"), 2)
        assertEquals("IMG_0001 (3).jpg", attempt2Name)
        assertEquals("$baseKey.v2", attempt2Key)

        // Restart: the durable item carries attempt 2 and the VERSIONED name
        // and key; a further collision derives attempt 3 from the SAME base —
        // never `IMG_0001 (2) (2).jpg` / `base.v1.v1`.
        assertEquals("IMG_0001.jpg", UploadNaming.baseDisplayName(attempt2Name))
        assertEquals(baseKey, UploadNaming.baseIdempotencyKey(attempt2Key))
        assertEquals("IMG_0001 (4).jpg", UploadNaming.versionedName(baseName, 3))
        assertEquals("$baseKey.v3", UploadNaming.derivedKey(baseKey, 3))
    }

    @Test
    fun attemptBoundIsGlobalPerItemNotPerRun() {
        val identity = "images:1@vol"
        // Attempt 19 can still retry (one left).
        assertTrue(UploadNaming.canRetry(identity, 19))
        // Attempt 20 is the terminal cap — a restart does not reset it.
        assertFalse(UploadNaming.canRetry(identity, 20))
        // Manual items never retry.
        assertFalse(UploadNaming.canRetry(null, 0))
    }
}
