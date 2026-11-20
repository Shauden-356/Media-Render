import { clearCookies, cookieStatus, useBrowserCookies, useCookieText } from '../lib/cookies.js';

// The sign-in cookies setting. Cookie values never leave the app: only which source is used,
// how many cookies there are and for which sites.

// GET /api/cookies  ->  { source: 'none'|'browser'|'file', browser, count, domains, updatedAt, browsers }
export function cookiesGet(req, res) {
  return res.json(cookieStatus());
}

// PUT /api/cookies  { browser }  or  { text }  (cookies.txt or a JSON export, pasted or from a file)
export async function cookiesPut(req, res) {
  const b = req.body || {};
  try {
    if (typeof b.browser === 'string') return res.json(await useBrowserCookies(b.browser));
    if (typeof b.text === 'string') return res.json(await useCookieText(b.text));
    return res.status(400).json({ error: 'Choose a browser or give a cookie file.' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// DELETE /api/cookies  ->  stop using cookies and delete the saved copy.
export async function cookiesDelete(req, res) {
  return res.json(await clearCookies());
}
