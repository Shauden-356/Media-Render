package com.shauden356.imadia

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLException
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File

// yt-dlp and FFmpeg (bundled with their own Python by the youtubedl-android library), and the
// same format rules as the desktop app.
object Engine {
    @Volatile private var ready = false

    // Unpacks Python, yt-dlp and FFmpeg on first use (takes a little while the first time).
    fun init(context: Context) {
        if (ready) return
        synchronized(this) {
            if (ready) return
            YoutubeDL.getInstance().init(context.applicationContext)
            FFmpeg.getInstance().init(context.applicationContext)
            ready = true
        }
    }

    // Sites change often: keep yt-dlp current, at most once a day.
    fun updateIfDue(context: Context) {
        val prefs = context.getSharedPreferences("engine", Context.MODE_PRIVATE)
        val last = prefs.getLong("updated", 0)
        if (System.currentTimeMillis() - last < 24 * 3600_000L) return
        try {
            init(context)
            YoutubeDL.getInstance().updateYoutubeDL(context.applicationContext, YoutubeDL.UpdateChannel._STABLE)
            prefs.edit().putLong("updated", System.currentTimeMillis()).apply()
        } catch (_: Exception) {
            // Offline or GitHub unreachable: try again next time.
        }
    }

    data class Saved(val uri: Uri, val name: String, val size: Long, val mime: String)

    class Failure(message: String, val log: String) : Exception(message)

    fun download(context: Context, d: Download, onProgress: (Float, String) -> Unit): Saved {
        init(context)
        val dir = File(context.cacheDir, "jobs/${d.id}").apply { deleteRecursively(); mkdirs() }
        try {
            val request = YoutubeDLRequest(d.url).apply {
                addOption("--no-playlist")
                addOption("--no-mtime")
                addOption("--socket-timeout", "30")
                addOption("--retries", "5")
                addOption("--fragment-retries", "5")
                addOption("--concurrent-fragments", "4")
                addOption("-o", File(dir, "%(title).120B.%(ext)s").absolutePath)
                for ((key, value) in formatOptions(d.format, d.quality)) {
                    if (value == null) addOption(key) else addOption(key, value)
                }
                Cookies.copyFor(context, dir)?.let { addOption("--cookies", it.absolutePath) }
            }
            val output = StringBuilder()
            try {
                YoutubeDL.getInstance().execute(request, d.id) { progress, _, line ->
                    if (line.isNotBlank()) {
                        output.appendLine(line)
                        if (output.length > 20000) output.delete(0, output.length - 20000)
                    }
                    onProgress(progress, stageOf(line))
                }
            } catch (e: YoutubeDL.CanceledException) {
                throw e
            } catch (e: YoutubeDLException) {
                val raw = e.message.orEmpty()
                val last = raw.lines().lastOrNull { it.startsWith("ERROR:") }?.removePrefix("ERROR:")?.trim() ?: raw.lines().lastOrNull { it.isNotBlank() }.orEmpty()
                throw Failure(explain(last), (output.toString() + "\n" + raw).trim().takeLast(20000))
            }
            val file = dir.listFiles()
                ?.filter { it.isFile && !it.name.endsWith(".part") && !it.name.endsWith(".ytdl") && it.name != "cookies.txt" }
                ?.maxByOrNull { it.length() }
                ?: throw Failure("yt-dlp finished but produced no file.", output.toString())
            return saveToDownloads(context, file)
        } finally {
            dir.deleteRecursively()
        }
    }

    // MP4 prefers H.264 + AAC so it plays everywhere; MKV takes the best of any codec.
    private fun formatOptions(format: String, quality: Int?): List<Pair<String, String?>> {
        if (format == "mp3" || format == "m4a") {
            return listOf("-f" to "ba/b", "-x" to null, "--audio-format" to format, "--audio-quality" to "0")
        }
        val h = if (quality != null) "[height<=$quality]" else ""
        val selector = if (format == "mp4") {
            "bv*$h[vcodec^=avc1]+ba[acodec^=mp4a]/b$h[vcodec^=avc1][acodec^=mp4a]/bv*$h[vcodec^=avc1]+ba/bv*$h+ba/b$h/bv*+ba/b"
        } else {
            "bv*$h+ba/b$h/bv*+ba/b"
        }
        return listOf("-f" to selector, "--merge-output-format" to format, "--remux-video" to format)
    }

    private fun stageOf(line: String): String = when {
        line.startsWith("[Merger]") || line.contains("Remux", ignoreCase = true) -> "Merging video and audio"
        line.startsWith("[ExtractAudio]") -> "Converting to audio"
        line.startsWith("[download]") -> "Downloading"
        line.isBlank() -> ""
        else -> "Preparing"
    }

    // yt-dlp's common failures in plain words.
    private fun explain(msg: String): String {
        val rules = listOf(
            Regex("confirm you.re not a bot", RegexOption.IGNORE_CASE) to "YouTube wants a signed-in session. Add your cookies (key icon at the top), then try again.",
            Regex("confirm your age|age.restricted|inappropriate for some users", RegexOption.IGNORE_CASE) to "This video is age-restricted. Add your cookies (key icon at the top), then try again.",
            Regex("members.only|join this channel", RegexOption.IGNORE_CASE) to "This video is only for channel members.",
            Regex("private video", RegexOption.IGNORE_CASE) to "This video is private.",
            Regex("available in your country|geo.?restrict", RegexOption.IGNORE_CASE) to "This video is blocked in your country.",
            Regex("HTTP Error 429|too many requests", RegexOption.IGNORE_CASE) to "The site is limiting requests from your connection. Wait a few minutes and try again.",
            Regex("\\bDRM\\b") to "This video is DRM-protected, so it cannot be downloaded.",
            Regex("unsupported url", RegexOption.IGNORE_CASE) to "yt-dlp does not recognise this address.",
            Regex("requested format is not available", RegexOption.IGNORE_CASE) to "The chosen quality is not available for this video. Try \"Best\".",
            Regex("HTTP Error 404") to "That address doesn't exist (HTTP 404). Check the link.",
            Regex("HTTP Error 403") to "The site refused the download (HTTP 403). If it needs an account, add your cookies (key icon at the top).",
            Regex("failed to resolve|network is unreachable|no address associated|timed out|connection refused", RegexOption.IGNORE_CASE) to "Could not reach the site. Check your internet connection.",
        )
        return rules.firstOrNull { it.first.containsMatchIn(msg) }?.second ?: msg.ifBlank { "The download failed." }
    }

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "mp4", "m4v" -> "video/mp4"
        "mkv" -> "video/x-matroska"
        "webm" -> "video/webm"
        "mp3" -> "audio/mpeg"
        "m4a" -> "audio/mp4"
        "opus", "ogg" -> "audio/ogg"
        else -> "application/octet-stream"
    }

    // Into the public Downloads/Imadia folder (no storage permission needed on Android 10+).
    private fun saveToDownloads(context: Context, file: File): Saved {
        val name = file.name.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1F]"), "_").take(150)
        val mime = mimeOf(name)
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, "Download/Imadia")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw Failure("Could not save the file to Downloads.", "")
        try {
            resolver.openOutputStream(uri)!!.use { out -> file.inputStream().use { it.copyTo(out) } }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw Failure("Could not save the file to Downloads (${e.message}).", "")
        }
        return Saved(uri, name, file.length(), mime)
    }

    fun cancel(id: String) {
        try {
            YoutubeDL.getInstance().destroyProcessById(id)
        } catch (_: Exception) {
        }
    }
}
