import { assertPublicUrl } from '../lib/net.js';
import { scanPage } from '../lib/scanner.js';
import { cfg } from '../lib/config.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const raw = req.body?.url;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ error: 'Paste a page address first.' });
  }
  let start;
  try {
    start = (await assertPublicUrl(raw.trim())).href;
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    return res.status(200).json(await scanPage(start, Date.now() + cfg.scanBudgetMs));
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
}
