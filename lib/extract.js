// Shared helpers for finding media URLs in HTML, CSS and script text.

export const EXT = {
  image: 'jpe?g|jfif|png|apng|gif|webp|avif|svg|bmp|ico|tiff?|heic|heif',
  audio: 'mp3|wav|ogg|oga|m4a|aac|flac|opus|wma|weba|mid|midi',
  video: 'mp4|webm|mov|m4v|ogv|mkv|avi|wmv|flv|3gp',
  stream: 'm3u8|mpd',
};
const tail = '(?:$|[?#&])';
const RE = Object.fromEntries(
  Object.entries(EXT).map(([k, v]) => [k, new RegExp(`\\.(?:${v})${tail}`, 'i')])
);
// Pieces of segmented streams (not usable as standalone files).
export const SEGMENT = /\.(?:m4s|ts|cmfv|cmfa|cmft)(?:$|[?#&])/i;

export const isMediaUrl = (u) => RE.image.test(u) || RE.audio.test(u) || RE.video.test(u);

export function kindOf(url, fallback) {
  if (RE.stream.test(url)) return 'stream';
  if (RE.audio.test(url)) return 'audio';
  if (RE.video.test(url)) return 'video';
  if (RE.image.test(url)) return 'image';
  return fallback;
}

export function kindFromContentType(ct) {
  ct = (ct || '').split(';')[0].trim().toLowerCase();
  if (!ct) return null;
  if (ct.includes('mpegurl') || ct.includes('dash+xml')) return 'stream';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('audio/') || ct === 'application/ogg') return 'audio';
  if (ct.startsWith('video/')) return 'video';
  return null;
}

export function nameOf(url) {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return base || u.hostname;
  } catch {
    return url;
  }
}

// Collects unique media URLs, resolving them against `root`. First sighting wins,
// so add the most reliable sources (the live DOM) first.
export function makeCollector(root) {
  const found = new Map();
  const streams = new Set();
  let blobMedia = 0;

  const add = (value, fallback = 'image') => {
    if (!value || typeof value !== 'string') return;
    const v = value.trim();
    if (!v || /^(data|javascript|mailto|tel|about):/i.test(v)) return;
    if (/^blob:/i.test(v)) {
      if (fallback === 'video' || fallback === 'audio') blobMedia++;
      return;
    }
    let u;
    try {
      u = new URL(v, root);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = '';
    const href = u.href;
    const kind = kindOf(href, fallback);
    if (kind === 'stream') {
      streams.add(href);
      return;
    }
    if (SEGMENT.test(href)) return;
    if (!found.has(href)) found.set(href, { url: href, kind, name: nameOf(href) });
  };

  const addSrcset = (set, kind = 'image') => {
    if (!set) return;
    set.split(',').forEach((part) => add(part.trim().split(/\s+/)[0], kind));
  };

  const addCss = (css) => {
    if (!css) return;
    for (const m of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
      if (isMediaUrl(m[2])) add(m[2], 'image');
    }
  };

  // Media URLs written into scripts, JSON configs and attributes (video players,
  // lazy loaders, gallery data). Handles JSON-escaped slashes.
  const addFromText = (text) => {
    if (!text) return;
    const clean = text.replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    const all = Object.values(EXT).join('|');
    const re = new RegExp(`https?://[^\\s"'<>\\\\)(]+?\\.(?:${all})(?:\\?[^\\s"'<>\\\\)(]*)?(?=$|[\\s"'<>\\\\)(])`, 'gi');
    for (const m of clean.matchAll(re)) add(m[0], 'image');
  };

  const addStream = (value) => {
    try {
      const u = new URL(value, root);
      if (/^https?:$/.test(u.protocol)) streams.add(u.href);
    } catch {
      /* ignore */
    }
  };

  return {
    add,
    addStream,
    addSrcset,
    addCss,
    addFromText,
    items: () => [...found.values()],
    streams: () => [...streams],
    blobMedia: () => blobMedia,
  };
}

// Reads a parsed (cheerio) document: tags, lazy-load attributes, inline CSS, scripts.
export function extractFromDocument($, collector, rawHtml) {
  const { add, addSrcset, addCss, addFromText } = collector;

  $('img').each((_, el) => {
    const a = el.attribs;
    ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url'].forEach((k) =>
      add(a[k], 'image')
    );
    addSrcset(a.srcset);
    addSrcset(a['data-srcset']);
  });
  $('picture source').each((_, el) => {
    add(el.attribs.src, 'image');
    addSrcset(el.attribs.srcset);
  });
  $('video').each((_, el) => {
    add(el.attribs.src, 'video');
    add(el.attribs['data-src'], 'video');
    add(el.attribs.poster, 'image');
  });
  $('video source').each((_, el) => add(el.attribs.src || el.attribs['data-src'], 'video'));
  $('audio').each((_, el) => add(el.attribs.src || el.attribs['data-src'], 'audio'));
  $('audio source').each((_, el) => add(el.attribs.src || el.attribs['data-src'], 'audio'));
  $('object[data], embed[src]').each((_, el) => add(el.attribs.data || el.attribs.src, 'image'));
  $('meta[property="og:image"], meta[name="twitter:image"], meta[property="og:image:url"]').each(
    (_, el) => add(el.attribs.content, 'image')
  );
  $('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]').each(
    (_, el) => add(el.attribs.content, 'video')
  );
  $('meta[property="og:audio"]').each((_, el) => add(el.attribs.content, 'audio'));
  $('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="image_src"]').each((_, el) =>
    add(el.attribs.href, 'image')
  );
  $('a[href]').each((_, el) => {
    if (isMediaUrl(el.attribs.href)) add(el.attribs.href, 'image');
  });
  $('[style]').each((_, el) => addCss(el.attribs.style));
  $('style').each((_, el) => addCss($(el).text()));

  // Any data-* attribute that holds a media URL (data-bg, data-video, data-full, ...).
  $('*').each((_, el) => {
    for (const [k, v] of Object.entries(el.attribs || {})) {
      if (k.startsWith('data-') && typeof v === 'string' && v.length < 2000) {
        if (isMediaUrl(v)) add(v, 'image');
        if (/srcset/i.test(k)) addSrcset(v);
      }
    }
  });

  addFromText(rawHtml);
}
