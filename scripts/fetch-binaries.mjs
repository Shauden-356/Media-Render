// Downloads the FFmpeg, ffprobe and yt-dlp binaries that get packed into the app.
//   node scripts/fetch-binaries.mjs [platform] [arch]     (defaults: this computer)
// Writes vendor/<mac|win>-<arch>/ffmpeg, ffprobe and yt-dlp (+ .exe on Windows) (names match electron-builder's ${os}).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;

const FFMPEG = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0';
const YTDLP = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const sources = {
  'darwin-arm64': { ffmpeg: `${FFMPEG}/ffmpeg-darwin-arm64.gz`, ffprobe: `${FFMPEG}/ffprobe-darwin-arm64.gz`, ytdlp: `${YTDLP}/yt-dlp_macos` },
  'darwin-x64': { ffmpeg: `${FFMPEG}/ffmpeg-darwin-x64.gz`, ffprobe: `${FFMPEG}/ffprobe-darwin-x64.gz`, ytdlp: `${YTDLP}/yt-dlp_macos` },
  'win32-x64': { ffmpeg: `${FFMPEG}/ffmpeg-win32-x64.gz`, ffprobe: `${FFMPEG}/ffprobe-win32-x64.gz`, ytdlp: `${YTDLP}/yt-dlp.exe` },
};
// SHA-256 of each unpacked FFmpeg build (that release never changes), so a tampered or corrupted
// download is refused. yt-dlp is checked against the SHA2-256SUMS file of its own release.
const FFMPEG_SHA256 = {
  'ffmpeg-darwin-arm64': 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
  'ffprobe-darwin-arm64': 'bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64',
  'ffmpeg-darwin-x64': 'cfe20936c83ecf5d68e424b87e8cc45b24dd6be81787810123bb964a0df686f9',
  'ffprobe-darwin-x64': '30391ba3d662a6fac1c2f7c21fdd3120422377892a090e654936a0aaedba0c53',
  'ffmpeg-win32-x64': 'e9fd5e711debab9d680955fc1e38a2c1160fd280b144476cc3f62bc43ef49db1',
  'ffprobe-win32-x64': '139f8420bcb2f29fcd5734e29d686289df826cadce5d2b7b5f56d0000ea9a951',
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

async function expectedHash(url) {
  const file = path.basename(url);
  if (url.startsWith(FFMPEG)) return FFMPEG_SHA256[file.replace(/\.gz$/, '')];
  // yt-dlp: "<sha256>  <file name>" lines, published with each release.
  const sums = (await download(`${YTDLP}/SHA2-256SUMS`)).toString('utf8');
  return sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, n]) => n === file)?.[0];
}

async function save(name, url, gz) {
  const file = path.join(outDir, name + exe);
  if (fs.existsSync(file)) return console.log(`have ${path.relative(root, file)}`);
  console.log(`downloading ${url}`);
  let data = await download(url);
  if (gz) data = zlib.gunzipSync(data);
  const want = await expectedHash(url);
  const got = createHash('sha256').update(data).digest('hex');
  if (!want || got !== want) throw new Error(`${url}: checksum mismatch (got ${got}, expected ${want || 'none'})`);
  fs.writeFileSync(file, data, { mode: 0o755 });
  // Apple Silicon refuses to run unsigned binaries; an ad-hoc signature is enough.
  if (platform === 'darwin' && process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'ignore' });
  }
  console.log(`saved ${path.relative(root, file)} (${(data.length / 1048576).toFixed(1)} MB)`);
}

await save('ffmpeg', src.ffmpeg, true);
await save('ffprobe', src.ffprobe, true);
await save('yt-dlp', src.ytdlp, false);
