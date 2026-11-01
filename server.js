import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import scan from './api/scan.js';
import zip from './api/zip.js';
import { startJob, jobStatus, jobFile, jobCancel } from './api/jobs.js';
import { initJobs } from './lib/jobs.js';
import { cfg } from './lib/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Optional password (HTTP Basic auth). Set APP_PASSWORD on Render; any username works.
const password = process.env.APP_PASSWORD;
if (password) {
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && token) {
      const given = Buffer.from(token, 'base64').toString().split(':').slice(1).join(':');
      if (crypto.timingSafeEqual(digest(given), digest(password))) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Media Zipper"').status(401).send('Password required.');
  });
}

// Handlers use the same (req, res) shape as Vercel functions, which Express matches.
const wrap = (handler) => (req, res) =>
  Promise.resolve(handler(req, res)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on the server.' });
    else res.destroy();
  });

app.post('/api/scan', wrap(scan));
app.post('/api/zip', wrap(zip));
app.post('/api/jobs', wrap(startJob));
app.get('/api/jobs/:id', wrap(jobStatus));
app.get('/api/jobs/:id/file', wrap(jobFile));
app.delete('/api/jobs/:id', wrap(jobCancel));
app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.use(express.static(path.join(here, 'public')));

await initJobs();

// Sites change often; keep yt-dlp current (at boot, then daily).
const updateYtdlp = () => {
  if (!process.env.YTDLP_PATH) return;
  spawn(cfg.ytdlp, ['-U'], { stdio: 'ignore' }).on('error', () => {});
};
updateYtdlp();
setInterval(updateYtdlp, 24 * 3600 * 1000).unref();

const port = Number(process.env.PORT) || 10000;
const server = app.listen(port, '0.0.0.0', () => console.log(`Listening on ${port}`));
server.requestTimeout = 0; // long downloads are fine
server.headersTimeout = 65_000;
server.keepAliveTimeout = 65_000;
