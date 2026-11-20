package com.shauden356.imadia

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// Sign-in cookies (cookies.txt or a JSON export), kept in the app's private storage, which other
// apps can't read. yt-dlp sends each cookie only to the site it belongs to.
object Cookies {
    private const val MAX_TEXT = 10 * 1024 * 1024

    data class Status(val count: Int, val sites: List<String>)

    private fun file(context: Context) = File(context.filesDir, "cookies.txt")

    fun status(context: Context): Status? {
        val f = file(context)
        if (!f.exists()) return null
        return summarize(parseNetscape(f.readText()))
    }

    // Saves cookies from cookies.txt text or a JSON export. Throws with a readable message if none.
    fun save(context: Context, text: String): Status {
        if (text.length > MAX_TEXT) throw IllegalArgumentException("That cookie file is too large.")
        val trimmed = text.trim().removePrefix("\uFEFF")
        val lines = if (trimmed.startsWith("[") || trimmed.startsWith("{")) fromJson(trimmed) else parseNetscape(trimmed)
        if (lines.isEmpty()) throw IllegalArgumentException("No cookies were found. Use a cookies.txt file or a JSON export from a cookie extension.")
        val out = buildString {
            appendLine("# Netscape HTTP Cookie File")
            lines.forEach { appendLine(it.joinToString("\t")) }
        }
        file(context).writeText(out)
        return summarize(lines)
    }

    fun clear(context: Context) {
        file(context).delete()
    }

    // yt-dlp rewrites the cookie file it is given, so each download gets its own copy.
    fun copyFor(context: Context, dir: File): File? {
        val f = file(context)
        if (!f.exists()) return null
        return File(dir, "cookies.txt").also { f.copyTo(it, overwrite = true) }
    }

    // -> [domain, includeSubdomains, path, secure, expires, name, value]
    private fun parseNetscape(text: String): List<List<String>> = text.lines().mapNotNull { raw ->
        val line = if (raw.startsWith("#HttpOnly_")) raw.removePrefix("#HttpOnly_") else raw
        if (line.isBlank() || line.startsWith("#")) return@mapNotNull null
        val f = line.split("\t")
        if (f.size < 7) return@mapNotNull null
        val domain = f[0].trim().lowercase()
        if (!Regex("^\\.?[a-z0-9.-]+\\.[a-z0-9-]+$").matches(domain) || f[5].isEmpty() || f[5].any { it == ';' || it == '\n' || it == '\r' }) return@mapNotNull null
        listOf(domain, f[1], f[2].ifEmpty { "/" }, f[3], f[4].ifEmpty { "0" }, f[5], f.drop(6).joinToString("\t"))
    }

    private fun fromJson(text: String): List<List<String>> {
        val arr = try {
            if (text.startsWith("[")) JSONArray(text) else JSONObject(text).optJSONArray("cookies") ?: JSONArray()
        } catch (e: Exception) {
            throw IllegalArgumentException("That looks like JSON but could not be read.")
        }
        val out = mutableListOf<List<String>>()
        for (i in 0 until arr.length()) {
            val c = arr.optJSONObject(i) ?: continue
            val name = c.optString("name")
            var domain = c.optString("domain").trim().lowercase()
            if (name.isEmpty() || domain.isEmpty()) continue
            val sub = !c.optBoolean("hostOnly", false)
            domain = domain.removePrefix(".")
            val expires = c.optDouble("expirationDate", 0.0).toLong()
            val line = "${if (sub) "." else ""}$domain\t${if (sub) "TRUE" else "FALSE"}\t${c.optString("path", "/")}\t${if (c.optBoolean("secure")) "TRUE" else "FALSE"}\t$expires\t$name\t${c.optString("value")}"
            out += parseNetscape(line)
        }
        return out
    }

    private fun summarize(lines: List<List<String>>): Status {
        val sites = lines.groupingBy { it[0].removePrefix(".").split(".").takeLast(2).joinToString(".") }.eachCount()
            .entries.sortedByDescending { it.value }.take(6).map { it.key }
        return Status(lines.size, sites)
    }
}
