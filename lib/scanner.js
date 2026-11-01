// Finds media on a page. Uses a real headless browser (Playwright) so media that
// scripts load after the page opens is caught; falls back to a plain HTML scan.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright-core';
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
import { cfg } from './config.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_ITEMS = 500;

// What the browser sent when it loaded each stream or video file. Sites often accept a
// stream only with the player's own Referer/Origin/cookies (the player is frequently a
// frame on another site), so downloads repeat exactly these instead of guessing.
const sentHeaders = new Map(); // url -> { headers, at }
const KEEP_HEADERS = ['referer', 'origin', 'cookie', 'user-agent'];

function rememberRequest(url, all) {
  const headers = {};
  for (const k of KEEP_HEADERS) if (all[k]) headers[k] = all[k];
  sentHeaders.delete(url);
  sentHeaders.set(url, { headers, at: Date.now() });
  if (sentHeaders.size > 500) sentHeaders.delete(sentHeaders.keys().next().value);
}

// Headers to fetch `url` with, if a recent scan saw the browser load it (else null).
export function requestFor(url) {
  const e = sentHeaders.get(url);
  return e && Date.now() - e.at < 3 * 3600_000 ? e.headers : null;
}

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

// Uses a browser already on the computer (Edge ships with Windows; Chrome is common on
// Macs), so the app doesn't carry its own copy. Without one, Playwright's small headless
// browser is downloaded once (to PLAYWRIGHT_BROWSERS_PATH). CHROME_PATH overrides all of this.
const CHANNELS = process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge'];
let working; // launch options that worked last time
let installing = null;

function installHeadlessShell() {
  installing ??= new Promise((resolve) => {
    // Inside the packaged app the package lives in app.asar.unpacked.
    const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
    const cli = path.join(path.dirname(pkg), 'cli.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    console.log('Downloading the page-scanner browser…');
    spawn(process.execPath, [cli, 'install', '--only-shell', 'chromium'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    })
      .on('error', () => resolve(false))
      .on('close', (code) => {
        if (code !== 0) installing = null; // allow another try later
        resolve(code === 0);
      });
  });
  return installing;
}

async function launchBrowser(options) {
  if (process.env.CHROME_PATH) return chromium.launch({ ...options, executablePath: process.env.CHROME_PATH });
  if (working) return chromium.launch({ ...options, ...working });
  for (const extra of [...CHANNELS.map((channel) => ({ channel })), {}]) {
    try {
      const browser = await chromium.launch({ ...options, ...extra });
      working = extra;
      return browser;
    } catch {
      /* not installed; try the next one */
    }
  }
  installHeadlessShell();
  throw new Error('No browser for the page scanner yet.');
}

// Called at start-up so a missing scanner browser is fetched before the first scan.
export async function prepareScanner() {
  try {
    await (await launchBrowser({ headless: true })).close();
  } catch {
    if (await installing) console.log('Page-scanner browser ready.');
  }
}

async function renderPage(startUrl, deadline) {
  const browser = await launchBrowser({
    headless: true,
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
          // Record the URL but don't download the whole video/audio here.
          rememberRequest(u, await req.allHeaders().catch(() => req.headers()));
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
    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (!/^https?:/i.test(url) || res.status() >= 400) return;
        const h = res.headers();
        const rt = res.request().resourceType();
        const ct = h['content-type'] || '';
        // A real playlist: the address ends in .m3u8/.mpd, or the server says it is one.
        // (Not a player page that merely has ".m3u8" in its query string.)
        const isStream = /\.(m3u8|mpd)$/i.test(new URL(url).pathname) || kindFromContentType(ct) === 'stream';
        if (isStream) {
          netStreams.add(url);
          rememberRequest(url, await res.request().allHeaders().catch(() => ({})));
          return;
        }
        if (kindOf(url, null) === 'stream') return;
        let kind = kindFromContentType(ct);
        if (!kind && /octet-stream|binary/i.test(ct) && isMediaUrl(url)) kind = kindOf(url, null);
        if (!kind) return;
        if (kind === 'stream') return; // handled above
        const len = Number(h['content-length'] || 0);
        if (kind === 'image' && len && len < 200) return; // tracking pixels
        if (
          (kind === 'video' || kind === 'audio') &&
          (SEGMENT.test(url) || ((rt === 'fetch' || rt === 'xhr') && res.status() !== 200))
        ) {
          return; // piece of a segmented stream
        }
        netItems.push([url, kind]);
        if (kind === 'video' || kind === 'audio') rememberRequest(url, await res.request().allHeaders().catch(() => ({})));
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
    return { finalUrl, html, title, domItems, netItems, netStreams: [...netStreams] };
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
  };
}

// Streams the player loaded first (those addresses carry any access tokens), then ones only
// written in the page. Drops written addresses that are a loaded stream minus its token
// (they fail with 403) and player pages that merely mention ".m3u8" in their query.
function rankStreams(all, captured) {
  const key = (u) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname;
    } catch {
      return u;
    }
  };
  const loadedPaths = new Set([...captured].map(key));
  const written = all.filter((u) => {
    if (captured.has(u)) return false;
    if (loadedPaths.has(key(u))) return false;
    try {
      return /\.(m3u8|mpd)$/i.test(new URL(u).pathname);
    } catch {
      return false;
    }
  });
  return [...all.filter((u) => captured.has(u)), ...written];
}

// Returns { page, title, mode, items, streams: [{url,name,played}], notes }.
export async function scanPage(start, deadline = Date.now() + cfg.scanBudgetMs) {
  const notes = [];
  let mode = 'browser';
  let captured = new Set(); // streams the page's player actually loaded
  let collector;
  let pageUrl = start;
  let title = '';

  await acquire();
  try {
    try {
      const r = await renderPage(start, deadline);
      pageUrl = r.finalUrl;
      title = r.title;
      collector = makeCollector(r.finalUrl);
      r.domItems.forEach(([u, k]) => collector.add(u, k)); // live DOM first: best kind hints
      extractFromDocument(cheerio.load(r.html), collector, r.html);
      r.netItems.forEach(([u, k]) => collector.add(u, k));
      r.netStreams.forEach((u) => collector.addStream(u));
      captured = new Set(r.netStreams);
    } catch (browserErr) {
      console.error('Browser scan failed:', browserErr);
      try {
        const b = await basicScan(start);
        collector = b.collector;
        pageUrl = b.finalUrl;
        title = b.title;
        mode = 'basic';
        notes.push(
          installing
            ? 'The page scanner is still being set up (a one-time download), so this was a basic scan. Try again in a minute for a full scan.'
            : 'The browser scanner could not run, so this was a basic scan. It misses media that scripts load after the page opens. Installing Google Chrome usually fixes this.'
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
  const allStreams = rankStreams(collector.streams(), captured);
  const streams = allStreams
    .filter((u) => !isDash(u))
    .slice(0, 12)
    .map((u) => ({ url: u, name: nameOf(u), played: captured.has(u) }));
  if (allStreams.some(isDash)) notes.push('This page also uses DASH (.mpd) streams; only yt-dlp can try those.');
  if (!streams.length && collector.blobMedia()) {
    notes.push(
      'This page plays video through an in-page player that does not expose a file or playlist address. Try the "yt-dlp" method with the page address.'
    );
  }
  return { page: pageUrl, title, mode, items, streams, notes };
}
