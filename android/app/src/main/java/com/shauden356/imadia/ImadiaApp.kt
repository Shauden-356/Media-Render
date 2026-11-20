package com.shauden356.imadia

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class ImadiaApp : Application() {
    override fun onCreate() {
        super.onCreate()
        DownloadService.createChannel(this)
        // Unpack yt-dlp and FFmpeg early (slow the first time), then keep yt-dlp current.
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                Engine.init(this@ImadiaApp)
                engineReady.value = true
                Engine.updateIfDue(this@ImadiaApp)
            } catch (e: Exception) {
                engineError.value = e.message ?: "Could not start the downloader."
            }
        }
    }

    companion object {
        val engineReady = MutableStateFlow(false)
        val engineError = MutableStateFlow<String?>(null)
    }
}
