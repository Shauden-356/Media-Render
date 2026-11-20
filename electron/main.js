// Desktop app: runs the local server inside the app and shows the page in a window.
// Everything (page scans, FFmpeg, yt-dlp) runs on this computer with its own internet connection.
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForUpdates, startAutoUpdates } from './updater.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe = process.platform === 'win32' ? '.exe' : '';
// The download website (Help > Download Page).
const SITE = 'https://imadia.vercel.app/';

// The app was called "Media Zipper" before 7.0: keep using its settings folder (YouTube sign-in
// choice, yt-dlp copy, page-scanner browser) instead of starting over in a new "Imadia" folder.
// (Electron creates the new folder by itself early on, so look for the app's own files in it.)
{
  const old = path.join(app.getPath('appData'), 'Media Zipper');
  const now = app.getPath('userData');
  const used = (dir) => fs.existsSync(path.join(dir, 'bin')) || fs.existsSync(path.join(dir, 'settings.json'));
  if (!app.commandLine.hasSwitch('user-data-dir') && !used(now) && used(old)) app.setPath('userData', old);
}

if (!app.requestSingleInstanceLock()) app.quit();

// Bundled FFmpeg / yt-dlp: inside the installed app, or vendor/ when run from source.
const binDir = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(root, 'vendor', `${process.platform === 'win32' ? 'win' : 'mac'}-${process.arch}`);

function setUpBinaries() {
  // Where the page scanner's browser is downloaded if Chrome/Edge are missing.
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(app.getPath('userData'), 'browsers');

  const ffmpeg = path.join(binDir, 'ffmpeg' + exe);
  if (fs.existsSync(ffmpeg)) process.env.FFMPEG_PATH = ffmpeg;

  // yt-dlp updates itself, which needs a writable copy (the app folder may be read-only).
  const bundled = path.join(binDir, 'yt-dlp' + exe);
  const ownDir = path.join(app.getPath('userData'), 'bin');
  const own = path.join(ownDir, 'yt-dlp' + exe);
  if (!fs.existsSync(own) && fs.existsSync(bundled)) {
    fs.mkdirSync(ownDir, { recursive: true });
    fs.copyFileSync(bundled, own);
    fs.chmodSync(own, 0o755);
    if (process.platform === 'darwin') {
      try {
        execFileSync('xattr', ['-d', 'com.apple.quarantine', own], { stdio: 'ignore' });
      } catch {
        /* not quarantined */
      }
    }
  }
  if (fs.existsSync(own)) {
    process.env.YTDLP_PATH = own;
    process.env.YTDLP_SELF_UPDATE = '1';
  }
}

// The old YouTube menu kept its sign-in choice in settings.json; the Cookies panel replaces it.
function oldCookieSetting() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

let shutdownJobs = () => {};
let win;

// Opens the Cookies panel in the window (the page shows it when the address ends in #cookies).
function openCookies() {
  if (!win) return;
  win.show();
  win.webContents.executeJavaScript("location.hash = ''; location.hash = 'cookies';").catch(() => {});
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'Settings', submenu: [{ label: 'Cookies…', accelerator: 'CmdOrCtrl+Shift+K', click: openCookies }] },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Check for Updates…', click: () => checkForUpdates({ manual: true }) },
        { label: 'Download Page', click: () => shell.openExternal(SITE) },
        { type: 'separator' },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 720,
    minHeight: 500,
    title: 'Imadia',
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  });
  // The page needs no camera, microphone, location, notifications…
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  const home = `http://127.0.0.1:${port}/`;
  win.loadURL(home);

  // Links to other sites open in the normal browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(home)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // Finished videos and zips: ask where to save, starting in Downloads.
  win.webContents.session.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  try {
    setUpBinaries();
    process.env.DATA_DIR = app.getPath('userData'); // saved settings such as cookies
    const { migrateOldSetting } = await import('../lib/cookies.js');
    await migrateOldSetting(oldCookieSetting());
    buildMenu();
    ({ shutdownJobs } = await import('../lib/jobs.js'));
    const { startServer } = await import('../server.js');
    const port = await startServer();
    createWindow(port);
    startAutoUpdates(() => win);
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createWindow(port);
    });
  } catch (err) {
    dialog.showErrorBox('Imadia could not start', String(err?.stack || err));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => shutdownJobs());
