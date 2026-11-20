package com.shauden356.imadia

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.yausername.youtubedl_android.YoutubeDL
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

// Runs downloads in the background with a notification, so they keep going when the user leaves
// the app. Two at a time; the rest wait their turn.
class DownloadService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val slots = Semaphore(2)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, notification("Starting…", -1f),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
        )
        val id = intent?.getStringExtra(EXTRA_ID)
        if (id != null && Downloads.get(id)?.status == Status.Queued) scope.launch { run(id) }
        else if (Downloads.active() == 0) stopSelf()
        return START_NOT_STICKY
    }

    private suspend fun run(id: String) = slots.withPermit {
        val d = Downloads.get(id) ?: return@withPermit
        if (d.status != Status.Queued) return@withPermit
        Downloads.update(id) { it.copy(status = Status.Running, stage = "Preparing") }
        refresh()
        try {
            val saved = Engine.download(this, d) { progress, stage ->
                Downloads.update(id) { it.copy(progress = progress, stage = stage.ifEmpty { it.stage }) }
                refresh()
            }
            Downloads.update(id) {
                it.copy(status = Status.Done, progress = 100f, fileUri = saved.uri.toString(), fileName = saved.name, mime = saved.mime, size = saved.size)
            }
        } catch (e: YoutubeDL.CanceledException) {
            Downloads.update(id) { it.copy(status = Status.Cancelled) }
        } catch (e: Engine.Failure) {
            val cancelled = Downloads.get(id)?.status == Status.Cancelled
            if (!cancelled) Downloads.update(id) { it.copy(status = Status.Failed, error = e.message, log = e.log) }
        } catch (e: Exception) {
            Downloads.update(id) { it.copy(status = Status.Failed, error = e.message ?: "The download failed.") }
        }
        refresh()
        if (Downloads.active() == 0) stopSelf()
    }

    // One notification for all downloads: the first running one's progress, and how many are left.
    private fun refresh() {
        val running = Downloads.items.value.filter { it.status == Status.Running || it.status == Status.Queued }
        val first = running.firstOrNull { it.status == Status.Running } ?: running.firstOrNull() ?: return
        val more = if (running.size > 1) " (+${running.size - 1} more)" else ""
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification("${first.label}$more", first.progress))
    }

    private fun notification(text: String, progress: Float): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Downloading")
            .setContentText(text)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setProgress(100, progress.coerceAtLeast(0f).toInt(), progress < 0)
            .build()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "downloads"
        private const val NOTIFICATION_ID = 1
        private const val EXTRA_ID = "id"

        fun createChannel(context: Context) {
            val channel = NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW)
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }

        fun start(context: Context, id: String) {
            context.startForegroundService(Intent(context, DownloadService::class.java).putExtra(EXTRA_ID, id))
        }
    }
}
