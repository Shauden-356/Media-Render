import { once } from 'node:events';
import { safeFetch } from './net.js';
import { cfg } from './config.js';

const MAX_SEGMENT = 60 * 1024 * 1024;
const WINDOW = 6; // segments downloaded ahead, in parallel

// Downloads HLS segments in order (a few at a time) and writes them into `sink`
// (FFmpeg's stdin or fd 3). Every request goes through safeFetch, so a playlist
// can never point FFmpeg at internal addresses or local files.
// ctx: { job, deadline, bytes, skipped, truncated, stopped }
export async function feedSegments(playlist, sink, ctx, referer) {
  const urls = [
    ...(playlist.map ? [{ url: playlist.map, range: playlist.mapRange }] : []),
    ...playlist.segments.map((url, i) => ({ url, range: playlist.segmentRanges[i] })),
  ];

  const get = async ({ url, range }) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (ctx.job.cancelled) return null;
      try {
        const r = await safeFetch(url, {
          referer,
          timeout: 25000,
          range: range ? `bytes=${range.start}-${range.end}` : undefined,
        });
        if (!r.ok) {
          r.body?.cancel();
          continue;
        }
        if (range && r.status !== 206) {
          r.body?.cancel();
          return null;
        }
        if (Number(r.headers.get('content-length') || 0) > MAX_SEGMENT) {
          r.body?.cancel();
          return null;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        return buf.length > MAX_SEGMENT ? null : buf;
      } catch {
        /* retry */
      }
    }
    return null; // never rejects
  };

  const pending = new Array(urls.length);
  const kick = (i) => {
    if (i < urls.length && !pending[i]) pending[i] = get(urls[i]);
  };
  for (let i = 0; i < Math.min(WINDOW, urls.length); i++) kick(i);
  sink.on('error', () => {
    ctx.stopped = true;
  });

  try {
    for (let i = 0; i < urls.length; i++) {
      if (ctx.stopped || ctx.job.cancelled) break;
      if (Date.now() > ctx.deadline || ctx.bytes > cfg.maxBytes) {
        ctx.truncated = true;
        break;
      }
      const buf = await pending[i];
      pending[i] = null;
      kick(i + WINDOW);
      if (!buf) {
        ctx.skipped++;
        continue;
      }
      ctx.bytes += buf.length;
      if (!sink.write(buf)) {
        try {
          await Promise.race([once(sink, 'drain'), once(sink, 'close')]);
        } catch {
          ctx.stopped = true;
        }
      }
    }
  } finally {
    sink.end();
  }
}
