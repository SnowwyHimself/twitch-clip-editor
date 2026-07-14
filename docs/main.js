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
  // Windows currently ships as a portable zip (unzip + run) until the NSIS
  // installer build is wired up — keep this matching the release's asset name.
  WIN_ASSET: 'Clip-Editor-Windows-Portable.zip',
  TAGLINE: 'Turn Twitch clips into vertical videos',
};
/* ─────────────────────────────────────────────────────────────────────────── */

const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const gh = (path = '') => `https://github.com/${CONFIG.REPO}${path}`;
const latestAsset = (name) => gh(`/releases/latest/download/${name}`);

// Apply the config to the DOM (names + all link targets) — a rebrand is one edit.
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
  mac: 'macOS: right-click → Open the first time (unsigned build).',
  win: 'Windows: unzip, then run "Clip Editor.exe" (More info → Run anyway if SmartScreen warns — unsigned build).',
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
    row.prepend(win);
    setRoles(win, mac);
  } else {
    row.prepend(mac);
    setRoles(mac, win);
  }
  if (notes && OS_NOTE[os]) notes.textContent = OS_NOTE[os];
}

const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;

// Version + per-asset file size, from the latest release. Static download links
// already point at /latest/, so this is display-only — fail quietly (offline / rate limit).
async function loadRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${CONFIG.REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    const tag = (data && data.tag_name) || '';
    if (tag) document.querySelectorAll('[data-version]').forEach((el) => (el.textContent = tag));
    const assets = (data && data.assets) || [];
    const sizeOf = (name) => {
      const a = assets.find((x) => x.name === name);
      return a ? mb(a.size) : null;
    };
    const setSub = (os, assetName) => {
      const el = document.querySelector(`[data-dl-sub="${os}"]`);
      const size = sizeOf(assetName);
      if (el && tag && size) el.textContent = `${tag} · ${size}`;
    };
    setSub('mac', CONFIG.MAC_ASSET);
    setSub('win', CONFIG.WIN_ASSET);
  } catch {
    /* leave static fallbacks */
  }
}

// Live star count on the slim GitHub link — hidden entirely if the API is
// unavailable / rate-limited (never show a broken control).
async function loadStars() {
  try {
    const res = await fetch(`https://api.github.com/repos/${CONFIG.REPO}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    const n = data && typeof data.stargazers_count === 'number' ? data.stargazers_count : null;
    if (n === null || n < 1) return; // only show once there's real social proof
    const wrap = document.getElementById('gh-star');
    const count = document.getElementById('gh-star-count');
    if (wrap && count) {
      count.textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      wrap.classList.remove('hidden');
    }
  } catch {
    /* stays hidden */
  }
}

// Real product videos with graceful fallback: try to load each; only swap the CSS
// mock out once a video can actually play. Missing files (or reduced-motion) keep
// the mock, so the page never looks broken.
function setupMedia() {
  if (prefersReducedMotion()) return; // keep the static mock; no looping video
  document.querySelectorAll('[data-media]').forEach((wrap) => {
    const video = wrap.querySelector('video.media-video');
    if (!video) return;
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      wrap.classList.add('has-video');
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    };
    video.addEventListener('loadeddata', show, { once: true });
    video.addEventListener('error', () => {}, { once: true }); // fallback stays
    try {
      video.load(); // preload="none" — kick off the attempt
    } catch {
      /* ignore */
    }
  });
}

// Fire `cb` once, the first time `el` is within the viewport. Scroll/resize based
// (with an immediate check on load) so it stays reliable even in embedded webviews
// where IntersectionObserver callbacks don't always fire. The page's scroll
// container is <body>, so we listen on window in the capture phase to catch it.
function whenVisible(el, cb) {
  let done = false;
  const check = () => {
    if (done) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.92 && r.bottom > 0) {
      done = true;
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      cb();
    }
  };
  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      check();
    });
  };
  check(); // reveal in-view items on load — no wait for a scroll tick
  if (!done) {
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
  }
}

// The one flourish: a caption line that pops in word-by-word (app-caption feel),
// holds, crossfades out, and loops. Static full line under reduced-motion / no-JS.
function setupCaptionDemo() {
  const el = document.getElementById('cap-demo');
  if (!el || prefersReducedMotion()) return; // static text stays
  const words = (el.dataset.words || el.textContent || '').split(/[,\s]+/).filter(Boolean);
  if (!words.length) return;
  el.textContent = '';
  el.classList.add('animated');
  const spans = words.map((w) => {
    const s = document.createElement('span');
    s.className = 'cap-word';
    s.textContent = w;
    el.appendChild(s);
    return s;
  });
  const timers = [];
  const clear = () => {
    timers.forEach(clearTimeout);
    timers.length = 0;
  };
  const STEP = 105; // ~per-word cadence
  function run() {
    clear();
    el.classList.remove('reset');
    spans.forEach((s) => s.classList.remove('on'));
    spans.forEach((s, i) => timers.push(setTimeout(() => s.classList.add('on'), 140 + i * STEP)));
    const hold = 140 + spans.length * STEP + 1500;
    timers.push(setTimeout(() => el.classList.add('reset'), hold));
    timers.push(setTimeout(run, hold + 320));
  }
  // Start once the demo scrolls into view; keep it looping thereafter.
  whenVisible(el, run);
}

// Single fade-rise per section as it scrolls into view (once). Items already in
// the viewport on load (the hero) reveal immediately, so it fades in on arrival.
function setupReveal() {
  const items = document.querySelectorAll('[data-reveal]');
  if (prefersReducedMotion()) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  items.forEach((el) => whenVisible(el, () => el.classList.add('in')));
}

applyConfig();
orderDownloads(detectOS());
setupReveal();
setupMedia();
setupCaptionDemo();
loadRelease();
loadStars();
