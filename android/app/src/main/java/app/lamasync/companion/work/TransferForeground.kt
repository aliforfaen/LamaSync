package app.lamasync.companion.work

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.ForegroundInfo
import app.lamasync.companion.R
import app.lamasync.companion.ui.MainActivity

/**
 * LAMA-296 stage 2 — foreground promotion for long transfers.
 *
 * Official guidance (Android 15/SDK 35, data-transfer options): WorkManager
 * work that runs longer than ~10 minutes is rescheduled by the system; a
 * transfer worker should promote to a FOREGROUND SERVICE worker so the OS
 * keeps the process alive for the transfer's duration. This helper:
 *
 *  - creates the notification channel once;
 *  - on API 33+ shows the foreground notification ONLY when
 *    POST_NOTIFICATIONS is granted (no permission → degrade gracefully: the
 *    durable per-chunk offsets mean a rescheduled worker simply resumes);
 *  - returns null when foreground is not possible right now (permission
 *    missing, background-start restrictions, release exceptions) and the
 *    caller continues as a plain worker.
 *
 * The app NEVER claims unrestricted background execution: without the
 * notification permission, or when the platform refuses background FGS
 * starts, transfers still progress chunk-by-chunk, resumably, on every
 * constrained worker pass.
 */
object TransferForeground {

    const val CHANNEL_ID = "lamasync-transfers"
    const val NOTIFICATION_ID = 41

    /** True when the platform would accept a foreground notification. */
    fun canShowForeground(context: Context, sdkInt: Int = Build.VERSION.SDK_INT): Boolean {
        if (sdkInt >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        }
        return true
    }

    /**
     * Build the ForegroundInfo, or null when foreground is not possible.
     * [activeText] is shown on the persistent notification (e.g. "Uploading
     * IMG_0001.jpg — 45%"). Safe to call from any thread; never throws.
     */
    fun foregroundInfo(
        context: Context,
        activeText: String,
        indeterminate: Boolean = false,
        progress: Int = 0,
    ): ForegroundInfo? {
        return try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
            if (!canShowForeground(context)) return null
            ensureChannel(context)
            val openIntent = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setContentTitle("Protecting your media")
                .setContentText(activeText)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(openIntent)
                .setProgress(100, progress, indeterminate)
                .build()
            ForegroundInfo(NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            null
        }
    }

    /** Present an updated foreground notification for the same worker. */
    fun updateForeground(context: Context, activeText: String, progress: Int) {
        try {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            ensureChannel(context)
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setContentTitle("Protecting your media")
                .setContentText(activeText)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setProgress(100, progress, false)
                .build()
            manager.notify(NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            // Best effort.
        }
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Media transfers",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Progress of automatic media protection uploads"
                    setShowBadge(false)
                },
            )
        }
    }
}