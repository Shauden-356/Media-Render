import os from 'node:os';
import path from 'node:path';

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);

// The desktop app sets FFMPEG_PATH / YTDLP_PATH to its bundled copies before loading this.
// Without them, ffmpeg and yt-dlp are looked up on the PATH.
export const cfg = {
  jobTimeMs: num(process.env.JOB_TIME_LIMIT_SECONDS, 6 * 3600) * 1000,
  maxBytes: num(process.env.MAX_DOWNLOAD_MB, 50 * 1024) * 1024 * 1024,
  concurrent: num(process.env.MAX_CONCURRENT_JOBS, 3),
  maxJobs: 100,
  fileTtlMs: num(process.env.FILE_TTL_MINUTES, 120) * 60_000,
  jobsDir: process.env.JOBS_DIR || path.join(os.tmpdir(), 'imadia-jobs'),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ytdlp: process.env.YTDLP_PATH || 'yt-dlp',
  ytdlpSelfUpdate: process.env.YTDLP_SELF_UPDATE === '1',
  // Settings that persist, such as sign-in cookies (the desktop app uses its own data folder).
  dataDir: process.env.DATA_DIR || path.join(os.homedir(), '.imadia'),
  allowTranscode: process.env.ALLOW_TRANSCODE !== '0',
  allowFfmpegDirect: process.env.ALLOW_FFMPEG_DIRECT !== '0',
  scanBudgetMs: num(process.env.SCAN_BUDGET_MS, 60000),
  maxScans: num(process.env.MAX_CONCURRENT_SCANS, 2),
};
