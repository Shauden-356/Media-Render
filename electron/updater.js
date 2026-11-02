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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import updaterPkg from 'electron-updater';

const REPO = 'Shauden-356/Media-Render';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY = 6 * 3600_000;

let getWindow = () => null;
let busy = false;
let ready = null; // { version, install(relaunch) } once an update is downloaded

const newer = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function askToRestart(version) {
  const { response } = await dialog.showMessageBox(getWindow(), {
    type: 'info',
    message: `Media Zipper ${version} is ready`,
    detail: 'Restart now to use the new version, or it will be installed the next time you quit.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) ready.install(true);
}

// ---- macOS ----------------------------------------------------------------

const appBundle = () => path.resolve(app.getPath('exe'), '../../..'); // …/Media Zipper.app

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

async function checkMac(manual) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Media-Zipper-updater' },
  });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/, '');
  if (!newer(version, app.getVersion())) return manual && upToDate();

  // Only this repo's own release files (GitHub's download address for them).
  const asset = rel.assets.find(
    (a) =>
      a.name === `Media-Zipper-mac-${process.arch}.zip` &&
      String(a.browser_download_url).startsWith(`https://github.com/${REPO}/releases/download/`)
  );
  if (!asset || !canReplaceApp()) {
    // Can't swap the app in place: point to the download instead.
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'info',
      message: `Media Zipper ${version} is available`,
      detail: canReplaceApp()
        ? 'Download it from the releases page.'
        : 'Move Media Zipper into your Applications folder to get updates automatically. For now, download the new version from the releases page.',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(RELEASES);
    return;
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'media-zipper-update-'));
  const zip = path.join(dir, asset.name);
  const dl = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'Media-Zipper-updater' } });
  if (!dl.ok) throw new Error(`Download answered HTTP ${dl.status}`);
  await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(zip));
  if ((await fsp.stat(zip)).size !== asset.size) throw new Error('The update download was incomplete.');
  await promisify(execFile)('/usr/bin/ditto', ['-x', '-k', zip, dir]);
  const newApp = path.join(dir, 'Media Zipper.app');
  await fsp.access(newApp);

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
  }
  return new Promise((resolve, reject) => {
    const done = () => {
      winUpdater.removeListener('update-not-available', none);
      winUpdater.removeListener('update-downloaded', got);
      winUpdater.removeListener('error', fail);
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
    message: 'Media Zipper is up to date',
    detail: `You have version ${app.getVersion()}.`,
  });
}

export async function checkForUpdates({ manual = false } = {}) {
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox(getWindow(), { message: 'Updates only work in the installed app.' });
    return;
  }
  if (ready) return manual && askToRestart(ready.version);
  if (busy) return;
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
  setTimeout(() => checkForUpdates(), 10_000);
  setInterval(() => checkForUpdates(), CHECK_EVERY).unref();
}
