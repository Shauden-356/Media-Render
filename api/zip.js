import { ZipArchive } from 'archiver';
import path from 'node:path';
import { Readable } from 'node:stream';
import { safeFetch } from '../lib/net.js';

const MAX_FILES = 300;
const MAX_FILE = 1024 * 1024 * 1024; // 1 GB per file
const MAX_TOTAL = 2 * 1024 * 1024 * 1024; // 2 GB per zip (the page holds the zip in memory)
const BUFFER_LIMIT = 8 * 1024 * 1024; // files up to this size are read into memory
const UNKNOWN_SIZE_LIMIT = 30 * 1024 * 1024; // files with no declared size
const CONCURRENCY = 5;
const TIME_BUDGET_MS = (Number(process.env.ZIP_TIME_LIMIT_SECONDS) || 1800) * 1000;

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/bmp': '.bmp', 'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico', 'image/tiff': '.tif', 'image/heic': '.heic', 'image/heif': '.heif',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac',
  'audio/flac': '.flac', 'audio/webm': '.weba', 'audio/opus': '.opus', 'audio/midi': '.mid',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/ogg': '.ogv',
  'video/x-matroska': '.mkv', 'video/x-msvideo': '.avi', 'video/x-ms-wmv': '.wmv',
  'video/x-flv': '.flv', 'video/3gpp': '.3gp',
};

async function readCapped(body, cap) {
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(body)) {
    size += chunk.length;
    if (size > cap) throw new Error(`larger than ${Math.round(cap / 1048576)} MB with no declared size`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const { urls, page } = req.body || {};
  if (!Array.isArray(urls) || !urls.length) {
    return res.status(400).json({ error: 'Select at least one file.' });
  }
  const list = [...new Set(urls.filter((u) => typeof u === 'string'))].slice(0, MAX_FILES);
  const started = Date.now();

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="media.zip"');

  const archive = new ZipArchive({ zlib: { level: 1 } });
  archive.on('error', () => res.destroy());
  archive.pipe(res);

  const used = new Set();
  const report = [];
  let total = 0;

  const nameFor = (url, type) => {
    let base = '';
    try {
      base = decodeURIComponent(path.posix.basename(new URL(url).pathname));
    } catch {
      /* use default */
    }
    base = base.replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'file';
    if (!path.extname(base)) base += EXT_BY_TYPE[type] || '';
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let name = base;
    let n = 1;
    while (used.has(name.toLowerCase())) name = `${stem}-${n++}${ext}`;
    used.add(name.toLowerCase());
    return name;
  };

  // Waits until archiver has finished writing one entry.
  const written = (name) =>
    new Promise((resolve) => {
      const onEntry = (e) => {
        if (e.name === name) {
          archive.off('entry', onEntry);
          resolve();
        }
      };
      archive.on('entry', onEntry);
    });

  const grab = async (u) => {
    if (Date.now() - started > TIME_BUDGET_MS) return { u, error: 'skipped: time limit reached' };
    try {
      const r = await safeFetch(u, { referer: typeof page === 'string' ? page : undefined, timeout: 25000 });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type === 'text/html') throw new Error('not a media file');
      const len = Number(r.headers.get('content-length') || 0);
      if (len > MAX_FILE) throw new Error(`larger than ${MAX_FILE / 1048576} MB`);
      if (len > BUFFER_LIMIT) return { u, type, len, body: r.body }; // streamed later
      const buf = await readCapped(r.body, len ? BUFFER_LIMIT : UNKNOWN_SIZE_LIMIT);
      return { u, type, buf };
    } catch (e) {
      return { u, error: e?.name === 'TimeoutError' ? 'timed out' : e?.message || 'failed' };
    }
  };

  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const results = await Promise.all(list.slice(i, i + CONCURRENCY).map(grab));
    for (const r of results) {
      if (r.error) {
        report.push(`FAILED   ${r.u}  (${r.error})`);
        continue;
      }
      const size = r.buf ? r.buf.length : r.len;
      if (total + size > MAX_TOTAL) {
        r.body?.cancel();
        report.push(`SKIPPED  ${r.u}  (zip size limit reached)`);
        continue;
      }
      total += size;
      const name = nameFor(r.u, r.type);
      const done = written(name);
      archive.append(r.buf ?? Readable.fromWeb(r.body), { name });
      await done;
      report.push(`OK       ${name}  <-  ${r.u}`);
    }
  }

  archive.append(report.join('\n') + '\n', { name: '_report.txt' });
  await archive.finalize();
}
