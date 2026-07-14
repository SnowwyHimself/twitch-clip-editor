/* Clip Editor landing — vanilla, no dependencies.
 *
 * ── REBRAND HERE ────────────────────────────────────────────────────────────
 * Change these values to rename/repoint the whole page. APP_NAME propagates to
 * every visible name and the tab title; REPO drives all GitHub + download links.
 */
const CONFIG = {
  APP_NAME: 'Clip Editor',
  REPO: 'SnowwyHimself/twitch-clip-editor', // owner/repo
  // Exact electron-builder asset filenames (no version in them, so static links work).
  MAC_ASSET: 'Clip-Editor-Mac.dmg',
  WIN_ASSET: 'Clip-Editor-Windows-Setup.exe',
  TAGLINE: 'Turn Twitch clips into vertical videos',
};
/* ─────────────────────────────────────────────────────────────────────────── */

const gh = (path = '') => `https://github.com/${CONFIG.REPO}${path}`;
const latestAsset = (name) => gh(`/releases/latest/download/${name}`);

// Apply the config to the DOM (names + all link targets), so a rebrand is one edit.
function applyConfig() {
  document.title = `${CONFIG.APP_NAME} — ${CONFIG.TAGLINE}`;
  document.querySelectorAll('[data-app-name]').forEach((el) => (el.textContent = CONFIG.APP_NAME));
  document.querySelectorAll('[data-gh]').forEach((el) => (el.href = gh()));
  document.querySelectorAll('[data-gh-releases]').forEach((el) => (el.href = gh('/releases')));
  document.querySelectorAll('[data-gh-issues]').forEach((el) => (el.href = gh('/issues')));
  document.querySelectorAll('[data-gh-license]').forEach((el) => (el.href = gh('/blob/main/LICENSE')));
  document.querySelectorAll('[data-gh-security]').forEach((el) => (el.href = gh('/blob/main/SECURITY.md')));

  const mac = document.querySelector('[data-dl="mac"]');
  const win = document.querySelector('[data-dl="win"]');
  if (mac) mac.href = latestAsset(CONFIG.MAC_ASSET);
  if (win) win.href = latestAsset(CONFIG.WIN_ASSET);
}

// Best-effort OS detection to lead with the visitor's platform.
function detectOS() {
  const ua = navigator.userAgent || '';
  const plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/mac/i.test(plat) || /Mac OS X/i.test(ua)) return 'mac';
  if (/win/i.test(plat) || /Windows/i.test(ua)) return 'win';
  return 'other';
}

const OS_NOTE = {
  mac: 'macOS: right-click the app → Open the first time (unsigned build).',
  win: 'Windows: SmartScreen may warn — More info → Run anyway (unsigned build).',
};

function orderDownloads(os) {
  const row = document.getElementById('dl-row');
  const mac = document.querySelector('[data-dl="mac"]');
  const win = document.querySelector('[data-dl="win"]');
  const notes = document.getElementById('dl-notes');
  if (!row || !mac || !win) return;

  const setRoles = (primary, secondary) => {
    primary.classList.add('btn-primary');
    primary.classList.remove('btn-secondary');
    secondary.classList.add('btn-secondary');
    secondary.classList.remove('btn-primary');
  };

  if (os === 'win') {
    row.prepend(win); // visitor's platform first
    setRoles(win, mac);
  } else {
    row.prepend(mac); // mac leads for mac + unknown
    setRoles(mac, win);
  }
  if (notes && OS_NOTE[os]) notes.textContent = OS_NOTE[os];
}

// Render the current version from the GitHub API. Static download links already
// point at /latest/, so this is display-only — fail quietly (offline / rate limit).
async function loadVersion() {
  try {
    const res = await fetch(`https://api.github.com/repos/${CONFIG.REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    const tag = (data && data.tag_name) || '';
    if (!tag) return;
    document.querySelectorAll('[data-version]').forEach((el) => {
      el.textContent = el.classList.contains('footer-ver') ? tag : tag;
    });
  } catch {
    /* leave the static fallback text */
  }
}

applyConfig();
orderDownloads(detectOS());
loadVersion();
