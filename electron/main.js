const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

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

async function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 1040,
    minWidth: 480,
    minHeight: 640,
    title: 'Clip Editor',
    backgroundColor: '#0e0e12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Explicit, not relying on Electron defaults (see security section 3).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  await waitForServer(`http://127.0.0.1:${PORT}/`);
  win.loadURL(`http://127.0.0.1:${PORT}/`);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
