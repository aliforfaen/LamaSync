package app.lamasync.companion.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import app.lamasync.companion.data.ShellPreferences
import app.lamasync.companion.data.ShellPreferencesStore
import app.lamasync.companion.data.ThemePreference
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * LAMA-329 — device-local shell preferences, held once for the whole activity.
 *
 * [ShellPreferencesStore] remains the single persisted source of truth: the
 * Settings screen writes through this ViewModel rather than keeping its own
 * copy, and the shell reads the same flow, so a change in Settings takes
 * effect immediately without a second, parallel preference.
 */
class ShellPreferencesViewModel(application: Application) : AndroidViewModel(application) {

    private val store = ShellPreferencesStore(application)

    private val _preferences = MutableStateFlow(store.load())
    val preferences: StateFlow<ShellPreferences> = _preferences.asStateFlow()

    /** Re-reads persisted state; called from the activity (mirrors the other ViewModels). */
    fun initialize() {
        _preferences.value = store.load()
    }

    fun setTheme(theme: ThemePreference) = update { it.copy(theme = theme) }

    fun setDynamicColor(enabled: Boolean) = update { it.copy(dynamicColor = enabled) }

    fun setPullToRefresh(enabled: Boolean) = update { it.copy(pullToRefresh = enabled) }

    fun setOpenExternalLinks(enabled: Boolean) = update { it.copy(openExternalLinks = enabled) }

    private fun update(transform: (ShellPreferences) -> ShellPreferences) {
        val next = transform(_preferences.value)
        store.save(next)
        _preferences.value = next
    }
}
