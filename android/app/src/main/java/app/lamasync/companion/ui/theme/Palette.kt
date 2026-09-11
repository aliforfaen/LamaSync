package app.lamasync.companion.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * LAMA-329 — the Compose half of the LamaSync design-token contract.
 *
 * Source of truth: `packages/web-ui/src/index.css` (the `:root` /
 * `[data-theme="dark"]` and `[data-theme="light"]` blocks). These are the
 * SAME values, copied deliberately rather than re-invented: the management
 * surface renders the server-served SPA inside a WebView, so a Compose shell
 * that merely *approximated* the palette would visibly switch brands at the
 * WebView boundary.
 *
 * The four surface levels are the web contract's hierarchy and are always
 * used in this order of "height":
 *
 *   canvas (`bg`)               page background, behind the system bars
 *   panel (`surface`)           cards, tables, nav rail, app bars
 *   raised (`surfaceElevated`)  modals, popovers, dropdown menus
 *   inset (`surfaceInset`)      technical detail wells (paths, IDs, raw output)
 *
 * Status semantics (success / warning / critical / info / storage / sync) are
 * exported for later phases. As on the web, status must NEVER be signalled by
 * colour alone — always pair with text or an icon.
 */
internal object LamaSyncPalette {

    // ---------------------------------------------------------------- dark
    //
    // "Cozy nocturnal workshop": graphite, espresso, moss and clay. This is
    // the product's default appearance on both surfaces (`:root` on the web,
    // and the app's own default theme preference).

    object Dark {
        val canvas = Color(0xFF121310)
        val panel = Color(0xFF1B1B16)
        val raised = Color(0xFF24231C)
        val inset = Color(0xFF151611)

        val border = Color(0xFF39372B)
        val borderStrong = Color(0xFF5A5540)

        val text = Color(0xFFE8DFCE)
        val textDim = Color(0xFFBDB39F)
        val textMuted = Color(0xFF8D8777)
        val textStrong = Color(0xFFF4EAD8)
        val textOnAccent = Color(0xFFFFFFFF)

        val info = Color(0xFF75C3B1)
        /** Filled primary buttons; white text is 4.94:1 (WCAG AA pass). */
        val primary = Color(0xFF376353)

        val ok = Color(0xFF9ABB70)
        val warn = Color(0xFFD6A55B)
        val critical = Color(0xFFD87952)
        val colorError = Color(0xFFFF8585)

        val storage = Color(0xFFC79B58)
        val sync = Color(0xFF75C3B1)

        val backdrop = Color(0x8C000000)

        /** Container tints derived from the accents above (no web equivalent:
         *  the web expresses these as alpha over the surface, which Material's
         *  non-alpha container slots cannot). */
        val primaryContainer = Color(0xFF24493C)
        val onPrimaryContainer = Color(0xFFC3E4D4)
        val secondaryContainer = Color(0xFF37452B)
        val onSecondaryContainer = Color(0xFFCFE9A8)
        val tertiaryContainer = Color(0xFF4E3A18)
        val onTertiaryContainer = Color(0xFFF0D9AC)
        val errorContainer = Color(0xFF5C1F1F)
        val onErrorContainer = Color(0xFFFFDAD6)
        val onSecondary = Color(0xFF0B2B26)
        val onTertiary = Color(0xFF3A2A0B)
        val onError = Color(0xFF3B0A0A)
    }

    // --------------------------------------------------------------- light
    //
    // The same register in daylight: warm paper, ink, moss and clay.

    object Light {
        val canvas = Color(0xFFF2EEE5)
        val panel = Color(0xFFFBF8F0)
        val raised = Color(0xFFF4EFE3)
        val inset = Color(0xFFEAE4D6)

        val border = Color(0xFFD8CFBD)
        val borderStrong = Color(0xFFB8AA91)

        val text = Color(0xFF2A2922)
        val textDim = Color(0xFF5A5549)
        val textMuted = Color(0xFF7D7669)
        val textStrong = Color(0xFF171710)
        val textOnAccent = Color(0xFFFFFFFF)

        val info = Color(0xFF176F68)
        /** Filled primary buttons; white text is 5.17:1 (WCAG AA pass). */
        val primary = Color(0xFF235B46)

        val ok = Color(0xFF3E6F35)
        val warn = Color(0xFF8C5A1C)
        val critical = Color(0xFFA44727)
        val colorError = Color(0xFFC62828)

        val storage = Color(0xFF946728)
        val sync = Color(0xFF176F68)

        val backdrop = Color(0x59181226)

        val primaryContainer = Color(0xFFC9DED2)
        val onPrimaryContainer = Color(0xFF0B2B1F)
        val secondaryContainer = Color(0xFFD8E4C4)
        val onSecondaryContainer = Color(0xFF26320F)
        val tertiaryContainer = Color(0xFFF2DEB6)
        val onTertiaryContainer = Color(0xFF3D2C0A)
        val errorContainer = Color(0xFFFFDAD6)
        val onErrorContainer = Color(0xFF410002)
        val onSecondary = Color(0xFFFFFFFF)
        val onTertiary = Color(0xFFFFFFFF)
        val onError = Color(0xFFFFFFFF)
    }
}
