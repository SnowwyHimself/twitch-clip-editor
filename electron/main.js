const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const updater = require('./updater');

// A dedicated port, distinct from the plain `npm start` dev server's 3000,
// so the packaged app never collides with a dev instance running locally.
const PORT = 4173;
process.env.PORT = String(PORT);

// Job data (uploads/downloads/outputs/captions) must live somewhere
// writable — the app bundle itself is read-only once packaged.
process.env.CLIP_EDITOR_DATA_DIR = app.getPath('userData');

// ffmpeg/yt-dlp ship as extraResources (real files, not inside the asar
// archive, since spawn() needs an actual executable on disk). In dev mode
// (running `electron .` straight from the source tree, not a packaged
// app), process.resourcesPath doesn't have a bin/ folder, so server.js's
// own resolveBinary() falls through to PATH — that's fine for local
// testing where ffmpeg/yt-dlp are already installed.
process.env.CLIP_EDITOR_RESOURCES = process.resourcesPath;

// Per-run secret that authenticates the renderer to the local server. Generated
// HERE (main process), handed to the server via env BEFORE requiring it, and to
// the renderer via the preload/contextBridge (never a query string). Every
// request the renderer makes then carries it (see server.js token guard).
const APP_TOKEN = crypto.randomBytes(32).toString('hex');
process.env.CLIP_EDITOR_TOKEN = APP_TOKEN;

require('../server.js');

// The preload asks for the token synchronously at init (contextBridge delivery).
ipcMain.on('clip:get-token', (event) => {
  event.returnValue = APP_TOKEN;
});

const PREVIEW_CACHE_DIR = path.join(app.getPath('userData'), 'preview-cache');

// Replacement for the deleted /api/preview-file HTTP endpoint: reopening a
// file-based project. The absolute path comes from the user's own saved project
// JSON; because this is IPC (only our renderer can call it, never a website) and
// the MAIN process — not the HTTP server — touches the path, the any-file-read
// web primitive is gone. Validated: must be an existing regular file.
// Open the personal asset library folder in Finder/Explorer (Settings → Your
// library). Path is app-derived (userData), never renderer input.
ipcMain.handle('library:open-folder', async () => {
  const dir = path.join(app.getPath('userData'), 'library');
  try {
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('reopen-file', async (_event, absPath) => {
  if (typeof absPath !== 'string' || !absPath) return { ok: false, reason: 'bad-path' };
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
  try {
    fs.mkdirSync(PREVIEW_CACHE_DIR, { recursive: true });
    const key = crypto.createHash('sha1').update(path.resolve(absPath)).digest('hex');
    const ext = path.extname(absPath) || '.mp4';
    const dest = path.join(PREVIEW_CACHE_DIR, `${key}${ext}`);
    if (!fs.existsSync(dest)) fs.copyFileSync(absPath, dest);
    return { ok: true, previewUrl: `/preview-cache/${key}${ext}` };
  } catch (err) {
    return { ok: false, reason: String(err && err.message) };
  }
});

function waitForServer(url, attemptsLeft = 100) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      // The server now 403s requests without the token, but ANY HTTP response
      // (including 403) means it's listening — which is all we're waiting for.
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (attemptsLeft <= 0) {
            reject(new Error('Server did not start in time'));
            return;
          }
          attemptsLeft -= 1;
          setTimeout(attempt, 100);
        });
    };
    attempt();
  });
}

const APP_ORIGIN = `http://127.0.0.1:${PORT}`;

// The ONLY external destinations allowed to open (in the system browser, never
// in-app): our own GitHub repo/releases. Everything else is denied.
function isAllowedExternal(url) {
  try {
    const u = new URL(url);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      u.hostname === 'github.com' &&
      u.pathname.startsWith('/SnowwyHimself/twitch-clip-editor')
    );
  } catch {
    return false;
  }
}

function lockDownNavigation(contents) {
  // Deny opening any new window/tab; route an allowed GitHub link to the OS
  // browser via shell.openExternal (http/https only), deny the rest.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Deny navigating the app window away from our own origin. An allowed external
  // link opens in the OS browser instead; nothing else navigates at all.
  contents.on('will-navigate', (event, url) => {
    if (url === `${APP_ORIGIN}/` || url.startsWith(`${APP_ORIGIN}/`)) return;
    event.preventDefault();
    if (isAllowedExternal(url)) shell.openExternal(url);
  });
  // Belt-and-suspenders: never attach a webview.
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 1040,
    minWidth: 480,
    minHeight: 640,
    title: 'Clip Editor',
    backgroundColor: '#0e0e12',
    // Window/taskbar icon (dev + Win/Linux). The packaged app icon comes from
    // build/icon.icns|ico via electron-builder; a missing path here is ignored.
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Explicit, not relying on Electron defaults (see security section 3).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  lockDownNavigation(win.webContents);
  updater.init(win); // quiet auto-update: checks on launch + every 4h, shows the pill
  await waitForServer(`${APP_ORIGIN}/`);
  win.loadURL(`${APP_ORIGIN}/`);
  return win;
}

// App menu: version (About), a manual "Check for Updates" with up-to-date
// feedback, and an "Automatic updates" toggle (default on). No other UI.
function buildMenu() {
  const autoItem = {
    label: 'Automatic Updates',
    type: 'checkbox',
    checked: readAutoUpdate(),
    click: (item) => writeAutoUpdate(item.checked),
  };
  const checkItem = {
    label: 'Check for Updates…',
    click: async () => {
      const r = await updater.checkNow();
      const win = BrowserWindow.getAllWindows()[0];
      const msg = r.ok ? "You're up to date (or an update is downloading quietly)." : `Update check failed: ${r.error}`;
      if (win) {
        dialog.showMessageBox(win, { type: 'info', title: 'Clip Editor', message: `Clip Editor ${app.getVersion()}`, detail: msg, buttons: ['OK'] });
      }
    },
  };
  const appMenu = {
    label: app.name,
    submenu: [
      { role: 'about', label: `About Clip Editor (${app.getVersion()})` },
      { type: 'separator' },
      checkItem,
      autoItem,
      { type: 'separator' },
      { role: 'quit' },
    ],
  };
  const template = process.platform === 'darwin' ? [appMenu, { role: 'editMenu' }, { role: 'windowMenu' }] : [{ label: 'File', submenu: [checkItem, autoItem, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// The auto-update toggle is persisted by the updater module; read/write it via a
// tiny local mirror so the menu checkbox reflects it without a round-trip.
const UPDATE_SETTINGS_FILE = path.join(app.getPath('userData'), 'update-settings.json');
function readAutoUpdate() {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_SETTINGS_FILE, 'utf8')).autoUpdate !== false;
  } catch {
    return true;
  }
}
function writeAutoUpdate(on) {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(UPDATE_SETTINGS_FILE, 'utf8'));
  } catch {}
  try {
    fs.writeFileSync(UPDATE_SETTINGS_FILE, JSON.stringify({ ...cur, autoUpdate: !!on }));
  } catch {}
}

app.whenReady().then(() => {
  createWindow();
  buildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
