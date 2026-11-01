// Desktop app: runs the local server inside the app and shows the page in a window.
// Everything (page scans, FFmpeg, yt-dlp) runs on this computer with its own internet connection.
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe = process.platform === 'win32' ? '.exe' : '';

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

// Remembered choices (YouTube cookies).
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
}

let cfg;
let shutdownJobs = () => {};
let settings = {};
let win;

function applyCookies() {
  cfg.ytdlpCookiesFromBrowser = settings.cookiesFromBrowser || '';
  cfg.ytdlpCookies = settings.cookiesFile || '';
}

const BROWSERS = [
  ['chrome', 'Chrome'],
  ['firefox', 'Firefox'],
  ['edge', 'Microsoft Edge'],
  ['brave', 'Brave'],
  ...(process.platform === 'darwin' ? [['safari', 'Safari']] : []),
];

function setCookies(next) {
  settings = { ...settings, cookiesFromBrowser: '', cookiesFile: '', ...next };
  saveSettings(settings);
  applyCookies();
  buildMenu();
}

async function chooseCookiesFile() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose an exported cookies.txt',
    filters: [{ name: 'cookies.txt', extensions: ['txt'] }],
    properties: ['openFile'],
  });
  if (!r.canceled && r.filePaths[0]) setCookies({ cookiesFile: r.filePaths[0] });
  else buildMenu(); // undo the radio tick
}

function buildMenu() {
  const none = !settings.cookiesFromBrowser && !settings.cookiesFile;
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'YouTube',
      submenu: [
        { label: 'If YouTube asks you to sign in, pick the browser you are signed in with:', enabled: false },
        { label: 'No sign-in', type: 'radio', checked: none, click: () => setCookies({}) },
        ...BROWSERS.map(([id, label]) => ({
          label: `Use my ${label} sign-in`,
          type: 'radio',
          checked: settings.cookiesFromBrowser === id,
          click: () => setCookies({ cookiesFromBrowser: id }),
        })),
        {
          label: settings.cookiesFile ? `Use cookies.txt (${path.basename(settings.cookiesFile)})` : 'Use a cookies.txt file…',
          type: 'radio',
          checked: !!settings.cookiesFile,
          click: chooseCookiesFile,
        },
        { type: 'separator' },
        { label: 'Close that browser first if it is open, or the sign-in cannot be read.', enabled: false },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 720,
    minHeight: 500,
    title: 'Media Zipper',
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
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
    ({ cfg } = await import('../lib/config.js'));
    settings = loadSettings();
    applyCookies();
    buildMenu();
    ({ shutdownJobs } = await import('../lib/jobs.js'));
    const { startServer } = await import('../server.js');
    const port = await startServer();
    createWindow(port);
    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createWindow(port);
    });
  } catch (err) {
    dialog.showErrorBox('Media Zipper could not start', String(err?.stack || err));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => shutdownJobs());
