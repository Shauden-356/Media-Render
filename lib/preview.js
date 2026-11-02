// Previews for the video picker: a thumbnail, title, length and size for each video found on
// a page, so the user can tell them apart (main video, trailer, ad…) before downloading.
import { spawn } from 'node:child_process';
import { cfg } from './config.js';
import { asHeaders, assertPublicUrl, ffmpegHeaders } from './net.js';
import { requestFor } from './scanner.js';
import { isVideoSite } from './extract.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const cache = new Map(); // url -> Promise<preview>
let active = 0;
const waiting = [];

// A few at a time: each one starts FFmpeg or yt-dlp.
async function limited(fn) {
  if (active >= 3) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    // ELECTRON_RUN_AS_NODE: yt-dlp's --js-runtimes points at this app's executable (see jobs.js).
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-20000)));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', () => resolve({ out: Buffer.alloc(0), err }));
    p.on('close', () => {
      clearTimeout(timer);
      resolve({ out: Buffer.concat(out), err });
    });
  });
}

// Sites yt-dlp knows: ask it for the details (no download).
async function viaYtdlp(url) {
  const { out } = await run(
    cfg.ytdlp,
    [
      '--ignore-config', '--no-playlist', '--skip-download', '--no-warnings',
      '--js-runtimes', `node:${process.execPath}`,
      '--print', '%(title)s\t%(duration)s\t%(width)s\t%(height)s\t%(thumbnail)s',
      '--', url,
    ],
    45000
  );
  const [title, duration, width, height, thumb] = out.toString().trim().split('\n').pop().split('\t');
  const num = (v) => (Number(v) > 0 ? Number(v) : null);
  if (!title) return {};
  return {
    title: title === 'NA' ? null : title,
    duration: num(duration),
    width: num(width),
    height: num(height),
    thumb: /^https?:/.test(thumb || '') ? thumb : null,
  };
}

// Streams and files: one frame from a few seconds in, plus what FFmpeg reports about it.
async function viaFfmpeg(url, ref) {
  await assertPublicUrl(url);
  const headers = asHeaders(ref);
  const { out, err } = await run(
    cfg.ffmpeg,
    [
      '-hide_banner', '-nostdin',
      '-protocol_whitelist', 'http,https,tcp,tls,crypto,data',
      '-user_agent', headers['user-agent'] || UA,
      ...ffmpegHeaders(ref),
      '-ss', '4',
      '-i', url,
      '-map', '0:v:0?', '-frames:v', '1', '-vf', 'scale=320:-2',
      '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
    ],
    30000
  );
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  const sizes = [...err.matchAll(/Stream #.*?Video:.*?(\d{2,5})x(\d{2,5})/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const [width, height] = sizes.sort((a, b) => b[1] - a[1])[0] || [];
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    width: width || null,
    height: height || null,
    thumb: out.length > 100 ? `data:image/jpeg;base64,${out.toString('base64')}` : null,
  };
}

export function previewOf(url, page) {
  if (!cache.has(url)) {
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    const ref = requestFor(url) || page;
    cache.set(
      url,
      limited(() => (isVideoSite(url) ? viaYtdlp(url) : viaFfmpeg(url, ref))).catch(() => ({}))
    );
  }
  return cache.get(url);
}
