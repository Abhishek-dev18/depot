package com.depot.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import com.depot.app.MainActivity
import com.depot.app.R

/**
 * Keeps the process alive while this Depot is listening.
 *
 * The session itself lives in DepotSession; this service exists only so
 * Android does not reclaim the process the moment the user switches away.
 * Android requires a visible notification for that privilege, which is the
 * right trade here anyway: a device quietly serving your files should say
 * so in the shade.
 */
class DepotService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                DepotSession.stop()
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                val url = intent?.getStringExtra(EXTRA_SIGNAL_URL)
                startForeground(NOTIFICATION_ID, buildNotification())
                if (url != null) DepotSession.start(this, url)
            }
        }
        // Do not resurrect with a null intent: the signal URL would be gone
        // and restarting without it would just fail silently.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        DepotSession.stop()
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Depot listening",
                    // LOW: persistent and informational, not something to
                    // interrupt the user over.
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
        }

        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, DepotService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Depot is listening")
            .setContentText("Paired devices can reach this phone")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "depot.listening"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP = "com.depot.app.STOP"
        private const val EXTRA_SIGNAL_URL = "signalUrl"

        fun start(context: Context, signalUrl: String) {
            val intent = Intent(context, DepotService::class.java)
                .putExtra(EXTRA_SIGNAL_URL, signalUrl)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, DepotService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}
