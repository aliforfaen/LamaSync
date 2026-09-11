package app.lamasync.companion.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LAMA-334 item 1 — what "a gallery folder" means, off-device.
 *
 * The MediaStore walk needs a device, but the part that decides which folder a
 * file belongs to, what the folder is called, and what order the catalogue is
 * in is pure — and it is the part that decides whether an upload's contents are
 * predictable. These are the cases that fix those promises.
 */
class GalleryFoldersTest {

    // ------------------------------------------------------------ topLevelKey

    @Test
    fun `relative paths fold to their top-level segment`() {
        // API 29+: RELATIVE_PATH is the file's directory, with a trailing slash.
        assertEquals("dcim", GalleryFolders.topLevelKey("DCIM/Camera/", null))
        assertEquals("dcim", GalleryFolders.topLevelKey("DCIM/Screenshots/", null))
        assertEquals("download", GalleryFolders.topLevelKey("Download/", null))
        assertEquals("pictures", GalleryFolders.topLevelKey("Pictures/WhatsApp Images/", null))
        assertEquals("android", GalleryFolders.topLevelKey("Android/media/com.example/", null))
    }

    @Test
    fun `the segment is case-folded so OEM casing cannot split a folder`() {
        // DCIM vs Dcim vs dcim are one folder, not three.
        val keys = setOf(
            GalleryFolders.topLevelKey("DCIM/Camera/", null),
            GalleryFolders.topLevelKey("Dcim/Camera/", null),
            GalleryFolders.topLevelKey("dcim/camera/", null),
        )
        assertEquals(setOf("dcim"), keys)
    }

    @Test
    fun `pre-Q absolute paths are stripped of their storage root`() {
        val root = "/storage/emulated/0"
        assertEquals(
            "dcim",
            GalleryFolders.topLevelKey(null, "$root/DCIM/Camera/IMG_0001.jpg", root),
        )
        // A secondary volume, with no known root: the documented prefixes go.
        assertEquals(
            "download",
            GalleryFolders.topLevelKey(null, "/storage/1A2B-3C4D/Download/report.pdf", null),
        )
        assertEquals(
            "pictures",
            GalleryFolders.topLevelKey(null, "/mnt/media_rw/1A2B-3C4D/Pictures/x.png", null),
        )
    }

    @Test
    fun `an unclassifiable row is skipped rather than guessed`() {
        assertNull(GalleryFolders.topLevelKey(null, null))
        assertNull(GalleryFolders.topLevelKey("", ""))
        assertNull(GalleryFolders.topLevelKey("   ", null))
        // A relative-looking value still yields its first segment rather than
        // throwing; MediaStore's RELATIVE_PATH is always a directory path, so
        // this only matters for defensive input.
        assertEquals("weird.txt", GalleryFolders.topLevelKey("weird.txt", null))
    }

    // --------------------------------------------------------------- labels

    @Test
    fun `known segments get the name a gallery app would use`() {
        assertEquals("Camera roll", GalleryFolders.labelFor("dcim"))
        assertEquals("Downloads", GalleryFolders.labelFor("download"))
        assertEquals("Screenshots", GalleryFolders.labelFor("screenshots"))
    }

    @Test
    fun `an unknown segment is still readable, never dropped`() {
        assertEquals("My Custom Album", GalleryFolders.labelFor("my-custom_album"))
        assertEquals("Xyz", GalleryFolders.labelFor("xyz"))
    }

    // ------------------------------------------------------------ catalogue

    private fun rows(vararg pairs: Pair<String?, Long?>): List<GalleryRow> =
        pairs.map { GalleryRow(it.first, it.second) }

    @Test
    fun `items aggregate into one entry per folder with counts and bytes`() {
        val catalogue = GalleryFolders.catalogue(
            rows(
                "dcim" to 1_000L,
                "dcim" to 2_000L,
                "dcim" to null,
                "download" to 500L,
            ),
        )
        assertEquals(listOf("dcim", "download"), catalogue.map { it.key })
        val camera = catalogue.first()
        assertEquals(3, camera.itemCount)
        assertEquals(3_000L, camera.totalBytes)
        assertEquals("Camera roll", camera.label)
        assertEquals(1, catalogue.first { it.key == "download" }.itemCount)
    }

    @Test
    fun `unclassifiable rows are not folded into a folder`() {
        val catalogue = GalleryFolders.catalogue(rows(null to 10L, "dcim" to 10L))
        assertEquals(listOf("dcim"), catalogue.map { it.key })
    }

    @Test
    fun `the common device folders come first, then the biggest`() {
        val catalogue = GalleryFolders.catalogue(
            rows(
                "zed" to 1L,
                "download" to 1L,
                "zed" to 1L,
                "zed" to 1L,
                "dcim" to 1L,
                "alpha" to 1L,
                "alpha" to 1L,
                "alpha" to 1L,
                "alpha" to 1L,
            ),
        )
        // Camera roll and Downloads lead regardless of size; the rest follow by
        // item count, then label — deterministic across refreshes.
        assertEquals(listOf("dcim", "download", "alpha", "zed"), catalogue.map { it.key })
    }

    @Test
    fun `negative or missing sizes never reduce a folder's total`() {
        val catalogue = GalleryFolders.catalogue(rows("dcim" to -5L, "dcim" to 7L))
        assertEquals(7L, catalogue.single().totalBytes)
    }

    @Test
    fun `an empty catalogue is empty, not a phantom folder`() {
        assertTrue(GalleryFolders.catalogue(emptyList()).isEmpty())
    }

    @Test
    fun `the scan cap is a stated bound, not a silent one`() {
        // The listing carries `truncated`; the catalogue itself never invents
        // folders to fill the gap.
        val listing = GalleryFolderListing(emptyList(), MediaPermissionScope.FULL, truncated = true)
        assertTrue(listing.truncated)
        assertEquals(MediaPermissionScope.FULL, listing.scope)
        assertTrue(GalleryFolders.MAX_SCAN_ROWS > GalleryFolders.PAGE_ROWS)
    }
}
