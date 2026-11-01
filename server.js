import { spawn } from 'node:child_process';
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

// Starts the local server. Listens on this computer only (127.0.0.1), so downloads use
// the user's own internet connection and nothing is reachable from other machines.
// port 0 picks any free port. Resolves to the port actually used.
export async function startServer({ port = 0, host = '127.0.0.1' } = {}) {
  const app = express();
  app.disable('x-powered-by');
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
