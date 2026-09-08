package app.lamasync.companion.data

import android.content.Context

/** Persisted upload policy (stage 1: network preference only). */
class UploadPolicyStore(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(): UploadPolicy = UploadPolicy(
        unmeteredOnly = prefs.getBoolean(KEY_UNMETERED, false),
    )

    fun save(policy: UploadPolicy) {
        prefs.edit().putBoolean(KEY_UNMETERED, policy.unmeteredOnly).apply()
    }

    companion object {
        private const val PREFS_NAME = "lamasync_upload_policy"
        private const val KEY_UNMETERED = "unmetered_only"
    }
}