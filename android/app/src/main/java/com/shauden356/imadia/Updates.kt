package com.shauden356.imadia

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

// Checks GitHub for a newer release (the app is installed from the website, not an app store).
object Updates {
    // The repo is being renamed from Media-Render to Imadia: try the new name first.
    private val repos = listOf("Shauden-356/Imadia", "Shauden-356/Media-Render")
    const val SITE = "https://imadia.vercel.app/"

    // -> the newer version number, or null.
    fun newerVersion(current: String): String? {
        for (repo in repos) {
            val conn = (URL("https://api.github.com/repos/$repo/releases/latest").openConnection() as HttpURLConnection).apply {
                connectTimeout = 10000
                readTimeout = 10000
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", "Imadia-Android")
            }
            try {
                if (conn.responseCode == 404) continue
                if (conn.responseCode != 200) return null
                val rel = JSONObject(conn.inputStream.bufferedReader().readText())
                val version = rel.optString("tag_name").removePrefix("v")
                val assets = rel.optJSONArray("assets")
                val hasApk = (0 until (assets?.length() ?: 0)).any { assets!!.getJSONObject(it).optString("name").startsWith("Imadia-android") }
                return if (hasApk && newer(version, current)) version else null
            } catch (_: Exception) {
                return null
            } finally {
                conn.disconnect()
            }
        }
        return null
    }

    private fun newer(a: String, b: String): Boolean {
        val x = a.split(".").map { it.toIntOrNull() ?: 0 }
        val y = b.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until 3) if (x.getOrElse(i) { 0 } != y.getOrElse(i) { 0 }) return x.getOrElse(i) { 0 } > y.getOrElse(i) { 0 }
        return false
    }
}
