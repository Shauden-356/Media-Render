import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import scan from './api/scan.js';
import zip from './api/zip.js';
import preview from './api/preview.js';
import { startJob, jobStatus, jobFile, jobCancel } from './api/jobs.js';
import { initJobs } from './lib/jobs.js';
import { prepareScanner } from './lib/scanner.js';
import { cfg } from './lib/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// The page's own inline script, allowed by its hash (no other inline script can run).
const pageScripts = [...fs.readFileSync(path.join(here, 'public', 'index.html'), 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
  .join(' ');

// Starts the local server. Listens on this computer only (127.0.0.1), so downloads use
// the user's own internet connection and nothing is reachable from other machines.
// port 0 picks any free port. Resolves to the port actually used.
export async function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  const app = express();
  app.disable('x-powered-by');

  // Only the app's own page may use this server, not other websites open in the user's browser
  // (which could otherwise start downloads with the user's YouTube cookies, or read results):
  // - Host: a site pointing its own name at 127.0.0.1 (DNS rebinding) arrives with that name.
  // - Origin / Sec-Fetch-Site: requests and links from another site say where they come from.
  app.use((req, res, next) => {
    const port = req.socket.localPort;
    const self = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (
      !self.includes(req.headers.host) ||
      (origin && !self.some((h) => origin === `http://${h}`)) ||
      (site && site !== 'same-origin' && site !== 'none')
    ) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    // The page may not be framed by other sites, and only runs its own scripts.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' ${pageScripts}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ` +
        `font-src https://fonts.gstatic.com; img-src * data: blob:; connect-src 'self'; frame-ancestors 'none'; ` +
        `base-uri 'none'; form-action 'self'; object-src 'none'`
    );
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  const wrap = (handler) => (req, res) =>
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' });
      else res.destroy();
    });

  app.post('/api/scan', wrap(scan));
  app.post('/api/zip', wrap(zip));
  app.post('/api/preview', wrap(preview));
  app.post('/api/jobs', wrap(startJob));
  app.get('/api/jobs/:id', wrap(jobStatus));
  app.get('/api/jobs/:id/file', wrap(jobFile));
  app.delete('/api/jobs/:id', wrap(jobCancel));
  app.use(express.static(path.join(here, 'public')));

  await initJobs();
  prepareScanner(); // in the background

  // Sites change often; keep yt-dlp current (at start, then daily). Only when the app
  // manages its own yt-dlp copy; a system-wide install is left to its package manager.
  if (cfg.ytdlpSelfUpdate) {
    const update = () => spawn(cfg.ytdlp, ['-U'], { stdio: 'ignore' }).on('error', () => {});
    update();
    setInterval(update, 24 * 3600 * 1000).unref();
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server.address().port));
    server.on('error', reject);
    server.requestTimeout = 0; // long downloads are fine
  });
}

// `node server.js` runs it without the desktop window (open the printed address in a browser).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = await startServer({ port: Number(process.env.PORT) || 10000 });
  console.log(`Open http://localhost:${port}`);
}
