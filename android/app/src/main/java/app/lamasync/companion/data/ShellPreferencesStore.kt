package app.lamasync.companion.data

import android.content.Context
import androidx.core.content.edit

/**
 * The user's appearance choice. Deliberately the same three options the web UI
 * offers (`packages/web-ui/src/theme.ts`, `ThemeChoice`), so a user who picks
 * "Light" in either surface gets a consistent answer.
 */
enum class ThemePreference { SYSTEM, LIGHT, DARK }

/**
 * LAMA-329 — every device-local shell preference, in one place.
 *
 * "Appearance" and "Browser experience" are two faces of the same thing: how
 * this device renders and drives the surfaces it hosts. Keeping them in a
 * single store makes "which store owns this preference?" answerable by
 * reading the Settings screen against this file.
 *
 * Scope discipline:
 *  - these are PRESENTATION/BEHAVIOUR preferences. Nothing here can weaken the
 *    security boundary, change an authorization decision, or alter what is
 *    uploaded. [openExternalLinks] chooses between handing a cross-origin link
 *    to the system browser and refusing it — never between loading it
 *    in-process;
 *  - the store is NOT part of `RegistrationStore`, so a disconnect does not
 *    wipe it and a stale value cannot survive as device identity.
 *
 * Defaults are brand-preserving rather than neutral:
 *  - [theme] defaults to [ThemePreference.SYSTEM], matching the web UI, which
 *    also defaults to `system`;
 *  - [dynamicColor] defaults to `false`. Material You wallpaper colouring is an
 *    explicit opt-in: it would repaint the Compose shell in colours the
 *    embedded SPA does not use, so the two surfaces would visibly disagree
 *    about what product this is;
 *  - [pullToRefresh] and [openExternalLinks] default to `true`, which is the
 *    behaviour the app already had (the top-bar reload affordance and handing
 *    external links to the browser) plus the newly-added gesture.
 */
data class ShellPreferences(
    val theme: ThemePreference = ThemePreference.SYSTEM,
    val dynamicColor: Boolean = false,
    val pullToRefresh: Boolean = true,
    val openExternalLinks: Boolean = true,
)

/**
 * SharedPreferences-backed [ShellPreferences]. Non-secret, device-local
 * presentation state: it stores nothing that identifies the device or the
 * server.
 */
class ShellPreferencesStore(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(): ShellPreferences = ShellPreferences(
        theme = parseTheme(prefs.getString(KEY_THEME, null)),
        dynamicColor = prefs.getBoolean(KEY_DYNAMIC_COLOR, false),
        pullToRefresh = prefs.getBoolean(KEY_PULL_TO_REFRESH, true),
        openExternalLinks = prefs.getBoolean(KEY_OPEN_EXTERNAL_LINKS, true),
    )

    fun save(preferences: ShellPreferences) {
        prefs.edit {
            putString(KEY_THEME, preferences.theme.name.lowercase())
            putBoolean(KEY_DYNAMIC_COLOR, preferences.dynamicColor)
            putBoolean(KEY_PULL_TO_REFRESH, preferences.pullToRefresh)
            putBoolean(KEY_OPEN_EXTERNAL_LINKS, preferences.openExternalLinks)
        }
    }

    /**
     * An unreadable or unknown stored value falls back to
     * [ThemePreference.SYSTEM] rather than throwing: appearance is not worth
     * failing a launch over.
     */
    private fun parseTheme(stored: String?): ThemePreference = when (stored) {
        "light" -> ThemePreference.LIGHT
        "dark" -> ThemePreference.DARK
        else -> ThemePreference.SYSTEM
    }

    companion object {
        private const val PREFS_NAME = "lamasync_shell_preferences"
        private const val KEY_THEME = "theme"
        private const val KEY_DYNAMIC_COLOR = "dynamic_color"
        private const val KEY_PULL_TO_REFRESH = "pull_to_refresh"
        private const val KEY_OPEN_EXTERNAL_LINKS = "open_external_links"

        /** The values `theme.ts` accepts, for the documentation contract. */
        val THEME_KEYS: List<String> = ThemePreference.entries.map { it.name.lowercase() }
    }
}
