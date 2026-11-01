// Background download jobs. A job turns a page address, an .m3u8 playlist or a direct
// video file into one MP4/MKV file on disk. The browser polls /api/jobs/:id for progress
// and downloads the finished file, so no HTTP request has to stay open for an hour.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { cfg } from './config.js';
import { asHeaders, safeFetch } from './net.js';
import { resolveStream } from './hls.js';
import { feedSegments } from './feed.js';
import { requestFor, scanPage } from './scanner.js';
import { kindOf } from './extract.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const jobs = new Map();
const queue = [];
let running = 0;

class Cancelled extends Error {}
const check = (job) => {
  if (job.cancelled) throw new Cancelled('cancelled');
};
const note = (job, msg) => {
  if (job.notes.length < 30) job.notes.push(msg);
};
// Why each method failed, shown separately from the main message (with the tool's own output).
const logFailure = (job, method, error, output = '') => {
  if (job.log.length < 30) job.log.push({ method, error, output });
};
// Sites where yt-dlp is the right tool from the start (a browser scan finds nothing usable there).
const YTDLP_SITES = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|x\.com|twitter\.com|instagram\.com|facebook\.com|reddit\.com|soundcloud\.com|bilibili\.com)$/i;
const isYtdlpSite = (u) => {
  try {
    return YTDLP_SITES.test(new URL(u).hostname);
  } catch {
    return false;
  }
};
const isHls = (u) => /\.m3u8(?:$|[?#&])/i.test(u);
const isDirect = (u) => ['video', 'audio'].includes(kindOf(u, null));
const safeName = (s) =>
  String(s || '')
    .replace(/[^\p{L}\p{N}\-_. ]+/gu, '_')
    .trim()
    .slice(0, 80) || 'video';

export async function initJobs() {
  await fsp.rm(cfg.jobsDir, { recursive: true, force: true });
  await fsp.mkdir(cfg.jobsDir, { recursive: true });
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > cfg.fileTtlMs) {
      jobs.delete(id);
      await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}, 60_000).unref();

export function createJob(opts) {
  if (jobs.size >= cfg.maxJobs) throw new Error('Too many downloads at once. Try again when some have finished.');
  const id = crypto.randomBytes(12).toString('hex');
  const job = {
    id,
    opts: { ...opts, name: safeName(opts.name) },
    status: 'queued',
    stage: 'Waiting in line…',
    percent: null,
    notes: [],
    log: [],
    usedMethod: null,
    file: null,
    filename: null,
    size: 0,
    error: null,
    cancelled: false,
    cancelReason: null,
    finishedAt: null,
    abort: new AbortController(),
    procs: new Set(),
    dir: path.join(cfg.jobsDir, id),
  };
  jobs.set(id, job);
  queue.push(job);
  pump();
  return job;
}

export const getJob = (id) => jobs.get(id);

export const publicJob = (j) => ({
  id: j.id,
  status: j.status,
  stage: j.stage,
  percent: j.percent,
  error: j.error,
  filename: j.filename,
  size: j.size,
  method: j.usedMethod,
  notes: j.notes,
  log: j.log,
});

export function cancelJob(job, reason = null) {
  if (job.finishedAt || job.cancelled) return;
  job.cancelled = true;
  job.cancelReason = reason;
  job.abort.abort();
  for (const p of job.procs) p.kill('SIGKILL');
  if (job.status === 'queued') {
    job.status = reason ? 'error' : 'cancelled';
    job.error = reason;
    job.stage = reason ? 'Stopped' : 'Cancelled';
    job.finishedAt = Date.now();
  }
}

// Called when the app quits: stops FFmpeg / yt-dlp and removes temporary files.
export function shutdownJobs() {
  for (const job of jobs.values()) cancelJob(job);
  try {
    fs.rmSync(cfg.jobsDir, { recursive: true, force: true });
  } catch {
    /* a file still in use on Windows; initJobs clears it next start */
  }
}

function pump() {
  while (running < cfg.concurrent && queue.length) {
    const job = queue.shift();
    if (job.status !== 'queued') continue;
    running++;
    run(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function run(job) {
  job.status = 'running';
  job.stage = 'Starting…';
  const timer = setTimeout(
    () => cancelJob(job, 'The download took longer than the time limit.'),
    cfg.jobTimeMs + 10_000
  );
  try {
    await fsp.mkdir(job.dir, { recursive: true });
    let file = await orchestrate(job);
    check(job);
    file = await finish(job, file);
    check(job);
    const st = await fsp.stat(file);
    if (!st.size) throw new Error('The result file was empty.');
    const ext = path.extname(file).slice(1) || job.opts.format;
    job.file = file;
    job.size = st.size;
    job.filename = `${job.opts.name}.${ext}`;
    job.status = 'done';
    job.stage = 'Ready';
    job.percent = 100;
  } catch (err) {
    if (job.cancelled) {
      job.status = job.cancelReason ? 'error' : 'cancelled';
      job.error = job.cancelReason;
      job.stage = job.cancelReason ? 'Stopped' : 'Cancelled';
    } else {
      job.status = 'error';
      job.error = err?.message || 'Download failed.';
      job.stage = 'Failed';
    }
    await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  } finally {
    clearTimeout(timer);
    job.finishedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Strategy: try the most reliable method first, then fall back.
//   .m3u8 address : HLS + FFmpeg  ->  yt-dlp
//   video file    : direct file   ->  yt-dlp
//   YouTube etc.  : yt-dlp
//   web page      : Playwright finds the stream/file -> HLS/direct (or yt-dlp for
//                   encrypted playlists)  ->  yt-dlp on the page itself
// ---------------------------------------------------------------------------
async function orchestrate(job) {
  const { url, page, method } = job.opts;
  const runners = {
    hls: ['HLS + FFmpeg', runHls],
    direct: ['Direct file', runDirect],
    ytdlp: ['yt-dlp', runYtdlp],
    ffmpeg: ['FFmpeg only', runFfmpegUrl],
  };

  const attempt = async (key, u, ref) => {
    check(job);
    const [label, fn] = runners[key];
    job.stage = `${label}…`;
    job.percent = null;
    try {
      const file = await fn(job, u, ref);
      job.usedMethod = label;
      return file;
    } catch (err) {
      if (err instanceof Cancelled || job.cancelled) throw new Cancelled('cancelled');
      job.lastError = err?.message || 'failed';
      logFailure(job, label, job.lastError, err?.output);
      await clearOutputs(job);
      return null;
    }
  };

  if (method !== 'auto') {
    const file = await attempt(method, url, page);
    if (!file) throw new Error(job.lastError || 'Download failed.');
    return file;
  }

  let referer = page;
  // Same Referer/Origin/cookies the browser used for this address, when a scan saw it load.
  const refFor = (u, fallback) => requestFor(u) || fallback;
  if (isYtdlpSite(url)) {
    const f = await attempt('ytdlp', url, referer);
    if (f) return f;
    throw new Error(job.lastError);
  }
  if (isHls(url)) {
    const f = await attempt('hls', url, refFor(url, referer));
    if (f) return f;
  } else if (isDirect(url)) {
    const f = await attempt('direct', url, refFor(url, referer));
    if (f) return f;
  } else {
    job.stage = 'Opening the page in a browser…';
    let found = null;
    try {
      found = await scanPage(url, Date.now() + cfg.scanBudgetMs);
    } catch (err) {
      logFailure(job, 'Page scan', err.message);
    }
    check(job);
    if (found) {
      referer = found.page;
      for (const c of await rankCandidates(job, found, referer)) {
        const f = await attempt(c.key, c.url, refFor(c.url, referer));
        if (f) return f;
      }
    }
  }

  const f = await attempt('ytdlp', url, referer);
  if (f) return f;
  throw new Error('No method could download this video.');
}

// Playlists first (longest one wins, which skips ads and trailers), then plain video files.
async function rankCandidates(job, found, referer) {
  const out = [];
  job.stage = 'Checking the streams found on the page…';
  for (const s of found.streams.slice(0, 6)) {
    check(job);
    try {
      const st = await resolveStream(s.url, requestFor(s.url) || referer, job.opts.maxHeight);
      const secs = st.video.durations.reduce((a, b) => a + b, 0);
      out.push({ key: 'hls', url: s.url, secs });
    } catch (err) {
      if (/encrypted/i.test(err.message)) out.push({ key: 'ytdlp', url: s.url, secs: 0 });
      else logFailure(job, `Playlist ${s.name} (${s.played ? 'loaded by the player' : 'only found in the page'})`, err.message);
    }
  }
  out.sort((a, b) => b.secs - a.secs);
  const files = found.items.filter((i) => i.kind === 'video').slice(0, 3);
  return [...out.slice(0, 3), ...files.map((i) => ({ key: 'direct', url: i.url }))];
}

async function clearOutputs(job) {
  for (const f of await fsp.readdir(job.dir).catch(() => [])) {
    await fsp.rm(path.join(job.dir, f), { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------
function track(job, bin, args, opts) {
  const p = spawn(bin, args, opts);
  job.procs.add(p);
  p.on('close', () => job.procs.delete(p));
  return p;
}

function watchFfmpegProgress(stream, job, total) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line); // FFmpeg reports microseconds in both
      if (m && total > 0) job.percent = Math.min(99, Math.round((Number(m[1]) / 1e6 / total) * 100));
    }
  });
}

const FF_BASE = ['-hide_banner', '-loglevel', 'error', '-y', '-nostdin'];
const FF_TAIL = ['-progress', 'pipe:1', '-nostats'];
const fastStart = (container) => (container === 'mp4' ? ['-movflags', '+faststart'] : []);

// Runs FFmpeg to completion: ffmpeg <base> <args> <progress flags> <out>
function runFfmpeg(job, args, out, total = 0) {
  return new Promise((resolve, reject) => {
    const ff = track(job, cfg.ffmpeg, [...FF_BASE, ...args, ...FF_TAIL, out], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    ff.stderr.on('data', (d) => (err = (err + d).slice(-800)));
    watchFfmpegProgress(ff.stdout, job, total);
    ff.on('error', (e) => reject(e));
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `FFmpeg exited with code ${code}.`))
    );
  });
}

// ---------------------------------------------------------------------------
// Method 1: HLS (.m3u8). Segments are downloaded by Node (SSRF-safe, Referer aware)
// and piped into FFmpeg, which remuxes them without re-encoding.
// ---------------------------------------------------------------------------
async function runHls(job, url, referer) {
  const { container } = job.opts;
  const stream = await resolveStream(url, referer, job.opts.maxHeight); // throws for encrypted streams
  const total = stream.video.durations.reduce((a, b) => a + b, 0);
  if (!stream.video.endlist) note(job, 'This looks like a live stream; only what is available now is saved.');

  const out = path.join(job.dir, `out.${container}`);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y', // no -nostdin: the input IS stdin
    '-i', 'pipe:0',
    ...(stream.audio ? ['-i', 'pipe:3'] : []),
    '-map', '0:v:0?',
    '-map', stream.audio ? '1:a:0?' : '0:a:0?',
    '-sn', '-dn',
    '-c', 'copy',
    ...(stream.aac ? ['-bsf:a', 'aac_adtstoasc'] : []),
    ...fastStart(container),
    ...FF_TAIL,
    out,
  ];
  const ff = track(job, cfg.ffmpeg, args, {
    stdio: ['pipe', 'pipe', 'pipe', ...(stream.audio ? ['pipe'] : [])],
  });
  let errText = '';
  ff.on('error', (e) => (errText = e.message));
  ff.stderr.on('data', (d) => (errText = (errText + d).slice(-800)));
  watchFfmpegProgress(ff.stdout, job, total);
  const closed = new Promise((resolve) => ff.on('close', resolve));

  const ctx = { job, bytes: 0, skipped: 0, truncated: false, stopped: false, deadline: Date.now() + cfg.jobTimeMs };
  job.stage = 'Downloading and converting…';
  const feeds = [feedSegments(stream.video, ff.stdin, ctx, referer)];
  if (stream.audio) feeds.push(feedSegments(stream.audio, ff.stdio[3], ctx, referer));
  await Promise.all(feeds);
  const code = await closed;
  check(job);

  if (code !== 0) throw new Error(errText.trim() || `FFmpeg exited with code ${code}.`);
  if (ctx.skipped) note(job, `${ctx.skipped} segment(s) could not be downloaded and were skipped.`);
  if (ctx.truncated) note(job, 'Stopped at the size/time limit, so the file may be incomplete.');
  return out;
}

// ---------------------------------------------------------------------------
// Method 2: direct video/audio file. Download, then remux (or re-encode as a last resort).
// ---------------------------------------------------------------------------
async function runDirect(job, url, referer) {
  const { container } = job.opts;
  const src = path.join(job.dir, 'source.bin');
  const res = await safeFetch(url, { referer, timeout: cfg.jobTimeMs });
  if (!res.ok) throw new Error(`The server answered with HTTP ${res.status}.`);
  const ct = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (ct.includes('html') || ct.includes('mpegurl')) throw new Error('That address is not a plain video file.');
  const len = Number(res.headers.get('content-length') || 0);
  if (len > cfg.maxBytes) throw new Error('The video is larger than the download limit.');
  if (!res.body) throw new Error('The response had no data.');

  job.stage = 'Downloading…';
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > cfg.maxBytes) throw new Error('The video is larger than the download limit.');
        if (len) job.percent = Math.min(90, Math.round((bytes / len) * 90));
        yield chunk;
      }
    },
    fs.createWriteStream(src),
    { signal: job.abort.signal }
  );

  job.stage = 'Converting with FFmpeg…';
  job.percent = null;
  const out = path.join(job.dir, `out.${container}`);
  const copy = ['-i', src, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn', '-c', 'copy', ...fastStart(container)];
  try {
    await runFfmpeg(job, copy, out);
  } catch (err) {
    check(job);
    if (!cfg.allowTranscode) throw err;
    note(job, 'Stream copy was not possible for this file, so it was re-encoded (slower).');
    job.stage = 'Re-encoding with FFmpeg…';
    await runFfmpeg(
      job,
      ['-i', src, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
       '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k',
       ...fastStart(container)],
      out
    );
  }
  await fsp.rm(src, { force: true });
  return out;
}

// yt-dlp format choice. MP4 prefers H.264 video + AAC audio: YouTube's VP9/AV1 streams
// also come as "mp4" but QuickTime, Windows' player and many TVs then play only the sound.
// (H.264 tops out at 1080p on YouTube; MKV takes the best stream of any codec, 4K included.)
function ytdlpFormat({ format, audio, maxHeight }) {
  if (audio) return ['-f', 'ba/b', '-x', '--audio-format', audio, '--audio-quality', '0'];
  const h = maxHeight ? `[height<=${maxHeight}]` : '';
  const selector =
    format === 'mp4'
      ? `bv*${h}[vcodec^=avc1]+ba[acodec^=mp4a]/b${h}[vcodec^=avc1][acodec^=mp4a]/bv*${h}[vcodec^=avc1]+ba/bv*${h}+ba/b${h}/bv*+ba/b`
      : `bv*${h}+ba/b${h}/bv*+ba/b`;
  return ['-f', selector, '--merge-output-format', format, '--remux-video', format];
}

function ytdlpExtras({ audio, subtitles, subLang, metadata, sponsorblock }) {
  const args = [];
  if (subtitles && !audio) {
    // The language itself and its regional variants (en, en-orig, en-US). Not "en.*": that also
    // matches YouTube's dozens of machine-translated tracks (en-de, en-fr…) and gets rate-limited.
    // yt-dlp matches case-insensitively, hence (?-i:) to require an upper-case region.
    // Real subtitles win; auto-generated ones only fill in when there are none.
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', `${subLang},${subLang}-orig,${subLang}-(?-i:[A-Z]{2})`, '--embed-subs');
  }
  if (metadata) args.push('--embed-metadata', '--embed-thumbnail', '--embed-chapters');
  if (sponsorblock) args.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction');
  return args;
}

// ---------------------------------------------------------------------------
// Method 3: yt-dlp. Handles hundreds of sites, AES-128 encrypted HLS and DASH.
// (DRM such as Widevine is not supported by anything legitimate.)
// ---------------------------------------------------------------------------
async function runYtdlp(job, url, referer) {
  try {
    return await ytdlpOnce(job, url, referer, job.opts);
  } catch (err) {
    // Missing or rate-limited subtitles shouldn't cost the whole video.
    if (!job.opts.subtitles || job.cancelled || !/subtitle/i.test(err.message)) throw err;
    note(job, `Saved without subtitles (${err.message.replace(/\.$/, '')}).`);
    await clearOutputs(job);
    return ytdlpOnce(job, url, referer, { ...job.opts, subtitles: false });
  }
}

async function ytdlpOnce(job, url, referer, opts) {
  // yt-dlp rewrites the cookie file when it finishes, so give each job its own copy.
  let cookieArgs = [];
  if (cfg.ytdlpCookies) {
    const copy = path.join(job.dir, 'cookies.txt');
    await fsp.copyFile(cfg.ytdlpCookies, copy).catch((e) => {
      throw new Error(`Could not read the yt-dlp cookies file (${e.message}).`);
    });
    cookieArgs = ['--cookies', copy];
  } else if (cfg.ytdlpCookiesFromBrowser) {
    cookieArgs = ['--cookies-from-browser', cfg.ytdlpCookiesFromBrowser];
  }
  const args = [
    '--ignore-config', '--no-playlist', '--newline', '--no-colors',
    '--socket-timeout', '30', '--retries', '5', '--fragment-retries', '5',
    '--concurrent-fragments', '4',
    '--max-filesize', `${Math.floor(cfg.maxBytes / 1048576)}M`,
    '--cache-dir', path.join(cfg.jobsDir, '.ytdlp-cache'),
    '--user-agent', asHeaders(referer)['user-agent'] || UA,
    ...cookieArgs,
    // YouTube needs a JS runtime for its player challenges; yt-dlp only looks for Deno by default.
    '--js-runtimes', `node:${process.execPath}`,
    ...ytdlpFormat(opts),
    ...ytdlpExtras(opts),
    ...Object.entries(asHeaders(referer))
      .filter(([k]) => k !== 'user-agent')
      .flatMap(([k, v]) => ['--add-header', `${k}:${v}`]),
    // The folder, so yt-dlp finds ffprobe next to ffmpeg (SponsorBlock and chapters need it).
    ...(path.isAbsolute(cfg.ffmpeg) ? ['--ffmpeg-location', path.dirname(cfg.ffmpeg)] : []),
    '-o', path.join(job.dir, 'ytdlp.%(ext)s'),
    '--print-to-file', 'after_move:%(title)s', path.join(job.dir, 'title.txt'),
    '--', url,
  ];
  // Kept for the error log: yt-dlp's own messages, without the progress lines.
  const output = [];
  await new Promise((resolve, reject) => {
    const p = track(job, cfg.ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastError = '';
    let part = 0;
    const onLine = (line) => {
      if (!line) return;
      const m = /^\[download\]\s+([\d.]+)%/.exec(line);
      if (m) {
        job.stage = part > 1 ? 'Downloading the audio…' : 'Downloading with yt-dlp…';
        job.percent = Math.min(99, Math.round(Number(m[1])));
        return;
      }
      if (/^\[download\] Destination:/.test(line)) part++;
      if (/^\[(Merger|VideoRemuxer|FFmpegVideoRemuxer)\]/.test(line)) {
        job.stage = 'Merging video and audio…';
        job.percent = null;
      } else if (/^\[ExtractAudio\]/.test(line)) {
        job.stage = 'Converting to audio…';
        job.percent = null;
      } else if (/^\[(EmbedSubtitle|FFmpegEmbedSubtitle|Metadata|EmbedThumbnail|ThumbnailsConvertor)\]/.test(line)) {
        job.stage = 'Adding subtitles and details…';
        job.percent = null;
      } else if (/^\[(SponsorBlock|ModifyChapters)\]/.test(line)) {
        job.stage = 'Removing sponsor segments…';
        job.percent = null;
      }
      output.push(line);
      if (output.length > 80) output.shift();
      if (/^ERROR:/.test(line)) lastError = line.replace(/^ERROR:\s*/, '');
    };
    for (const s of [p.stdout, p.stderr]) {
      let buf = '';
      s.setEncoding('utf8');
      s.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      });
    }
    const fail = (msg) => reject(Object.assign(new Error(msg), { output: output.join('\n') }));
    p.on('error', (e) => fail(`yt-dlp could not start (${e.message}).`));
    p.on('close', (code) => {
      if (code === 0) return resolve();
      let msg = lastError || `yt-dlp exited with code ${code}.`;
      if (/confirm you.re not a bot|--cookies/i.test(msg) && !cookieArgs.length) {
        msg = 'YouTube wants a signed-in session. Use the YouTube menu to pick the browser you are signed in with.';
      }
      fail(msg);
    });
  });
  check(job);

  const files = (await fsp.readdir(job.dir)).filter(
    (f) => f.startsWith('ytdlp.') && !/\.(part|ytdl|json|vtt|srt|ass|lrc|webp|jpe?g|png|temp\.\w+)$/i.test(f)
  );
  if (!files.length) throw Object.assign(new Error('yt-dlp finished but produced no file.'), { output: output.join('\n') });
  // Name the file after the video's real title.
  const title = (await fsp.readFile(path.join(job.dir, 'title.txt'), 'utf8').catch(() => '')).split('\n')[0].trim();
  if (title && title !== 'NA') job.opts.name = safeName(title);
  let best = null;
  for (const f of files) {
    const size = (await fsp.stat(path.join(job.dir, f))).size;
    if (!best || size > best.size) best = { f, size };
  }
  return path.join(job.dir, best.f);
}

// Codec names of a file's streams, read from FFmpeg's description of it.
async function probeCodecs(file) {
  const text = await new Promise((resolve) => {
    let err = '';
    const p = spawn(cfg.ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => resolve(err));
    p.on('error', () => resolve(''));
  });
  const codec = (kind) => new RegExp(`Stream #\\S+.*?: ${kind}: (\\w+)`).exec(text)?.[1] || null;
  return { video: codec('Video'), audio: codec('Audio') };
}

// After a method succeeds: audio-only conversion for the video methods, and a warning when
// an MP4's video won't play in the usual players.
async function finish(job, file) {
  const { audio, format } = job.opts;
  if (audio && path.extname(file).slice(1) !== audio) {
    job.stage = 'Converting to audio…';
    job.percent = null;
    const out = path.join(job.dir, `audio.${audio}`);
    const codecs = await probeCodecs(file);
    if (!codecs.audio) throw new Error('This video has no sound to save.');
    const copy = audio === 'm4a' && codecs.audio === 'aac';
    const enc = copy ? ['-c:a', 'copy'] : audio === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '0'] : ['-c:a', 'aac', '-b:a', '256k'];
    await runFfmpeg(job, ['-i', file, '-vn', '-sn', '-dn', ...enc], out);
    return out;
  }
  if (!audio && format === 'mp4') {
    const { video } = await probeCodecs(file);
    if (video && !/^(h264|hevc)$/.test(video)) {
      note(job, `This video is only available as ${video.toUpperCase()}, which some players (QuickTime, Windows Media Player) can't show; VLC plays it.`);
    }
  }
  return file;
}

// ---------------------------------------------------------------------------
// Method 4: FFmpeg opens the URL itself (like the desktop app). Handles more exotic
// playlists, but FFmpeg follows segment addresses without our public-address check,
// so it can be switched off with ALLOW_FFMPEG_DIRECT=0.
// ---------------------------------------------------------------------------
function ffmpegHeaders(referer) {
  const lines = Object.entries(asHeaders(referer))
    .filter(([k]) => k !== 'user-agent')
    .map(([k, v]) => `${k}: ${v}\r\n`);
  return lines.length ? ['-headers', lines.join('')] : [];
}

async function runFfmpegUrl(job, url, referer) {
  if (!cfg.allowFfmpegDirect) throw new Error('This method is turned off.');
  const { container } = job.opts;
  const out = path.join(job.dir, `out.${container}`);
  job.stage = 'Downloading and converting…';
  await runFfmpeg(
    job,
    [
      '-protocol_whitelist', 'http,https,tcp,tls,crypto',
      '-user_agent', asHeaders(referer)['user-agent'] || UA,
      ...ffmpegHeaders(referer),
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-rw_timeout', '30000000',
      '-i', url,
      '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn', '-c', 'copy',
      ...fastStart(container),
    ],
    out
  );
  return out;
}
