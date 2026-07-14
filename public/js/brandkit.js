// Global brand kit (Feature 7): default font/colour + a reusable watermark.
// Loads once from the server, drives the Brand-kit modal, and keeps the
// per-project watermark toggle (in the Project inspector) in sync.
import { state, on, setBrandKit, applyBrandKitToNewProject, setWatermark } from './state.js';
import { fetchBrandKit, saveBrandKit, watermarkUrl } from './api.js';

const COLORS = ['#ffffff', '#ffe600', '#ff9500', '#ff3b30', '#ff2d95', '#af52de', '#0a84ff', '#34c759', '#000000'];
const $ = (id) => document.getElementById(id);

let pendingImageFile = null; // a newly chosen watermark, not yet saved
let removeImage = false;
let chosenColor = null;

function buildFontOptions() {
  const sel = $('brand-font');
  sel.innerHTML = '<option value="">App default</option>';
  for (const f of state.fonts || []) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.available ? f.label : `${f.label} (not installed)`;
    o.disabled = !f.available;
    sel.appendChild(o);
  }
}

function buildColorSwatches() {
  const wrap = $('brand-color');
  wrap.innerHTML = '';
  for (const hex of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'color-swatch';
    b.style.background = hex;
    b.dataset.hex = hex;
    b.addEventListener('click', () => {
      chosenColor = hex;
      markActiveColor();
    });
    wrap.appendChild(b);
  }
}

function markActiveColor() {
  $('brand-color')
    .querySelectorAll('.color-swatch')
    .forEach((b) => b.classList.toggle('active', b.dataset.hex === chosenColor));
}

function refreshWatermarkPreview() {
  const img = $('brand-wm-preview');
  const kit = state.brandKit || {};
  const hasImg = pendingImageFile || (!removeImage && kit.watermark && kit.watermark.image);
  img.classList.toggle('hidden', !hasImg);
  $('brand-wm-remove').classList.toggle('hidden', !hasImg);
  if (!hasImg) return;
  img.src = pendingImageFile ? URL.createObjectURL(pendingImageFile) : watermarkUrl(kit.watermark.image);
}

function fillModalFromKit() {
  const kit = state.brandKit || {};
  const wm = kit.watermark || {};
  $('brand-font').value = kit.defaultFontId || '';
  chosenColor = kit.defaultTextColor || null;
  markActiveColor();
  const set = (id, val, suffix) => {
    $(id).value = val;
    if (suffix) $(`${id}-val`).textContent = `${val}${suffix}`;
  };
  set('brand-wm-size', Number.isFinite(wm.sizePercent) ? wm.sizePercent : 18, '%');
  set('brand-wm-opacity', Math.round((Number.isFinite(wm.opacity) ? wm.opacity : 0.7) * 100), '%');
  set('brand-wm-x', Number.isFinite(wm.xPercent) ? wm.xPercent : 88, '%');
  set('brand-wm-y', Number.isFinite(wm.yPercent) ? wm.yPercent : 90, '%');
  $('brand-wm-default').checked = !!wm.onByDefault;
  pendingImageFile = null;
  removeImage = false;
  refreshWatermarkPreview();
  $('brand-status').textContent = '';
}

function openModal() {
  fillModalFromKit();
  $('brand-kit-modal').classList.remove('hidden');
}
function closeModal() {
  $('brand-kit-modal').classList.add('hidden');
}

async function save() {
  const kit = {
    defaultFontId: $('brand-font').value || null,
    defaultTextColor: chosenColor || null,
    watermark: {
      image: (state.brandKit && state.brandKit.watermark && state.brandKit.watermark.image) || null,
      sizePercent: parseInt($('brand-wm-size').value, 10),
      opacity: parseInt($('brand-wm-opacity').value, 10) / 100,
      xPercent: parseInt($('brand-wm-x').value, 10),
      yPercent: parseInt($('brand-wm-y').value, 10),
      onByDefault: $('brand-wm-default').checked,
    },
  };
  $('brand-status').textContent = 'Saving…';
  try {
    const saved = await saveBrandKit(kit, { imageFile: pendingImageFile, removeWatermark: removeImage });
    setBrandKit(saved);
    // Reflect new placement/opacity on this project's watermark immediately.
    setWatermark({
      sizePercent: saved.watermark.sizePercent,
      opacity: saved.watermark.opacity,
      xPercent: saved.watermark.xPercent,
      yPercent: saved.watermark.yPercent,
    });
    pendingImageFile = null;
    removeImage = false;
    syncProjectWatermarkToggle();
    refreshWatermarkPreview();
    $('brand-status').textContent = 'Saved.';
  } catch (err) {
    $('brand-status').textContent = `Couldn't save: ${err.message}`;
  }
}

// The per-project "Show watermark" toggle (Project inspector) can only be on when
// a watermark image actually exists in the kit.
function syncProjectWatermarkToggle() {
  const toggle = $('project-watermark-toggle');
  if (!toggle) return;
  const hasImg = !!(state.brandKit && state.brandKit.watermark && state.brandKit.watermark.image);
  toggle.checked = !!(state.watermark && state.watermark.enabled);
  toggle.disabled = !hasImg;
  const hint = $('project-watermark-hint');
  if (hint) {
    hint.innerHTML = hasImg
      ? 'Placement &amp; opacity live in <strong>Brand kit</strong> (top bar).'
      : 'Add a watermark image in <strong>Brand kit</strong> (top bar) first.';
  }
}

export async function initBrandKit() {
  buildFontOptions();
  buildColorSwatches();

  $('brand-kit-btn').addEventListener('click', openModal);
  $('brand-close-btn').addEventListener('click', closeModal);
  $('brand-save-btn').addEventListener('click', save);
  $('brand-wm-choose').addEventListener('click', () => $('brand-wm-file').click());
  $('brand-wm-file').addEventListener('change', () => {
    const f = $('brand-wm-file').files[0];
    if (f) {
      pendingImageFile = f;
      removeImage = false;
      refreshWatermarkPreview();
    }
    $('brand-wm-file').value = '';
  });
  $('brand-wm-remove').addEventListener('click', () => {
    pendingImageFile = null;
    removeImage = true;
    refreshWatermarkPreview();
  });
  for (const [id, suffix, scale] of [
    ['brand-wm-size', '%', 1],
    ['brand-wm-opacity', '%', 1],
    ['brand-wm-x', '%', 1],
    ['brand-wm-y', '%', 1],
  ]) {
    $(id).addEventListener('input', () => {
      $(`${id}-val`).textContent = `${$(id).value}${suffix}`;
    });
  }

  // The Project-inspector toggle switches the watermark on/off for this project.
  $('project-watermark-toggle').addEventListener('change', (e) => {
    setWatermark({ enabled: e.target.checked });
  });
  on('settings', syncProjectWatermarkToggle);

  try {
    const kit = await fetchBrandKit();
    setBrandKit(kit);
    applyBrandKitToNewProject(); // seed this session's watermark from the kit
  } catch {
    /* offline / first run — defaults stay */
  }
  syncProjectWatermarkToggle();
}
