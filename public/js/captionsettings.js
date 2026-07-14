// Caption quality tiers + custom vocabulary (global, userData). Drives the
// compact tier selector in the Caption inspector and the Caption-quality modal.
import { fetchCaptionSettings, saveCaptionSettings } from './api.js';

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

const mb = (bytes) => `${Math.round((bytes || 0) / 1048576)} MB`;

function tierStateLabel(t) {
  const info = tiers[t] || {};
  if (t === 'fast') return 'Included';
  if (info.available) return 'Downloaded';
  return `${mb(info.sizeBytes)} download`;
}

// Called by the download manager (S2) to re-render after a state change.
export function refreshTierList() {
  const list = $('caption-tier-list');
  if (!list) return;
  list.innerHTML = '';
  for (const t of TIER_ORDER) {
    const info = tiers[t] || {};
    const card = document.createElement('label');
    card.className = 'caption-tier' + (settings.tier === t ? ' active' : '');
    card.innerHTML = `
      <span class="caption-tier-radio"><input type="radio" name="cap-tier" value="${t}" ${settings.tier === t ? 'checked' : ''} /></span>
      <span class="caption-tier-main">
        <span class="caption-tier-name">${TIER_META[t].name}</span>
        <span class="caption-tier-blurb">${TIER_META[t].blurb} · ${tierStateLabel(t)}</span>
      </span>
      <span class="caption-tier-action" data-tier-action="${t}"></span>`;
    card.querySelector('input').addEventListener('change', () => selectTier(t));
    list.appendChild(card);
  }
  // S2 injects Download/Remove buttons into [data-tier-action]; expose a hook.
  document.dispatchEvent(new CustomEvent('caption-tiers-rendered', { detail: { tiers } }));
  updateRamWarning();
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
