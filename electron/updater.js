// Automatic updates from the GitHub releases of this repo.
// Windows: electron-updater downloads the new installer in the background and installs it on restart.
// macOS: Apple's updater only accepts apps signed with a paid Apple certificate, so here the new
// build's .zip is downloaded, unpacked, and swapped in for the old app when it quits.
import { app, dialog, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import updaterPkg from 'electron-updater';

// The repo is being renamed from Media-Render to Imadia: try the new name first, and accept
// release files under either (GitHub forwards the old name after a rename).
const REPOS = ['Shauden-356/Imadia', 'Shauden-356/Media-Render'];
const RELEASES = `https://github.com/${REPOS[0]}/releases/latest`;
const CHECK_EVERY = 6 * 3600_000;
const FIRST_CHECK = 3000;

let getWindow = () => null;
let busy = false;
let ready = null; // { version, install(relaunch) } once an update is downloaded
let downloading = null; // { version, done, total } while an update downloads

// Download progress on the Dock / taskbar icon (-1 removes it).
function showProgress(fraction) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.setProgressBar(fraction);
}

// Tells the user straight away that an update is on its way (without waiting on it).
function announceDownload(version) {
  dialog.showMessageBox(getWindow(), {
    type: 'info',
    message: `Downloading Imadia ${version}…`,
    detail: 'You can keep using the app. It will ask you to restart when the update is ready.',
  });
}

const newer = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function askToRestart(version) {
  const { response } = await dialog.showMessageBox(getWindow(), {
    type: 'info',
    message: `Imadia ${version} is ready`,
    detail: 'Restart now to use the new version, or it will be installed the next time you quit.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) ready.install(true);
}

// ---- macOS ----------------------------------------------------------------

const appBundle = () => path.resolve(app.getPath('exe'), '../../..'); // …/Imadia.app (or "Media Zipper.app" for copies installed before 7.0)

function canReplaceApp() {
  const bundle = appBundle();
  // Opened straight from the .dmg or Downloads, macOS runs a read-only copy ("translocation").
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return false;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function latestRelease() {
  let status = 0;
  for (const repo of REPOS) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Imadia-updater' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return res.json();
    status = res.status;
    if (res.status !== 404) break;
  }
  throw new Error(`GitHub answered HTTP ${status}`);
}

async function checkMac(manual) {
  const rel = await latestRelease();
  const version = String(rel.tag_name || '').replace(/^v/, '');
  if (!newer(version, app.getVersion())) return manual && upToDate();

  // Only this repo's own release files (GitHub's download address for them).
  const asset = rel.assets.find(
    (a) =>
      a.name === `Imadia-mac-${process.arch}.zip` &&
      REPOS.some((repo) => String(a.browser_download_url).startsWith(`https://github.com/${repo}/releases/download/`))
  );
  if (!asset || !canReplaceApp()) {
    // Can't swap the app in place: point to the download instead.
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'info',
      message: `Imadia ${version} is available`,
      detail: canReplaceApp()
        ? 'Download it from the releases page.'
        : 'Move Imadia into your Applications folder to get updates automatically. For now, download the new version from the releases page.',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(RELEASES);
    return;
  }

  if (manual) announceDownload(version);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imadia-update-'));
  const zip = path.join(dir, asset.name);
  const dl = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'Imadia-updater' } });
  if (!dl.ok) throw new Error(`Download answered HTTP ${dl.status}`);
  downloading = { version, done: 0, total: asset.size };
  const count = new Transform({
    transform(chunk, _enc, cb) {
      downloading.done += chunk.length;
      showProgress(downloading.done / downloading.total);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(dl.body), count, fs.createWriteStream(zip));
  } finally {
    downloading = null;
    showProgress(-1);
  }
  if ((await fsp.stat(zip)).size !== asset.size) throw new Error('The update download was incomplete.');
  await promisify(execFile)('/usr/bin/ditto', ['-x', '-k', zip, dir]);
  // The app inside the zip (it is swapped in under the current app's own name and place).
  const bundle = (await fsp.readdir(dir)).find((f) => f.endsWith('.app'));
  if (!bundle) throw new Error('The update download has no app in it.');
  const newApp = path.join(dir, bundle);

  // A small script swaps the apps after this one has exited, then optionally reopens it.
  const script = path.join(dir, 'install.sh');
  await fsp.writeFile(
    script,
    [
      '#!/bin/sh',
      'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done',
      'rm -rf "$2" && mv "$3" "$2"',
      'xattr -dr com.apple.quarantine "$2" 2>/dev/null',
      'if [ "$4" = 1 ]; then open "$2"; fi',
      'rm -rf "$5"',
    ].join('\n'),
    { mode: 0o755 }
  );
  let installed = false;
  ready = {
    version,
    install(relaunch) {
      if (installed) return;
      installed = true;
      spawn('/bin/sh', [script, String(process.pid), appBundle(), newApp, relaunch ? '1' : '0', dir], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      if (relaunch) app.quit();
    },
  };
  app.on('will-quit', () => ready?.install(false));
  await askToRestart(version);
}

// ---- Windows --------------------------------------------------------------

let winUpdater;
function checkWindows(manual) {
  if (!winUpdater) {
    winUpdater = updaterPkg.autoUpdater;
    winUpdater.autoDownload = true;
    winUpdater.autoInstallOnAppQuit = true;
    winUpdater.on('download-progress', (p) => {
      if (downloading) downloading.done = p.transferred;
      showProgress(p.percent / 100);
    });
  }
  return new Promise((resolve, reject) => {
    const done = () => {
      downloading = null;
      showProgress(-1);
      winUpdater.removeListener('update-available', found);
      winUpdater.removeListener('update-not-available', none);
      winUpdater.removeListener('update-downloaded', got);
      winUpdater.removeListener('error', fail);
    };
    const found = (info) => {
      downloading = { version: info.version, done: 0, total: info.files?.[0]?.size || 0 };
      if (manual) announceDownload(info.version);
    };
    const none = () => {
      done();
      resolve(manual && upToDate());
    };
    const got = (info) => {
      done();
      ready = { version: info.version, install: () => winUpdater.quitAndInstall(true, true) }; // silent install, then reopen
      resolve(askToRestart(info.version));
    };
    const fail = (err) => {
      done();
      reject(err);
    };
    winUpdater.on('update-available', found);
    winUpdater.on('update-not-available', none);
    winUpdater.on('update-downloaded', got);
    winUpdater.on('error', fail);
    winUpdater.checkForUpdates().catch(fail);
  });
}

// ---------------------------------------------------------------------------

function upToDate() {
  return dialog.showMessageBox(getWindow(), {
    type: 'info',
    message: 'Imadia is up to date',
    detail: `You have version ${app.getVersion()}.`,
  });
}

export async function checkForUpdates({ manual = false } = {}) {
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox(getWindow(), { message: 'Updates only work in the installed app.' });
    return;
  }
  if (ready) return manual && askToRestart(ready.version);
  if (busy) {
    // A check (often the automatic one) is already running: say what it is doing.
    if (manual) {
      const d = downloading;
      dialog.showMessageBox(getWindow(), {
        type: 'info',
        message: d ? `Downloading Imadia ${d.version}…` : 'Checking for updates…',
        detail: d && d.total ? `${Math.round((d.done / d.total) * 100)}% done. It will ask you to restart when it's ready.` : 'This takes a few seconds.',
      });
    }
    return;
  }
  busy = true;
  try {
    if (process.platform === 'darwin') await checkMac(manual);
    else if (process.platform === 'win32') await checkWindows(manual);
  } catch (err) {
    console.error('Update check failed:', err);
    if (manual) dialog.showErrorBox('Could not check for updates', String(err?.message || err));
  } finally {
    busy = false;
  }
}

export function startAutoUpdates(windowGetter) {
  getWindow = windowGetter;
  setTimeout(() => checkForUpdates(), FIRST_CHECK);
  setInterval(() => checkForUpdates(), CHECK_EVERY).unref();
}
