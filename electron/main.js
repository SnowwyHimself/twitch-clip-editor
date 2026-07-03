const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');

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

require('../server.js');

function waitForServer(url, attemptsLeft = 100) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
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
  });

  await waitForServer(`http://localhost:${PORT}/`);
  win.loadURL(`http://localhost:${PORT}/`);
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
