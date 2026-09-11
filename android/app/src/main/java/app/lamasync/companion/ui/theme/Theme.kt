package app.lamasync.companion.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import app.lamasync.companion.data.ShellPreferences
import app.lamasync.companion.data.ThemePreference

/**
 * LAMA-329 — the LamaSync Material 3 theme.
 *
 * Two schemes are derived from [LamaSyncPalette], which mirrors the web UI's
 * design tokens; see that file for the surface-level contract and the source
 * of truth. The shell must not merely *resemble* the embedded SPA — it wraps
 * it, so the two are the same palette or the product visibly changes identity
 * at the WebView boundary.
 */
private fun lamaSyncDarkScheme(): ColorScheme = with(LamaSyncPalette.Dark) {
    darkColorScheme(
        primary = primary,
        onPrimary = textOnAccent,
        primaryContainer = primaryContainer,
        onPrimaryContainer = onPrimaryContainer,
        inversePrimary = LamaSyncPalette.Light.primary,

        secondary = info,
        onSecondary = onSecondary,
        secondaryContainer = secondaryContainer,
        onSecondaryContainer = onSecondaryContainer,

        tertiary = storage,
        onTertiary = onTertiary,
        tertiaryContainer = tertiaryContainer,
        onTertiaryContainer = onTertiaryContainer,

        background = canvas,
        onBackground = text,
        surface = panel,
        onSurface = text,
        surfaceVariant = inset,
        onSurfaceVariant = textDim,
        surfaceTint = primary,

        // The four-level hierarchy. `canvas` and `panel` are repeated across
        // the low container slots because the web contract has four surfaces,
        // not five: nothing in this app sits at an unnamed fifth level.
        surfaceBright = raised,
        surfaceDim = canvas,
        surfaceContainerLowest = canvas,
        surfaceContainerLow = panel,
        surfaceContainer = panel,
        surfaceContainerHigh = raised,
        surfaceContainerHighest = raised,

        inverseSurface = textStrong,
        inverseOnSurface = panel,

        error = colorError,
        onError = onError,
        errorContainer = errorContainer,
        onErrorContainer = onErrorContainer,

        outline = borderStrong,
        outlineVariant = border,
        scrim = backdrop,
    )
}

private fun lamaSyncLightScheme(): ColorScheme = with(LamaSyncPalette.Light) {
    lightColorScheme(
        primary = primary,
        onPrimary = textOnAccent,
        primaryContainer = primaryContainer,
        onPrimaryContainer = onPrimaryContainer,
        inversePrimary = LamaSyncPalette.Dark.primary,

        secondary = info,
        onSecondary = onSecondary,
        secondaryContainer = secondaryContainer,
        onSecondaryContainer = onSecondaryContainer,

        tertiary = storage,
        onTertiary = onTertiary,
        tertiaryContainer = tertiaryContainer,
        onTertiaryContainer = onTertiaryContainer,

        background = canvas,
        onBackground = text,
        surface = panel,
        onSurface = text,
        surfaceVariant = inset,
        onSurfaceVariant = textDim,
        surfaceTint = primary,

        surfaceBright = panel,
        surfaceDim = canvas,
        surfaceContainerLowest = panel,
        surfaceContainerLow = panel,
        surfaceContainer = panel,
        surfaceContainerHigh = raised,
        surfaceContainerHighest = raised,

        inverseSurface = textStrong,
        inverseOnSurface = panel,

        error = colorError,
        onError = onError,
        errorContainer = errorContainer,
        onErrorContainer = onErrorContainer,

        outline = borderStrong,
        outlineVariant = border,
        scrim = backdrop,
    )
}

/**
 * Resolves [preferences] plus the system setting into a concrete scheme.
 *
 * Dynamic colour is honoured only when the user opted in AND the platform
 * offers it (Android 12+); otherwise the LamaSync palette is used, which keeps
 * the default install brand-consistent with the embedded web UI.
 */
@Composable
private fun colorSchemeFor(preferences: ShellPreferences): ColorScheme {
    val dark = when (preferences.theme) {
        ThemePreference.SYSTEM -> isSystemInDarkTheme()
        ThemePreference.LIGHT -> false
        ThemePreference.DARK -> true
    }
    if (preferences.dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val context = LocalContext.current
        return if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    }
    return if (dark) lamaSyncDarkScheme() else lamaSyncLightScheme()
}

@Composable
fun LamaSyncTheme(
    preferences: ShellPreferences = ShellPreferences(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = colorSchemeFor(preferences),
        content = content,
    )
}

/**
 * True when the resolved scheme is the dark one. Used by the shell for the
 * system-bar icon appearance and by the WebView host to pick the theme-specific
 * masthead mark, so both stay in step with the Compose scheme rather than with
 * `isSystemInDarkTheme()` alone (the user may have overridden the system).
 */
@Composable
internal fun isLamaSyncDark(preferences: ShellPreferences): Boolean =
    when (preferences.theme) {
        ThemePreference.SYSTEM -> isSystemInDarkTheme()
        ThemePreference.LIGHT -> false
        ThemePreference.DARK -> true
    }
