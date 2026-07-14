// Quiet auto-update: no dialogs, no progress bars, no forced quits. The only
// visible artifact is a small "Relaunch to update" pill the renderer shows once
// an update is downloaded, verified, and ready. If the user never clicks it, the
// update applies on the next normal quit. The update check is the app's ONLY
// background network activity.
//
// Windows: electron-updater (NSIS differential download + quitAndInstall).
// macOS (unsigned): the official Squirrel.Mac path needs code signing, so this
// implements the unsigned-safe equivalent — download the zip build, verify its
// SHA-512 against the published feed, stage it, and swap the .app bundle via a
// small detached helper on relaunch/quit, with a DMG fallback. Structured so that
// adding real signing later switches macOS to the official electron-updater flow
// by config, not a rewrite.

const { app, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = { owner: 'SnowwyHimself', repo: 'twitch-clip-editor' };
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4 hours
const SETTINGS_FILE = path.join(app.getPath('userData'), 'update-settings.json');
const STAGE_DIR = path.join(app.getPath('userData'), 'pending-update');

let mainWindow = null;
let checkTimer = null;
let readyVersion = null; // set once an update is downloaded + verified
let macStagedZip = null; // path to the verified staged zip (mac)
let applying = false;

// --- tiny persisted settings (auto-update on/off) ---------------------------
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next));
  } catch {
    /* best effort */
  }
  return next;
}
function autoUpdateEnabled() {
  const s = loadSettings();
  return s.autoUpdate !== false; // default ON
}

// --- helpers ----------------------------------------------------------------
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// Minimal GET that follows GitHub's redirect to the asset CDN. Resolves to a
// Buffer (small files) — used for the update feed only.
function httpGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'clip-editor-updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          return resolve(httpGet(res.headers.location, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

// Streams a (large) download to a file, following redirects, and returns the
// file's base64 SHA-512 for verification.
function downloadToFile(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'clip-editor-updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          return resolve(downloadToFile(res.headers.location, dest, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const hash = crypto.createHash('sha512');
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => hash.update(c));
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(hash.digest('base64'))));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

function notifyRenderer(version) {
  readyVersion = version;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:ready', version);
  }
}

// --- macOS: unsigned download-verify-swap -----------------------------------
// Parses only the two fields we need out of latest-mac.yml (the electron-builder
// update feed) without a YAML dependency.
function parseMacFeed(yml) {
  const version = (yml.match(/^version:\s*(.+)$/m) || [])[1];
  // Prefer the .zip entry (what we swap); fall back to top-level path/sha512.
  const zipBlock = yml.match(/-\s*url:\s*(\S+\.zip)[\s\S]*?sha512:\s*(\S+)/);
  const url = zipBlock ? zipBlock[1] : (yml.match(/^path:\s*(\S+\.zip)$/m) || [])[1];
  const sha512 = zipBlock ? zipBlock[2] : (yml.match(/^sha512:\s*(\S+)$/m) || [])[1];
  return version && url && sha512 ? { version: version.trim(), url: url.trim(), sha512: sha512.trim() } : null;
}

async function checkMac() {
  const feedUrl = `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest/download/latest-mac.yml`;
  const feed = parseMacFeed((await httpGet(feedUrl)).toString('utf8'));
  if (!feed) throw new Error('could not parse mac update feed');
  if (cmpVersion(feed.version, app.getVersion()) <= 0) return; // already current
  if (readyVersion === feed.version && macStagedZip && fs.existsSync(macStagedZip)) {
    return notifyRenderer(feed.version); // already staged this version
  }
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const zipPath = path.join(STAGE_DIR, feed.url);
  const assetUrl = `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest/download/${feed.url}`;
  const gotSha = await downloadToFile(assetUrl, zipPath);
  if (gotSha !== feed.sha512) {
    // Corrupted/substituted download — discard, ship nothing.
    fs.rmSync(STAGE_DIR, { recursive: true, force: true });
    throw new Error('mac update checksum mismatch');
  }
  macStagedZip = zipPath;
  notifyRenderer(feed.version); // only NOW does the pill appear
}

// Detached helper: waits for THIS app to exit, unzips the staged build, swaps the
// installed .app bundle (backing up the old one, restoring on failure), clears
// quarantine, and relaunches. If anything fails, opens the DMG page as a fallback.
function applyMacUpdate({ relaunch }) {
  if (!macStagedZip || !fs.existsSync(macStagedZip)) return false;
  const appBundle = path.resolve(process.execPath, '..', '..', '..'); // .../Clip Editor.app
  if (!appBundle.endsWith('.app')) return false;
  const helper = path.join(STAGE_DIR, 'apply-update.sh');
  const unpackDir = path.join(STAGE_DIR, 'unpacked');
  const script = `#!/bin/bash
set -e
APP_PID=${process.pid}
BUNDLE=${JSON.stringify(appBundle)}
ZIP=${JSON.stringify(macStagedZip)}
UNPACK=${JSON.stringify(unpackDir)}
# Wait (up to ~30s) for the running app to fully exit before touching its bundle.
for i in $(seq 1 60); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.5; done
rm -rf "$UNPACK"; mkdir -p "$UNPACK"
if ! /usr/bin/ditto -x -k "$ZIP" "$UNPACK"; then open "$BUNDLE"; exit 0; fi
NEW_APP="$(/usr/bin/find "$UNPACK" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$NEW_APP" ]; then open "$BUNDLE"; exit 0; fi
BAK="$BUNDLE.old-$$"
# Atomic-ish swap with rollback: only remove the backup once the new one is in.
if mv "$BUNDLE" "$BAK" 2>/dev/null && cp -R "$NEW_APP" "$BUNDLE" 2>/dev/null; then
  /usr/bin/xattr -dr com.apple.quarantine "$BUNDLE" 2>/dev/null || true
  rm -rf "$BAK"
else
  # Swap failed (e.g. no write permission) — restore and fall back to the DMG.
  [ -d "$BAK" ] && [ ! -d "$BUNDLE" ] && mv "$BAK" "$BUNDLE"
  open "https://github.com/${REPO.owner}/${REPO.repo}/releases/latest"
  exit 0
fi
${relaunch ? 'open "$BUNDLE"' : ':'}
`;
  try {
    fs.writeFileSync(helper, script, { mode: 0o755 });
    const child = spawn('/bin/bash', [helper], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// --- Windows: electron-updater ----------------------------------------------
let winUpdater = null;
function setupWin() {
  const { autoUpdater } = require('electron-updater');
  winUpdater = autoUpdater;
  autoUpdater.autoDownload = true; // silent background download
  autoUpdater.autoInstallOnAppQuit = true; // applies on next quit if pill ignored
  autoUpdater.on('update-downloaded', (info) => notifyRenderer(info.version));
  autoUpdater.on('error', () => {}); // silent: offline / no release / etc.
}

// --- public API -------------------------------------------------------------
async function checkNow() {
  try {
    if (process.platform === 'darwin') {
      await checkMac();
    } else if (winUpdater) {
      await winUpdater.checkForUpdates(); // download proceeds automatically
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function relaunchToUpdate() {
  if (applying) return;
  applying = true;
  if (process.platform === 'darwin') {
    if (applyMacUpdate({ relaunch: true })) {
      setTimeout(() => app.quit(), 200); // let the detached helper start, then exit
    } else {
      shell.openExternal(`https://github.com/${REPO.owner}/${REPO.repo}/releases/latest`);
      applying = false;
    }
  } else if (winUpdater && readyVersion) {
    winUpdater.quitAndInstall(true, true); // silent, relaunch
  }
}

function init(window) {
  mainWindow = window;

  // Renderer-facing IPC (also surfaced through the preload contextBridge).
  ipcMain.handle('update:relaunch', () => relaunchToUpdate());
  ipcMain.handle('update:dismiss', () => {
    readyVersion = null; // hide the pill for this session (state lives in renderer too)
  });
  ipcMain.handle('update:check', async () => {
    const r = await checkNow();
    return { ...r, ready: readyVersion, current: app.getVersion() };
  });
  ipcMain.handle('update:get-version', () => app.getVersion());
  ipcMain.handle('update:get-auto', () => autoUpdateEnabled());
  ipcMain.handle('update:set-auto', (_e, on) => {
    saveSettings({ autoUpdate: !!on });
    scheduleChecks();
    return autoUpdateEnabled();
  });

  if (process.platform !== 'darwin') setupWin();

  // On a normal quit, apply a staged mac update (the "never clicked the pill"
  // path — Windows handles this via autoInstallOnAppQuit).
  app.on('before-quit', () => {
    if (process.platform === 'darwin' && readyVersion && !applying) {
      applyMacUpdate({ relaunch: false });
    }
  });

  scheduleChecks();
}

function scheduleChecks() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  if (!autoUpdateEnabled()) return;
  // Never block startup: a deferred first check, then every 4 hours. Silent offline.
  setTimeout(() => checkNow(), 8000);
  checkTimer = setInterval(() => checkNow(), CHECK_INTERVAL_MS);
}

module.exports = { init, checkNow, relaunchToUpdate };
