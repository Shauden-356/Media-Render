// Finds media on a page. Uses a real headless browser (Playwright) so media that
// scripts load after the page opens is caught; falls back to a plain HTML scan.
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { assertPublicUrl, safeFetch } from './net.js';
import {
  makeCollector,
  extractFromDocument,
  kindOf,
  kindFromContentType,
  isMediaUrl,
  nameOf,
  SEGMENT,
} from './extract.js';
import { isYouTubeUrl } from './youtube.js';
import { cfg } from './config.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_ITEMS = 500;

// Only a couple of browsers at once; each one is memory hungry.
let active = 0;
const waiters = [];
async function acquire() {
  if (active < cfg.maxScans) {
    active++;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
}
function release() {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

function hasYouTubeEmbed(html, baseUrl) {
  const $ = cheerio.load(html);
  return $('iframe[src]').toArray().some((el) => {
    try {
      return isYouTubeUrl(new URL(el.attribs.src, baseUrl).href);
    } catch {
      return false;
    }
  });
}

// Runs inside the page: reads media from the live DOM, computed styles,
// pseudo-elements and shadow roots (things that only exist after scripts run).
function collectFromDom() {
  const out = [];
  const push = (u, k) => {
    if (u) out.push([u, k]);
  };
  const urlsIn = (v) => {
    const r = [];
    if (!v || v === 'none') return r;
    const re = /url\((['"]?)(.*?)\1\)/g;
    let m;
    while ((m = re.exec(v))) r.push(m[2]);
    return r;
  };
  let count = 0;
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (++count > 20000) return;
      if (el.shadowRoot) walk(el.shadowRoot);
      const tag = el.tagName.toUpperCase();
      if (tag === 'IMG') push(el.currentSrc || el.src, 'image');
      else if (tag === 'VIDEO') {
        push(el.currentSrc || el.src, 'video');
        push(el.poster, 'image');
      } else if (tag === 'AUDIO') push(el.currentSrc || el.src, 'audio');
      else if (tag === 'SOURCE') {
        const p = el.parentElement && el.parentElement.tagName.toUpperCase();
        push(el.src, p === 'VIDEO' ? 'video' : p === 'AUDIO' ? 'audio' : 'image');
      } else if (tag === 'IMAGE') push(el.href && el.href.baseVal, 'image');
      const cs = getComputedStyle(el);
      urlsIn(cs.backgroundImage).forEach((u) => push(u, 'image'));
      urlsIn(cs.listStyleImage).forEach((u) => push(u, 'image'));
      if (count < 4000) {
        for (const ps of ['::before', '::after']) {
          urlsIn(getComputedStyle(el, ps).backgroundImage).forEach((u) => push(u, 'image'));
        }
      }
    }
  };
  walk(document);
  return out;
}

const PLAY_BUTTONS = [
  '.vjs-big-play-button',
  '.jw-icon-display',
  '.plyr__control--overlaid',
  'button[aria-label*="play" i]',
  '[class*="play-button" i]',
];

async function renderPage(startUrl, deadline) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const netItems = [];
  const netStreams = new Set();

  try {
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1366, height: 900 },
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    const page = await context.newPage();

    // Every request the page makes must go to a public address.
    const hostCache = new Map();
    const allowed = (u) => {
      const host = new URL(u).hostname;
      if (!hostCache.has(host)) {
        hostCache.set(host, assertPublicUrl(u).then(() => true, () => false));
      }
      return hostCache.get(host);
    };

    await context.route('**/*', async (route) => {
      try {
        const req = route.request();
        const u = req.url();
        if (!/^https?:/i.test(u)) return await route.continue();
        if (!(await allowed(u))) return await route.abort('blockedbyclient');
        const type = req.resourceType();
        if (type === 'media') {
          if (isYouTubeUrl(u)) return await route.abort('blockedbyclient');
          // Record the URL but don't download the whole video/audio here.
          const k = kindOf(u, 'video');
          if (k === 'stream') netStreams.add(u);
          else if (!SEGMENT.test(u)) netItems.push([u, k]);
          return await route.abort('blockedbyclient');
        }
        if (type === 'font') return await route.abort('blockedbyclient');
        return await route.continue();
      } catch {
        try {
          await route.abort();
        } catch {
          /* already handled */
        }
      }
    });

    // Media the page fetched by script (any extension) is identified by content type.
    page.on('response', (res) => {
      try {
        const url = res.url();
        if (!/^https?:/i.test(url) || res.status() >= 400) return;
        if (isYouTubeUrl(url)) return;
        const h = res.headers();
        const rt = res.request().resourceType();
        const ct = h['content-type'] || '';
        if (kindOf(url, null) === 'stream') {
          netStreams.add(url);
          return;
        }
        let kind = kindFromContentType(ct);
        if (!kind && /octet-stream|binary/i.test(ct) && isMediaUrl(url)) kind = kindOf(url, null);
        if (!kind) return;
        if (kind === 'stream') {
          netStreams.add(url);
          return;
        }
        const len = Number(h['content-length'] || 0);
        if (kind === 'image' && len && len < 200) return; // tracking pixels
        if (
          (kind === 'video' || kind === 'audio') &&
          (SEGMENT.test(url) || ((rt === 'fetch' || rt === 'xhr') && res.status() !== 200))
        ) {
          return; // piece of a segmented stream
        }
        netItems.push([url, kind]);
      } catch {
        /* ignore */
      }
    });

    let navError = null;
    try {
      await page.goto(startUrl, {
        waitUntil: 'networkidle',
        timeout: Math.max(5000, Math.min(25000, deadline - Date.now() - 20000)),
      });
    } catch (e) {
      navError = e; // slow pages: keep whatever has loaded so far
    }
    if (page.url() === 'about:blank') throw navError || new Error('The page did not load.');

    // Scroll through the page so lazy-loaded images and videos start loading.
    try {
      await Promise.race([
        page.evaluate(
          () =>
            new Promise((resolve) => {
              let y = 0;
              const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
              const t = setInterval(() => {
                window.scrollBy(0, step);
                y += step;
                if (y >= Math.min(document.documentElement.scrollHeight, 20000)) {
                  clearInterval(t);
                  window.scrollTo(0, 0);
                  resolve();
                }
              }, 250);
            })
        ),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
    } catch {
      /* page navigated away or blocked scripting */
    }

    // Players often request their HLS manifest only after playback starts.
    await Promise.allSettled(
      page
        .frames()
        .filter((frame) => !isYouTubeUrl(frame.url()))
        .map((frame) =>
          frame.evaluate(() => {
            for (const video of document.querySelectorAll('video')) {
              video.muted = true;
              video.playsInline = true;
              video.play().catch(() => {});
            }
          })
        )
    );
    // Still nothing? Click the usual "big play button" overlays.
    if (!netStreams.size && !netItems.some(([, k]) => k === 'video')) {
      for (const sel of PLAY_BUTTONS) {
        await page.locator(sel).first().click({ timeout: 700 }).catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 2500));

    const domItems = [];
    for (const frame of page.frames()) {
      try {
        domItems.push(...(await frame.evaluate(collectFromDom)));
      } catch {
        /* cross-process or detached frame */
      }
    }

    const html = await page.content();
    const title = await page.title().catch(() => '');
    const finalUrl = page.url();
    const youtubeEmbed =
      page.frames().some((frame) => frame !== page.mainFrame() && isYouTubeUrl(frame.url())) ||
      hasYouTubeEmbed(html, finalUrl);
    return { finalUrl, html, title, domItems, netItems, netStreams: [...netStreams], youtubeEmbed };
  } finally {
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }
}

async function basicScan(startUrl) {
  const page = await safeFetch(startUrl, { accept: 'text/html,application/xhtml+xml', timeout: 20000 });
  if (!page.ok) throw new Error(`The site answered with HTTP ${page.status}.`);
  const type = (page.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('html') && !type.includes('xml')) throw new Error('That address is not a web page.');
  const html = (await page.text()).slice(0, 5_000_000);
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').attr('href');
  const finalUrl = page.url || startUrl;
  const root = baseHref ? new URL(baseHref, finalUrl).href : finalUrl;
  const collector = makeCollector(root);
  extractFromDocument($, collector, html);
  return {
    collector,
    finalUrl,
    title: $('title').first().text().trim(),
    youtubeEmbed: hasYouTubeEmbed(html, finalUrl),
  };
}

// Returns { page, title, mode, items, streams: [{url,name}], notes }.
export async function scanPage(start, deadline = Date.now() + cfg.scanBudgetMs) {
  const notes = [];
  let mode = 'browser';
  let collector;
  let pageUrl = start;
  let title = '';
  let youtubeEmbed = false;

  await acquire();
  try {
    try {
      const r = await renderPage(start, deadline);
      pageUrl = r.finalUrl;
      title = r.title;
      youtubeEmbed = r.youtubeEmbed;
      collector = makeCollector(r.finalUrl);
      r.domItems.forEach(([u, k]) => collector.add(u, k)); // live DOM first: best kind hints
      extractFromDocument(cheerio.load(r.html), collector, r.html);
      r.netItems.forEach(([u, k]) => collector.add(u, k));
      r.netStreams.forEach((u) => collector.addStream(u));
    } catch (browserErr) {
      console.error('Browser scan failed:', browserErr);
      try {
        const b = await basicScan(start);
        collector = b.collector;
        pageUrl = b.finalUrl;
        title = b.title;
        youtubeEmbed = b.youtubeEmbed;
        mode = 'basic';
        notes.push(
          'The browser scanner could not run, so this was a basic scan. It misses media that scripts load after the page opens.'
        );
      } catch (err) {
        const e = new Error(
          err?.name === 'TimeoutError' ? 'The site took too long to respond.' : err?.message || 'Scan failed.'
        );
        e.status = 502;
        throw e;
      }
    }
  } finally {
    release();
  }

  let items = collector.items();
  if (items.length > MAX_ITEMS) {
    items = items.slice(0, MAX_ITEMS);
    notes.push(`Showing the first ${MAX_ITEMS} files found.`);
  }
  const isDash = (u) => /\.mpd(?:$|[?#&])/i.test(u);
  const allStreams = collector.streams();
  const streams = allStreams
    .filter((u) => !isDash(u))
    .slice(0, 12)
    .map((u) => ({ url: u, name: nameOf(u) }));
  if (allStreams.some(isDash)) notes.push('This page also uses DASH (.mpd) streams; only yt-dlp can try those.');
  if (youtubeEmbed) {
    notes.push(
      'This page embeds a YouTube video. YouTube media cannot be downloaded here; use YouTube options where available or a copy provided by the rights holder.'
    );
  }
  if (!streams.length && collector.blobMedia()) {
    notes.push(
      'This page plays video through an in-page player that does not expose a file or playlist address. Try the "yt-dlp" method with the page address.'
    );
  }
  return { page: pageUrl, title, mode, items, streams, notes };
}
