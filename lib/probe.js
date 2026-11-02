// What an address really is, from the server's answer rather than its name: stream playlists and
// media files are often served from addresses like /getSources?id=… or /play/9f2c with no extension.
import { safeFetch } from './net.js';
import { kindFromContentType, streamType, streamTypeFromBody, streamTypeFromContentType } from './extract.js';

// -> { type: 'hls'|'dash'|'hds'|'mss'|'video'|'audio'|'page'|null, contentType, finalUrl }
export async function probeUrl(url, referer) {
  const byName = streamType(url);
  if (byName) return { type: byName, contentType: '', finalUrl: url };
  let res;
  try {
    // Only the start: enough to recognise a playlist, without downloading a whole video.
    res = await safeFetch(url, { referer, timeout: 12000, range: 'bytes=0-4095' });
  } catch {
    return { type: null, contentType: '', finalUrl: url };
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const finalUrl = res.url || url;
  const done = (type) => {
    res.body?.cancel().catch(() => {});
    return { type, contentType, finalUrl };
  };
  if (!res.ok) return done(null);
  const declared = streamTypeFromContentType(contentType) || streamType(finalUrl);
  if (declared) return done(declared);
  const kind = kindFromContentType(contentType);
  if (kind === 'video' || kind === 'audio') return done(kind);
  if (contentType.includes('html')) return done('page');
  // Mislabelled (text/plain, application/octet-stream, JSON…): look at the first bytes.
  let head = '';
  try {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < 4096) {
      const { done: end, value } = await reader.read();
      if (end) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    head = Buffer.concat(chunks).subarray(0, 4096).toString('utf8');
  } catch {
    /* unreadable */
  }
  return { type: streamTypeFromBody(head), contentType, finalUrl };
}
