import { assertPublicUrl } from '../lib/net.js';
import { createJob, getJob, cancelJob, publicJob } from '../lib/jobs.js';

const METHODS = new Set(['auto', 'hls', 'direct', 'ytdlp', 'ffmpeg']);
const CONTAINERS = new Set(['mp4', 'mkv']);

// POST /api/jobs  { url, page?, method?, container?, name? }  ->  { id, status, ... }
export async function startJob(req, res) {
  const b = req.body || {};
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  try {
    await assertPublicUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const page = typeof b.page === 'string' && /^https?:\/\//i.test(b.page) ? b.page : undefined;
  const method = METHODS.has(b.method) ? b.method : 'auto';
  const container = CONTAINERS.has(b.container) ? b.container : 'mp4';
  const name = typeof b.name === 'string' ? b.name : '';
  try {
    const job = createJob({ url, page, method, container, name });
    return res.status(202).json(publicJob(job));
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
}

export function jobStatus(req, res) {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'That download was not found. It may have expired.' });
  return res.json(publicJob(job));
}

export function jobFile(req, res) {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'That download was not found. It may have expired.' });
  if (job.status !== 'done' || !job.file) return res.status(409).json({ error: 'The file is not ready yet.' });
  // res.download supports Range requests, so interrupted downloads can resume.
  return res.download(job.file, job.filename, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: 'Could not send the file.' });
  });
}

export function jobCancel(req, res) {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'That download was not found.' });
  cancelJob(job);
  return res.json(publicJob(job));
}
