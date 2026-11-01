import dns from 'node:dns/promises';
import net from 'node:net';

const UA = 'Mozilla/5.0 (compatible; MediaZipper/1.0)';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) {
    const rest = l.slice(7);
    return rest.includes('.') ? isPrivateIp(rest) : true;
  }
  return l === '::' || l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

export async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Only http and https addresses are supported.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('That address is not publicly reachable.');
  }
  return u;
}

// fetch() that re-checks every redirect hop against the public-address rule.
export async function safeFetch(raw, { referer, timeout = 15000, accept = '*/*', range } = {}) {
  let url = raw;
  for (let hop = 0; hop <= 5; hop++) {
    const u = await assertPublicUrl(url);
    const res = await fetch(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      headers: {
        'user-agent': UA,
        accept,
        ...(referer ? { referer } : {}),
        ...(range ? { range } : {}),
      },
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      res.body?.cancel();
      url = new URL(loc, u).href;
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects.');
}
