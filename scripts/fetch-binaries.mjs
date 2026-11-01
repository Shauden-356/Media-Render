// Downloads the FFmpeg and yt-dlp binaries that get packed into the app.
//   node scripts/fetch-binaries.mjs [platform] [arch]     (defaults: this computer)
// Writes vendor/<mac|win>-<arch>/ffmpeg[.exe] and yt-dlp[.exe] (names match electron-builder's ${os}).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;

const FFMPEG = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0';
const YTDLP = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const sources = {
  'darwin-arm64': { ffmpeg: `${FFMPEG}/ffmpeg-darwin-arm64.gz`, ytdlp: `${YTDLP}/yt-dlp_macos` },
  'darwin-x64': { ffmpeg: `${FFMPEG}/ffmpeg-darwin-x64.gz`, ytdlp: `${YTDLP}/yt-dlp_macos` },
  'win32-x64': { ffmpeg: `${FFMPEG}/ffmpeg-win32-x64.gz`, ytdlp: `${YTDLP}/yt-dlp.exe` },
};
const src = sources[`${platform}-${arch}`];
if (!src) {
  console.error(`No binaries for ${platform}-${arch}. Supported: ${Object.keys(sources).join(', ')}`);
  process.exit(1);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const os = { darwin: 'mac', win32: 'win' }[platform];
const outDir = path.join(root, 'vendor', `${os}-${arch}`);
fs.mkdirSync(outDir, { recursive: true });
const exe = platform === 'win32' ? '.exe' : '';

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function save(name, url, gz) {
  const file = path.join(outDir, name + exe);
  if (fs.existsSync(file)) return console.log(`have ${path.relative(root, file)}`);
  console.log(`downloading ${url}`);
  let data = await download(url);
  if (gz) data = zlib.gunzipSync(data);
  fs.writeFileSync(file, data, { mode: 0o755 });
  // Apple Silicon refuses to run unsigned binaries; an ad-hoc signature is enough.
  if (platform === 'darwin' && process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'ignore' });
  }
  console.log(`saved ${path.relative(root, file)} (${(data.length / 1048576).toFixed(1)} MB)`);
}

await save('ffmpeg', src.ffmpeg, true);
await save('yt-dlp', src.ytdlp, false);
