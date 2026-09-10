package app.lamasync.companion.ui.theme

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * LAMA-329 — the palette-drift guard.
 *
 * The whole point of phase 1 is that the Compose shell and the embedded SPA are
 * the same product. The SPA is rendered by the server and hands the app its own
 * colours, so a Compose palette that merely *approximates* the web tokens would
 * change brand at the WebView boundary — and nothing else in the build would
 * notice.
 *
 * This test reads the design-token contract straight out of
 * `packages/web-ui/src/index.css` (the file whose header declares itself the
 * contract) and asserts every mirrored token still matches. When someone
 * retunes the web palette, this fails and says which token moved.
 */
class PaletteMirrorsWebTokensTest {

    private val css: String by lazy {
        val configured = System.getProperty("lamasync.webUiCss")
            ?: error(
                "Missing -Dlamasync.webUiCss; see the testOptions block in " +
                    "android/app/build.gradle.kts",
            )
        val file = File(configured)
        check(file.isFile) { "Design-token contract not found at ${file.absolutePath}" }
        file.readText()
    }

    private val darkBlock: String by lazy { blockAfter("[data-theme=\"dark\"]") }
    private val lightBlock: String by lazy { blockAfter("[data-theme=\"light\"]") }

    @Test
    fun `dark scheme mirrors the web dark tokens`() {
        assertTokens(
            block = darkBlock,
            expected = mapOf(
                "bg" to LamaSyncPalette.Dark.canvas,
                "surface" to LamaSyncPalette.Dark.panel,
                "surface-elevated" to LamaSyncPalette.Dark.raised,
                "surface-inset" to LamaSyncPalette.Dark.inset,
                "border" to LamaSyncPalette.Dark.border,
                "border-strong" to LamaSyncPalette.Dark.borderStrong,
                "text" to LamaSyncPalette.Dark.text,
                "text-dim" to LamaSyncPalette.Dark.textDim,
                "text-strong" to LamaSyncPalette.Dark.textStrong,
                "text-muted" to LamaSyncPalette.Dark.textMuted,
                "accent-info" to LamaSyncPalette.Dark.info,
                "accent-ok" to LamaSyncPalette.Dark.ok,
                "accent-warn" to LamaSyncPalette.Dark.warn,
                "accent-critical" to LamaSyncPalette.Dark.critical,
                "color-error" to LamaSyncPalette.Dark.colorError,
                "accent-storage" to LamaSyncPalette.Dark.storage,
            ),
        )
        assertRgbToken("accent-primary-rgb", darkBlock, LamaSyncPalette.Dark.primary)
    }

    @Test
    fun `light scheme mirrors the web light tokens`() {
        assertTokens(
            block = lightBlock,
            expected = mapOf(
                "bg" to LamaSyncPalette.Light.canvas,
                "surface" to LamaSyncPalette.Light.panel,
                "surface-elevated" to LamaSyncPalette.Light.raised,
                "surface-inset" to LamaSyncPalette.Light.inset,
                "border" to LamaSyncPalette.Light.border,
                "border-strong" to LamaSyncPalette.Light.borderStrong,
                "text" to LamaSyncPalette.Light.text,
                "text-dim" to LamaSyncPalette.Light.textDim,
                "text-strong" to LamaSyncPalette.Light.textStrong,
                "text-muted" to LamaSyncPalette.Light.textMuted,
                "accent-info" to LamaSyncPalette.Light.info,
                "accent-ok" to LamaSyncPalette.Light.ok,
                "accent-warn" to LamaSyncPalette.Light.warn,
                "accent-critical" to LamaSyncPalette.Light.critical,
                "color-error" to LamaSyncPalette.Light.colorError,
                "accent-storage" to LamaSyncPalette.Light.storage,
            ),
        )
        assertRgbToken("accent-primary-rgb", lightBlock, LamaSyncPalette.Light.primary)
    }

    @Test
    fun `the four surface levels stay distinct in both themes`() {
        // The web contract promises exactly four surface levels in a fixed
        // order of "height". If two of them ever collapsed to the same colour,
        // the hierarchy the shell relies on would be gone in the Compose half
        // with nothing else in the build noticing.
        for ((name, surfaces) in listOf(
            "dark" to listOf(
                LamaSyncPalette.Dark.canvas,
                LamaSyncPalette.Dark.panel,
                LamaSyncPalette.Dark.raised,
                LamaSyncPalette.Dark.inset,
            ),
            "light" to listOf(
                LamaSyncPalette.Light.canvas,
                LamaSyncPalette.Light.panel,
                LamaSyncPalette.Light.raised,
                LamaSyncPalette.Light.inset,
            ),
        )) {
            assertEquals(
                "$name scheme must keep exactly four distinct surface levels",
                surfaces.size,
                surfaces.toSet().size,
            )
        }
    }

    private fun assertTokens(block: String, expected: Map<String, Color>) {
        for ((tokenName, color) in expected) {
            assertEquals(
                "--$tokenName drifted from the Compose palette",
                color,
                colorFromHex(tokenName, token(block, tokenName)),
            )
        }
    }

    private fun assertRgbToken(name: String, block: String, expected: Color) {
        val parts = token(block, name).split(",").map { it.trim().toInt() }
        assertEquals("--$name must be an r, g, b triple", 3, parts.size)
        assertEquals(
            "--$name drifted from the Compose palette",
            expected,
            Color(parts[0], parts[1], parts[2]),
        )
    }

    private fun blockAfter(selector: String): String {
        val start = css.indexOf(selector)
        assertTrue("design-token contract no longer declares $selector", start >= 0)
        val open = css.indexOf('{', start)
        val close = css.indexOf('}', open)
        assertTrue("malformed token block for $selector", open in 1 until close)
        return css.substring(open + 1, close)
    }

    private fun token(block: String, name: String): String {
        val match = Regex("--$name\\s*:\\s*([^;]+);").find(block)
        assertTrue("--$name is missing from the design-token contract", match != null)
        return match!!.groupValues[1].trim()
    }

    private fun colorFromHex(tokenName: String, raw: String): Color {
        val clean = raw.removePrefix("#")
        assertTrue("--$tokenName is not a 6-digit hex colour: $raw", clean.length == 6)
        return Color(0xFF000000L or clean.toLong(16))
    }
}
