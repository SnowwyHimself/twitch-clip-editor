// Caption quality tiers + custom vocabulary (global, userData). Drives the
// compact tier selector in the Caption inspector and the Caption-quality modal.
import {
  fetchCaptionSettings,
  saveCaptionSettings,
  startModelDownload,
  modelDownloadStatus,
  cancelModelDownload,
  removeModel,
} from './api.js';

const $ = (id) => document.getElementById(id);

const TIER_META = {
  fast: { name: 'Fast', blurb: 'Good for quick clips' },
  better: { name: 'Better', blurb: 'Noticeably more accurate' },
  best: { name: 'Best', blurb: 'Most accurate, great for loud clips' },
};
const TIER_ORDER = ['fast', 'better', 'best'];

let settings = { tier: 'fast', customVocab: '' };
let tiers = {}; // per-tier availability from the server
let totalMemBytes = 0;
let vocabTimer = null;
const downloads = {}; // tier -> { jobId, percent, state, error }

const mb = (bytes) => `${Math.round((bytes || 0) / 1048576)} MB`;

function tierStateLabel(t) {
  const info = tiers[t] || {};
  if (t === 'fast') return 'Included';
  if (info.available) return 'Downloaded';
  return `${mb(info.sizeBytes)} download`;
}

export function refreshTierList() {
  const list = $('caption-tier-list');
  if (!list) return;
  list.innerHTML = '';
  for (const t of TIER_ORDER) {
    const info = tiers[t] || {};
    const dl = downloads[t];
    const card = document.createElement('label');
    card.className = 'caption-tier' + (settings.tier === t ? ' active' : '');
    const blurb = dl && dl.state === 'downloading'
      ? `${TIER_META[t].blurb} · downloading ${dl.percent}%`
      : dl && dl.state === 'error'
        ? `${TIER_META[t].blurb} · download failed`
        : `${TIER_META[t].blurb} · ${tierStateLabel(t)}`;
    card.innerHTML = `
      <span class="caption-tier-radio"><input type="radio" name="cap-tier" value="${t}" ${settings.tier === t ? 'checked' : ''} /></span>
      <span class="caption-tier-main">
        <span class="caption-tier-name">${TIER_META[t].name}</span>
        <span class="caption-tier-blurb">${blurb}</span>
      </span>
      <span class="caption-tier-action"></span>`;
    card.querySelector('input').addEventListener('change', () => selectTier(t));
    renderTierAction(card.querySelector('.caption-tier-action'), t, info, dl);
    list.appendChild(card);
  }
  updateRamWarning();
}

// Per-tier action: Download / Cancel (mid-download) / Remove — never for Fast.
function renderTierAction(el, t, info, dl) {
  el.innerHTML = '';
  if (t === 'fast') return;
  const btn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
    return b;
  };
  if (dl && dl.state === 'downloading') {
    el.appendChild(btn('Cancel', 'link-btn', () => cancelDownload(t)));
  } else if (info.available) {
    el.appendChild(btn('Remove download', 'link-btn', () => removeTier(t)));
  } else {
    el.appendChild(btn('Download', 'secondary-btn', () => beginDownload(t)));
  }
}

async function beginDownload(t) {
  downloads[t] = { jobId: null, percent: 0, state: 'downloading', error: null };
  refreshTierList();
  try {
    const { jobId, alreadyHave } = await startModelDownload(t);
    if (alreadyHave) {
      delete downloads[t];
      return reloadAvailability();
    }
    downloads[t].jobId = jobId;
    pollDownload(t);
  } catch (err) {
    downloads[t] = { state: 'error', error: err.message, percent: 0 };
    refreshTierList();
  }
}

function pollDownload(t) {
  const dl = downloads[t];
  if (!dl || !dl.jobId) return;
  const tick = async () => {
    if (!downloads[t] || downloads[t].jobId !== dl.jobId) return; // cancelled/replaced
    try {
      const st = await modelDownloadStatus(dl.jobId);
      Object.assign(downloads[t], { percent: st.percent, state: st.state, error: st.error });
      refreshTierList();
      if (st.state === 'downloading') {
        setTimeout(tick, 600);
      } else if (st.state === 'done') {
        delete downloads[t];
        await reloadAvailability(); // model now on disk
      }
      // 'error'/'cancelled' stay shown until the user retries.
    } catch {
      setTimeout(tick, 1000);
    }
  };
  tick();
}

async function cancelDownload(t) {
  const dl = downloads[t];
  if (dl && dl.jobId) {
    try {
      await cancelModelDownload(dl.jobId);
    } catch {
      /* ignore */
    }
  }
  delete downloads[t];
  refreshTierList();
}

async function removeTier(t) {
  try {
    await removeModel(t);
  } catch {
    /* ignore */
  }
  await reloadAvailability();
}

async function reloadAvailability() {
  try {
    const data = await fetchCaptionSettings();
    tiers = data.tiers;
  } catch {
    /* keep */
  }
  refreshTierList();
}

function updateRamWarning() {
  const warn = $('caption-ram-warn');
  if (!warn) return;
  const constrained = totalMemBytes > 0 && totalMemBytes < 8 * 1024 * 1024 * 1024;
  const show = settings.tier === 'best' && constrained;
  warn.classList.toggle('hidden', !show);
  if (show) warn.textContent = 'Best is heavy — your machine has under 8 GB RAM, so it may run slowly. It will still work.';
}

function syncCompact() {
  const sel = $('cap-tier-select');
  if (sel) sel.value = settings.tier;
}

async function selectTier(t) {
  if (!TIER_ORDER.includes(t) || t === settings.tier) {
    settings.tier = t;
  } else {
    settings.tier = t;
    try {
      const res = await saveCaptionSettings({ tier: t });
      settings = res.settings;
    } catch {
      /* keep local */
    }
  }
  syncCompact();
  refreshTierList();
}

function openModal() {
  $('caption-vocab').value = settings.customVocab || '';
  refreshTierList();
  $('caption-modal-status').textContent = '';
  $('caption-modal').classList.remove('hidden');
}
function closeModal() {
  $('caption-modal').classList.add('hidden');
}

// Exposed so the download manager can read/update tier availability + settings.
export function getTiers() {
  return tiers;
}
export function setTierAvailability(next) {
  tiers = next;
  refreshTierList();
}
export function getSettings() {
  return settings;
}

export async function initCaptionSettings() {
  $('cap-quality-settings-btn')?.addEventListener('click', openModal);
  $('caption-close-btn')?.addEventListener('click', closeModal);
  $('cap-tier-select')?.addEventListener('change', (e) => selectTier(e.target.value));

  // Custom vocab — debounced save (wired into the prompt server-side in S3).
  $('caption-vocab')?.addEventListener('input', (e) => {
    settings.customVocab = e.target.value;
    clearTimeout(vocabTimer);
    vocabTimer = setTimeout(async () => {
      try {
        await saveCaptionSettings({ customVocab: settings.customVocab });
        $('caption-modal-status').textContent = 'Saved.';
      } catch {
        /* ignore */
      }
    }, 500);
  });

  try {
    const data = await fetchCaptionSettings();
    settings = data.settings;
    tiers = data.tiers;
    totalMemBytes = data.totalMemBytes || 0;
  } catch {
    /* offline — defaults stay */
  }
  syncCompact();
  refreshTierList();
}
