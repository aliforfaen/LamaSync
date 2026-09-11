package app.lamasync.companion.data

import android.content.Context

/** Persisted upload policy (network + charging preferences). */
class UploadPolicyStore(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(): UploadPolicy = UploadPolicy(
        unmeteredOnly = prefs.getBoolean(KEY_UNMETERED, false),
        chargingOnly = prefs.getBoolean(KEY_CHARGING, false),
    )

    fun save(policy: UploadPolicy) {
        prefs.edit()
            .putBoolean(KEY_UNMETERED, policy.unmeteredOnly)
            .putBoolean(KEY_CHARGING, policy.chargingOnly)
            .apply()
    }

    companion object {
        private const val PREFS_NAME = "lamasync_upload_policy"
        private const val KEY_UNMETERED = "unmetered_only"
        private const val KEY_CHARGING = "charging_only"
    }
}