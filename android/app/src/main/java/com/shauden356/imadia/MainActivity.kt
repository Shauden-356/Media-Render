package com.shauden356.imadia

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID

class MainActivity : ComponentActivity() {
    private val sharedUrl = mutableStateOf("")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        takeShared(intent)
        setContent { ImadiaTheme { Screen(sharedUrl) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeShared(intent)
    }

    // A link shared from another app (YouTube, Chrome…): the first web address in the text.
    private fun takeShared(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
        Regex("https?://\\S+").find(text)?.let { sharedUrl.value = it.value }
    }
}

private val FORMATS = listOf("mp4" to "MP4 video", "mkv" to "MKV video (up to 4K)", "mp3" to "MP3 audio", "m4a" to "M4A audio")
private val QUALITIES = listOf<Pair<Int?, String>>(null to "Best", 2160 to "2160p", 1440 to "1440p", 1080 to "1080p", 720 to "720p", 480 to "480p", 360 to "360p")

private fun labelFor(url: String): String = try {
    val u = Uri.parse(url)
    val base = u.lastPathSegment?.substringBeforeLast('.').orEmpty()
    if (base.isNotEmpty() && base.length <= 80 && !Regex("^(index|master|playlist|manifest|watch|video|embed)$", RegexOption.IGNORE_CASE).matches(base)) base
    else u.host?.removePrefix("www.") ?: url
} catch (_: Exception) {
    url
}

private fun formatSize(b: Long) = if (b > 1048576) "%.1f MB".format(b / 1048576.0) else "${maxOf(1, b / 1024)} KB"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Screen(sharedUrl: MutableState<String>) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("options", Context.MODE_PRIVATE) }
    var url by sharedUrl
    var format by remember { mutableStateOf(prefs.getString("format", "mp4")!!) }
    var quality by remember { mutableStateOf(prefs.getInt("quality", 0).takeIf { it > 0 }) }
    var message by remember { mutableStateOf<String?>(null) }
    var showCookies by remember { mutableStateOf(false) }
    var cookieStatus by remember { mutableStateOf(Cookies.status(context)) }
    var update by remember { mutableStateOf<String?>(null) }
    val ready by ImadiaApp.engineReady.collectAsStateWithLifecycle()
    val engineError by ImadiaApp.engineError.collectAsStateWithLifecycle()
    val items by Downloads.items.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) {
        update = withContext(Dispatchers.IO) { Updates.newerVersion(BuildConfig.VERSION_NAME) }
    }
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}

    fun start(target: String) {
        val clean = target.trim()
        if (!Regex("^https?://\\S+$", RegexOption.IGNORE_CASE).matches(clean)) {
            message = "Paste a web address that starts with http:// or https://."
            return
        }
        message = null
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        val d = Download(UUID.randomUUID().toString(), clean, format, if (format == "mp3" || format == "m4a") null else quality, labelFor(clean))
        Downloads.add(d)
        DownloadService.start(context, d.id)
        url = ""
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Image(painterResource(R.mipmap.ic_launcher), null, Modifier.size(28.dp).clip(RoundedCornerShape(7.dp)))
                        Spacer(Modifier.width(10.dp))
                        Text("Imadia", fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
                    }
                },
                actions = {
                    IconButton(onClick = { showCookies = true }) {
                        Icon(Icons.Outlined.Key, "Sign-in cookies", tint = if (cookieStatus != null) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            update?.let { v ->
                item {
                    Notice("Imadia $v is available.", "Download") {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Updates.SITE)))
                    }
                }
            }
            if (!ready) {
                item {
                    Column(Modifier.fillMaxWidth()) {
                        Text(engineError ?: "Getting the downloader ready (only slow the first time)…", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                        if (engineError == null) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 6.dp))
                    }
                }
            }
            item {
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("Paste a video or page address") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    trailingIcon = {
                        IconButton(onClick = {
                            val clip = context.getSystemService(ClipboardManager::class.java).primaryClip
                            clip?.getItemAt(0)?.coerceToText(context)?.toString()?.let { url = it.trim() }
                        }) { Icon(Icons.Outlined.ContentPaste, "Paste") }
                    },
                )
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Picker("Format", FORMATS.first { it.first == format }.second, FORMATS.map { it.second }, Modifier.weight(1.4f)) { i ->
                        format = FORMATS[i].first
                        prefs.edit().putString("format", format).apply()
                    }
                    Picker("Quality", QUALITIES.first { it.first == quality }.second, QUALITIES.map { it.second }, Modifier.weight(1f), enabled = format != "mp3" && format != "m4a") { i ->
                        quality = QUALITIES[i].first
                        prefs.edit().putInt("quality", quality ?: 0).apply()
                    }
                }
            }
            item {
                Button(onClick = { start(url) }, enabled = ready && url.isNotBlank(), modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(10.dp)) {
                    Text("Download", fontWeight = FontWeight.SemiBold)
                }
                message?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp)) }
            }
            if (items.isEmpty()) {
                item {
                    Text(
                        "Paste a link, or share one to Imadia from YouTube, your browser or another app. Videos are saved in Downloads › Imadia.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp,
                        modifier = Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp)).padding(14.dp),
                    )
                }
            } else {
                item { Text("DOWNLOADS", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant, letterSpacing = 0.5.sp) }
                items(items, key = { it.id }) { d -> DownloadRow(d, onRetry = { Downloads.remove(d.id); start(d.url) }) }
            }
        }
    }

    if (showCookies) {
        CookieSheet(cookieStatus, onClose = { showCookies = false }, onChange = { cookieStatus = it })
    }
}

@Composable
private fun Notice(text: String, action: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.secondaryContainer).padding(start = 14.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, Modifier.weight(1f), fontSize = 14.sp)
        TextButton(onClick = onClick) { Text(action) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Picker(label: String, value: String, options: List<String>, modifier: Modifier, enabled: Boolean = true, onPick: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { if (enabled) open = it }, modifier = modifier) {
        OutlinedTextField(
            value = value, onValueChange = {}, readOnly = true, enabled = enabled, singleLine = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(open) },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEachIndexed { i, o -> DropdownMenuItem(text = { Text(o) }, onClick = { onPick(i); open = false }) }
        }
    }
}

// [format badge] [name / status] with the actions underneath.
@Composable
private fun DownloadRow(d: Download, onRetry: () -> Unit) {
    val context = LocalContext.current
    var showLog by remember { mutableStateOf(false) }
    val failed = d.status == Status.Failed
    Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp)).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    (d.fileName?.substringAfterLast('.') ?: d.format).uppercase().take(4),
                    fontFamily = FontFamily.Monospace, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                    color = when (d.status) {
                        Status.Done -> MaterialTheme.colorScheme.tertiary
                        Status.Failed -> MaterialTheme.colorScheme.error
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(d.fileName ?: d.label, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val meta = when (d.status) {
                    Status.Queued -> "Waiting"
                    Status.Running -> d.stage + if (d.progress >= 0) " · ${d.progress.toInt()}%" else "…"
                    Status.Done -> formatSize(d.size) + " · Downloads › Imadia"
                    Status.Failed -> d.error ?: "The download failed."
                    Status.Cancelled -> "Cancelled"
                }
                Text(meta, fontSize = 13.sp, color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (d.status == Status.Running || d.status == Status.Queued) {
            if (d.progress >= 0) LinearProgressIndicator(progress = { d.progress / 100f }, modifier = Modifier.fillMaxWidth().padding(top = 10.dp))
            else LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 10.dp))
        }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.End) {
            when (d.status) {
                Status.Queued, Status.Running -> TextButton(onClick = {
                    Downloads.update(d.id) { it.copy(status = Status.Cancelled) }
                    Engine.cancel(d.id)
                }) { Text("Cancel") }
                Status.Done -> {
                    TextButton(onClick = {
                        val open = Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(d.fileUri), d.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        try { context.startActivity(open) } catch (_: Exception) { }
                    }) { Text("Open") }
                    TextButton(onClick = {
                        val share = Intent(Intent.ACTION_SEND).setType(d.mime).putExtra(Intent.EXTRA_STREAM, Uri.parse(d.fileUri)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        context.startActivity(Intent.createChooser(share, null))
                    }) { Text("Share") }
                }
                Status.Failed, Status.Cancelled -> {
                    if (failed && !d.log.isNullOrBlank()) TextButton(onClick = { showLog = !showLog }) { Text(if (showLog) "Hide details" else "Details") }
                    TextButton(onClick = onRetry) { Text("Retry") }
                    TextButton(onClick = { Downloads.remove(d.id) }) { Text("Remove") }
                }
            }
        }
        if (showLog && d.log != null) {
            Text(
                d.log, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().heightIn(max = 220.dp).clip(RoundedCornerShape(6.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant).verticalScroll(rememberScrollState()).padding(8.dp),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CookieSheet(status: Cookies.Status?, onClose: () -> Unit, onChange: (Cookies.Status?) -> Unit) {
    val context = LocalContext.current
    var pasted by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    fun save(text: String) {
        try {
            onChange(Cookies.save(context, text))
            pasted = ""
            error = null
        } catch (e: Exception) {
            error = e.message
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            try {
                val text = context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                if (text.size > 10 * 1024 * 1024) error = "That file is too large to be a cookie file." else save(String(text))
            } catch (e: Exception) {
                error = "Could not read that file."
            }
        }
    }
    ModalBottomSheet(onDismissRequest = onClose) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Sign-in cookies", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            Text(
                "Download as your logged-in self: for YouTube's \"confirm you're not a bot\", members-only or age-restricted videos, and sites that need an account. Cookies stay in Imadia's private storage, and each one is only sent to the site it belongs to.",
                fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                if (status == null) "Not using cookies." else "Using ${status.count} cookies for ${status.sites.joinToString(", ")}.",
                Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant).padding(12.dp),
            )
            OutlinedButton(onClick = { pick.launch(arrayOf("text/plain", "application/json", "application/octet-stream")) }, modifier = Modifier.fillMaxWidth()) {
                Text("Import a cookies.txt or JSON file")
            }
            OutlinedTextField(
                value = pasted, onValueChange = { pasted = it }, modifier = Modifier.fillMaxWidth().heightIn(min = 100.dp),
                placeholder = { Text("…or paste cookies.txt text or a JSON export") },
                textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (status != null) OutlinedButton(onClick = { Cookies.clear(context); onChange(null) }) { Text("Remove cookies") }
                Spacer(Modifier.weight(1f))
                Button(onClick = { save(pasted) }, enabled = pasted.isNotBlank()) { Text("Save") }
            }
            Text(
                "Export cookies on a computer with an extension such as \"Get cookies.txt LOCALLY\", then send the file to your phone. Anyone with that file can sign in as you: keep it private.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
