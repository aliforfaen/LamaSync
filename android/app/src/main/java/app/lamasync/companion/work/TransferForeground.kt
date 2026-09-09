package app.lamasync.companion.work

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import app.lamasync.companion.R
import app.lamasync.companion.ui.MainActivity

/**
 * LAMA-296 stage 2 — foreground promotion for long transfers.
 *
 * Official guidance (Android 15/SDK 35, long-running worker contract):
 * WorkManager work that runs longer than ~10 minutes is rescheduled by the
 * system; a transfer worker promotes to a FOREGROUND SERVICE worker with the
 * `dataSync` type so the OS keeps the process alive for the transfer.
 *
 * P1 premise correction: POST_NOTIFICATIONS being DENIED does NOT prevent a
 * foreground service from being started. Android still runs the service and
 * surfaces it (Task Manager / running-services UI) even when the
 * notification is absent from the drawer, so a denied notification
 * permission must never degrade long transfers to ordinary WorkManager.
 * Only pre-Q platforms lack the foreground-service worker API.
 *
 * This helper creates the notification channel once, builds the typed
 * ForegroundInfo, and returns null when the platform genuinely cannot host
 * it. When the OS refuses a background FGS start, the worker degrades
 * gracefully (durable per-chunk offsets keep progress) and reports the
 * degraded state through its progress data — it never claims an unrestricted
 * background guarantee it does not have.
 */
object TransferForeground {

    const val CHANNEL_ID = "lamasync-transfers"
    const val NOTIFICATION_ID = 41

    /**
     * Pure long-run decision — fully JVM-testable. True whenever the
     * platform supports foreground-service workers (API 26+); notification
     * permission is deliberately NOT a precondition (P1).
     */
    fun foregroundAllowed(sdkInt: Int): Boolean =
        sdkInt >= Build.VERSION_CODES.O

    /** True when the platform would accept a foreground service worker. */
    fun canShowForeground(context: Context, sdkInt: Int = Build.VERSION.SDK_INT): Boolean =
        foregroundAllowed(sdkInt)

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
            // Long-running worker contract: declare the dataSync service type
            // (required on API 34+; manifest declares the same type).
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ForegroundInfo(
                    NOTIFICATION_ID,
                    notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            } else {
                ForegroundInfo(NOTIFICATION_ID, notification)
            }
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