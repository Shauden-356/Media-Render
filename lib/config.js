import os from 'node:os';
import path from 'node:path';

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);

export const cfg = {
  jobTimeMs: num(process.env.JOB_TIME_LIMIT_SECONDS, 3600) * 1000,
  maxBytes: num(process.env.MAX_DOWNLOAD_MB, 2048) * 1024 * 1024,
  concurrent: num(process.env.MAX_CONCURRENT_JOBS, 2),
  maxJobs: 40,
  fileTtlMs: num(process.env.FILE_TTL_MINUTES, 20) * 60_000,
  jobsDir: process.env.JOBS_DIR || path.join(os.tmpdir(), 'mz-jobs'),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ytdlp: process.env.YTDLP_PATH || 'yt-dlp',
  // Logged-in cookies for yt-dlp (YouTube's "Sign in to confirm you're not a bot").
  // YTDLP_COOKIES: path to a Netscape cookies.txt. YTDLP_COOKIES_FROM_BROWSER: e.g. "chrome" (local only).
  ytdlpCookies: process.env.YTDLP_COOKIES || '',
  ytdlpCookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || '',
  allowTranscode: process.env.ALLOW_TRANSCODE !== '0',
  allowFfmpegDirect: process.env.ALLOW_FFMPEG_DIRECT !== '0',
  scanBudgetMs: num(process.env.SCAN_BUDGET_MS, 55000),
  maxScans: num(process.env.MAX_CONCURRENT_SCANS, 2),
};
