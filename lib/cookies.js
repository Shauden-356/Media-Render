// Sign-in cookies, so downloads work as the user's logged-in self: YouTube's "confirm you're not a
// bot", members-only or age-restricted videos, and media on sites that need an account.
//
// Sources: a browser the user is signed in with (read by yt-dlp), or cookies.txt / a JSON export
// (pasted or chosen in the app). They are kept in the app's data folder, readable by this user only,
// and each cookie is only ever sent to the site it belongs to (same matching rules as a browser).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cfg } from './config.js';

export const BROWSERS = ['chrome', 'firefox', 'safari', 'edge', 'brave', 'opera', 'vivaldi', 'chromium', 'whale'];
const MAX_TEXT = 10 * 1024 * 1024;
const MAX_COOKIES = 50000;
const BROWSER_CACHE_MS = 10 * 60_000;

const dir = () => cfg.dataDir;
const settingsFile = () => path.join(dir(), 'cookies.json');
const cookieFile = () => path.join(dir(), 'cookies.txt');

let settings = null; // { source: 'none' | 'browser' | 'file', browser?, count?, domains?, updatedAt? }
let cache = null; // { at, entries }

function loadSettings() {
  if (settings) return settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    settings = { source: 'none' };
  }
  return settings;
}

async function saveSettings(next) {
  settings = { ...next, updatedAt: Date.now() };
  cache = null;
  await fsp.mkdir(dir(), { recursive: true, mode: 0o700 });
  await fsp.writeFile(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

// ---- Reading cookie files -----------------------------------------------------

// Netscape cookies.txt (what browser extensions and yt-dlp write) or a JSON export
// (Cookie-Editor, EditThisCookie…). -> [{ domain, subdomains, path, secure, expires, name, value }]
export function parseCookies(text) {
  text = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  if (text.length > MAX_TEXT) throw new Error('That cookie file is too large.');
  let out = [];
  if (text.startsWith('[') || text.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('That looks like JSON but could not be read.');
    }
    const list = Array.isArray(data) ? data : Array.isArray(data.cookies) ? data.cookies : [];
    for (const c of list) {
      if (!c || typeof c.name !== 'string' || typeof c.domain !== 'string') continue;
      const domain = c.domain.trim().toLowerCase();
      out.push({
        domain: domain.replace(/^\./, ''),
        subdomains: c.hostOnly === true ? false : true,
        path: typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/',
        secure: !!c.secure,
        expires: Number(c.expirationDate || c.expires || 0) > 0 ? Math.floor(Number(c.expirationDate || c.expires)) : 0,
        name: c.name,
        value: String(c.value ?? ''),
      });
    }
  } else {
    for (let line of text.split(/\r?\n/)) {
      if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
      else if (!line.trim() || line.startsWith('#')) continue;
      const f = line.split('\t');
      if (f.length < 7) continue;
      const [domain, flag, p, secure, expires, name, ...rest] = f;
      out.push({
        domain: domain.trim().toLowerCase().replace(/^\./, ''),
        subdomains: flag.toUpperCase() === 'TRUE' || domain.startsWith('.'),
        path: p.startsWith('/') ? p : '/',
        secure: secure.toUpperCase() === 'TRUE',
        expires: Number(expires) > 0 ? Math.floor(Number(expires)) : 0,
        name,
        value: rest.join('\t'),
      });
    }
  }
  // Only well-formed cookies: a real domain, and nothing that could break a header line.
  const bad = /[\r\n\0;]/;
  out = out.filter((c) => /^[a-z0-9.-]+$/.test(c.domain) && c.domain.includes('.') && c.name && !bad.test(c.name) && !/[\r\n\0]/.test(c.value));
  if (!out.length) throw new Error('No cookies were found. Use a cookies.txt file or a JSON export from a cookie extension.');
  if (out.length > MAX_COOKIES) throw new Error('That file has too many cookies.');
  return out;
}

function toNetscape(entries) {
  const lines = ['# Netscape HTTP Cookie File', '# Saved by Imadia. Keep this file private.'];
  for (const c of entries) {
    lines.push([(c.subdomains ? '.' : '') + c.domain, c.subdomains ? 'TRUE' : 'FALSE', c.path, c.secure ? 'TRUE' : 'FALSE', c.expires || 0, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

function summary(entries) {
  const counts = new Map();
  for (const c of entries) {
    const site = c.domain.split('.').slice(-2).join('.');
    counts.set(site, (counts.get(site) || 0) + 1);
  }
  return { count: entries.length, domains: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d]) => d) };
}

// ---- Choosing the source ------------------------------------------------------

export function cookieStatus() {
  const s = loadSettings();
  return { source: s.source, browser: s.browser || null, count: s.count || 0, domains: s.domains || [], updatedAt: s.updatedAt || null, browsers: BROWSERS };
}

export async function useCookieText(text) {
  const entries = parseCookies(text);
  await fsp.mkdir(dir(), { recursive: true, mode: 0o700 });
  await fsp.writeFile(cookieFile(), toNetscape(entries), { mode: 0o600 });
  await saveSettings({ source: 'file', ...summary(entries) });
  return cookieStatus();
}

export async function useBrowserCookies(browser) {
  if (!BROWSERS.includes(browser)) throw new Error('Unknown browser.');
  const entries = await exportBrowser(browser); // checks now that they can be read
  await saveSettings({ source: 'browser', browser, ...summary(entries) });
  cache = { at: Date.now(), entries };
  return cookieStatus();
}

export async function clearCookies() {
  await fsp.rm(cookieFile(), { force: true });
  await saveSettings({ source: 'none' });
  return cookieStatus();
}

// The desktop app's earlier YouTube menu kept its choice in settings.json: carry it over once.
export async function migrateOldSetting({ cookiesFromBrowser, cookiesFile } = {}) {
  if (loadSettings().source !== 'none') return;
  try {
    if (cookiesFromBrowser && BROWSERS.includes(cookiesFromBrowser)) {
      await saveSettings({ source: 'browser', browser: cookiesFromBrowser });
    } else if (cookiesFile) {
      await useCookieText(await fsp.readFile(cookiesFile, 'utf8'));
    }
  } catch {
    /* the old file is gone or unreadable: start without cookies */
  }
}

// ---- The cookies themselves -----------------------------------------------------

// A browser's cookies, read by yt-dlp and written to a private temporary file.
function exportBrowser(browser) {
  return new Promise((resolve, reject) => {
    fsp.mkdtemp(path.join(os.tmpdir(), 'imadia-cookies-')).then((tmp) => {
      const out = path.join(tmp, 'cookies.txt');
      let err = '';
      // yt-dlp saves its cookie jar when it exits, even though this address goes nowhere.
      const p = spawn(cfg.ytdlp, ['--ignore-config', '--no-warnings', '--cookies-from-browser', browser, '--cookies', out, '--simulate', 'http://0.0.0.0:9/'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
      const timer = setTimeout(() => p.kill('SIGKILL'), 60000);
      p.on('error', (e) => finish(e.message));
      p.on('close', () => finish(null));
      const finish = async (spawnError) => {
        clearTimeout(timer);
        let text = '';
        try {
          text = await fsp.readFile(out, 'utf8');
        } catch {
          /* nothing written */
        }
        await fsp.rm(tmp, { recursive: true, force: true });
        try {
          resolve(parseCookies(text));
        } catch {
          const why = (err.match(/ERROR: (.*)/g) || []).filter((l) => !/0\.0\.0\.0|Unable to download|Connection refused|Errno/i.test(l)).pop();
          reject(new Error(browserHelp(browser, (why || spawnError || '').replace(/^ERROR:\s*/, ''))));
        }
      };
    }, reject);
  });
}

function browserHelp(browser, detail) {
  const name = browser[0].toUpperCase() + browser.slice(1);
  let tip = `Make sure ${name} is installed and you have signed in to the site there.`;
  if (browser === 'safari') tip = 'macOS only lets apps read Safari cookies with Full Disk Access (System Settings › Privacy & Security › Full Disk Access › add Imadia).';
  else if (process.platform === 'win32' && browser !== 'firefox') tip = `Close ${name} completely and try again: Windows locks its cookies while it is open.`;
  else if (process.platform === 'darwin' && browser !== 'firefox') tip = `If macOS asks for permission to use "${name} Safe Storage", click Allow.`;
  return `Could not read ${name}'s cookies. ${tip}${detail ? ` (${detail})` : ''}`;
}

async function entries() {
  const s = loadSettings();
  if (s.source === 'file') {
    if (!cache) cache = { at: Date.now(), entries: parseCookies(await fsp.readFile(cookieFile(), 'utf8').catch(() => '')) };
    return cache.entries;
  }
  if (s.source === 'browser') {
    if (!cache || Date.now() - cache.at > BROWSER_CACHE_MS) cache = { at: Date.now(), entries: await exportBrowser(s.browser) };
    return cache.entries;
  }
  return [];
}

// Same rules as a browser: domain (and its subdomains when allowed), path, https-only, not expired.
function matches(c, u, now) {
  const host = u.hostname.toLowerCase();
  if (!(host === c.domain || (c.subdomains && host.endsWith('.' + c.domain)))) return false;
  if (c.secure && u.protocol !== 'https:') return false;
  if (c.expires && c.expires < now) return false;
  const p = u.pathname || '/';
  return p === c.path || p.startsWith(c.path.endsWith('/') ? c.path : c.path + '/');
}

async function matching(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const now = Date.now() / 1000;
  const list = await entries().catch(() => []);
  return list.filter((c) => matches(c, u, now)).sort((a, b) => b.path.length - a.path.length);
}

// "Cookie" header value for a request to `url` ('' if none).
export async function cookieHeaderFor(url) {
  return (await matching(url)).map((c) => `${c.name}=${c.value}`).join('; ');
}

// (Not given to FFmpeg: its -cookies option is ignored by the bundled build, and a plain Cookie
// header would go to every server a playlist names. The HLS method fetches each piece itself with
// the right cookies, and yt-dlp matches cookies per site.)

// For the page scanner's browser (it applies each cookie only to its own site).
export async function browserCookies() {
  const now = Date.now() / 1000;
  return (await entries().catch(() => []))
    .filter((c) => !c.expires || c.expires > now)
    .slice(0, 20000)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: (c.subdomains ? '.' : '') + c.domain,
      path: c.path,
      secure: c.secure,
      expires: c.expires || -1,
    }));
}

// yt-dlp arguments. It rewrites the cookie file it is given, so each run gets its own copy.
export async function ytdlpCookieArgs(workDir) {
  const s = loadSettings();
  if (s.source === 'browser') return ['--cookies-from-browser', s.browser];
  if (s.source === 'file') {
    const copy = path.join(workDir, 'cookies.txt');
    try {
      await fsp.copyFile(cookieFile(), copy);
      await fsp.chmod(copy, 0o600);
      return ['--cookies', copy];
    } catch {
      return [];
    }
  }
  return [];
}

export const usingCookies = () => loadSettings().source !== 'none';
