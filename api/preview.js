import { previewOf } from '../lib/preview.js';

// POST /api/preview  { url, page? }  ->  { title?, duration?, width?, height?, thumb? }
// thumb is an image address or a data: URL. Missing fields mean they couldn't be found.
export default async function handler(req, res) {
  const { url, page } = req.body || {};
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'A video address is required.' });
  }
  const ref = typeof page === 'string' && /^https?:\/\//i.test(page) ? page : undefined;
  return res.json(await previewOf(url, ref));
}
