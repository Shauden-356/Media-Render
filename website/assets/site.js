// Imadia download page: picks the right installer for this computer, shows the Terms before any
// download starts, and fills in the latest version and file sizes from GitHub.
(() => {
  'use strict';

  const REPO = 'Shauden-356/Media-Render';
  const FILES = {
    macArm: { file: 'Imadia-mac-arm64.dmg', label: 'Download for Mac (Apple silicon)', system: 'a Mac with Apple silicon' },
    macIntel: { file: 'Imadia-mac-x64.dmg', label: 'Download for Mac (Intel)', system: 'a Mac with an Intel processor' },
    win: { file: 'Imadia-win-x64.exe', label: 'Download for Windows', system: 'Windows' },
    android: { file: 'Imadia-android-arm64.apk', label: 'Download for Android', system: 'Android phones and tablets' },
    androidAny: { file: 'Imadia-android.apk', label: 'Download for Android', system: 'any Android device' },
  };
  const ALLOWED = new Set(Object.values(FILES).map((f) => f.file));
  const downloadUrl = (file) => `https://github.com/${REPO}/releases/latest/download/${encodeURIComponent(file)}`;
  const $ = (id) => document.getElementById(id);
  let androidMissing = false; // the latest release has no Android app yet

  // Until a release includes the Android app, its buttons say so instead of leading nowhere.
  function markAndroidMissing() {
    if (!androidMissing) return;
    for (const b of document.querySelectorAll('button[data-file^="Imadia-android"]')) {
      b.disabled = true;
      b.dataset.file = '';
      const size = b.querySelector('.size');
      if (size) size.textContent = 'Coming soon';
      if (b.id === 'primary') b.textContent = 'Android version coming soon';
    }
  }

  // ---- Which computer is this? ------------------------------------------------

  // Mac processor: Chrome and Edge say it outright; otherwise the graphics chip's name tells
  // (Apple M… = Apple silicon; Intel/AMD = Intel Mac). Most Macs sold since 2020 are Apple silicon.
  async function macKind() {
    try {
      if (navigator.userAgentData?.getHighEntropyValues) {
        const { architecture } = await navigator.userAgentData.getHighEntropyValues(['architecture']);
        if (architecture === 'arm') return { key: 'macArm', sure: true };
        if (architecture === 'x86') return { key: 'macIntel', sure: true };
      }
    } catch { /* not available */ }
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      if (/Apple M\d/i.test(gpu)) return { key: 'macArm', sure: true };
      if (/Intel|AMD|Radeon|NVIDIA/i.test(gpu)) return { key: 'macIntel', sure: true };
    } catch { /* no WebGL */ }
    return { key: 'macArm', sure: false };
  }

  async function detect() {
    const ua = navigator.userAgent || '';
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    const touchMac = /Mac/i.test(platform) && navigator.maxTouchPoints > 1; // iPad asking for the desktop site
    if (/iPhone|iPad|iPod/i.test(ua) || touchMac) return { key: null, why: "Apple doesn't allow apps like Imadia on iPhone and iPad. It's available for Android, Mac and Windows." };
    if (/Android/i.test(ua)) {
      // 64-bit ARM covers nearly every phone; anything else gets the version that runs everywhere.
      const arch = /aarch64|arm64|armv8/i.test(ua + platform) || !/armv7|i686|x86/i.test(ua + platform) ? 'android' : 'androidAny';
      return { key: arch, sure: true };
    }
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return { key: 'win', sure: true };
    if (/Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua)) return macKind();
    if (/Linux|X11|CrOS/i.test(platform + ua)) return { key: null, why: 'Imadia is not available for Linux or ChromeOS yet. The Mac and Windows downloads are below.' };
    return { key: null, why: 'Pick your system below.' };
  }

  // ---- Terms before every download ---------------------------------------------

  const dialog = $('terms');
  const agree = $('agree');
  const go = $('go');
  let pending = '';

  function askFirst(file) {
    if (!ALLOWED.has(file)) return;
    pending = file;
    agree.checked = false;
    go.disabled = true;
    $('termsFile').textContent = file;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  agree.addEventListener('change', () => { go.disabled = !agree.checked; });
  go.addEventListener('click', () => {
    if (!agree.checked || !ALLOWED.has(pending)) return;
    const file = pending;
    pending = '';
    dialog.close();
    window.location.assign(downloadUrl(file));
  });
  dialog.addEventListener('close', () => { pending = ''; });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-file]');
    if (!btn) return;
    if (btn.dataset.file) askFirst(btn.dataset.file);
    else $('downloads').scrollIntoView({ behavior: 'smooth' });
  });

  // ---- Start -------------------------------------------------------------------

  detect().then((d) => {
    const primary = $('primary');
    const note = $('detected');
    if (!d.key) {
      note.textContent = d.why;
      primary.textContent = 'See all downloads';
      return;
    }
    const f = FILES[d.key];
    primary.dataset.file = f.file;
    primary.textContent = f.label;
    note.textContent = d.sure
      ? `For ${f.system}. Other systems are listed below.`
      : `For ${f.system}. On an Intel Mac, choose "Mac with Intel" below.`;
    markAndroidMissing(); // in case the release check finished first
  });

  // Latest version and sizes (only text from GitHub's answer is shown, never markup).
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      if (!rel || typeof rel.tag_name !== 'string') return;
      const version = rel.tag_name.replace(/^v/, '').replace(/[^0-9A-Za-z.\-]/g, '').slice(0, 20);
      const date = new Date(rel.published_at);
      $('meta').textContent = `Version ${version}` + (isNaN(date) ? '' : ` · released ${date.toLocaleDateString(undefined, { dateStyle: 'long' })}`);
      const names = new Set((Array.isArray(rel.assets) ? rel.assets : []).map((a) => a.name));
      if (![...names].some((n) => n.startsWith('Imadia-android'))) {
        androidMissing = true;
        markAndroidMissing();
      }
      for (const a of Array.isArray(rel.assets) ? rel.assets : []) {
        if (!ALLOWED.has(a.name) || !Number.isFinite(a.size)) continue;
        const el = document.querySelector(`[data-size="${CSS.escape(a.name)}"]`);
        if (el) el.textContent = `${Math.round(a.size / 1048576)} MB`;
      }
    })
    .catch(() => { /* offline or rate-limited: the page works without it */ });
})();
