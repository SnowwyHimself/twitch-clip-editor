// Right-side properties panel, CapCut-style, five tabs:
//   Video    — canvas/clip settings (aspect, zoom, blur, speed, mirror)
//   Text     — every property of the selected text layer
//   Captions — auto-captions: mode (word-by-word / short lines), generate,
//              and shared styling applied to all caption blocks at once
//   Overlay  — logo/reaction media: your own file or a bundled preset
//   Sound    — sound effect: your own file or a bundled preset
//
// Selecting a text layer switches to Text automatically; deselecting only
// leaves Text (back to Video) — it never yanks you out of the Captions/
// Overlay/Sound tabs you opened on purpose.

import {
  state,
  on,
  emit,
  selectedLayer,
  selectLayer,
  updateLayer,
  removeLayer,
  addTextLayer,
  removeCaptionLayers,
  applyCaptionStyle,
  applyCaptionTiming,
  defaultFontId,
  sourceDuration,
  addTransitionAfter,
  removeTransition,
  addOverlay,
  updateOverlay,
  removeOverlay,
  selectedOverlay,
  addSound,
  updateSound,
  removeSound,
  selectedSound,
  addKeyframe,
  removeKeyframe,
  clearKeyframes,
  keyframeAt,
  keyframeTransformAt,
} from './state.js';
import { getCurrentTime, getCurrentOutputTime } from './preview.js';
import { trackFace } from './facetrack.js';
import { transcribe, fetchSfxPresets, fetchOverlayPresets, presetAsFile } from './api.js';

const CAPTION_COLORS = [
  { hex: '#ffffff', label: 'White' },
  { hex: '#ffe600', label: 'Yellow' },
  { hex: '#ff9500', label: 'Orange' },
  { hex: '#ff3b30', label: 'Red' },
  { hex: '#ff2d95', label: 'Pink' },
  { hex: '#af52de', label: 'Purple' },
  { hex: '#0a84ff', label: 'Blue' },
  { hex: '#34c759', label: 'Green' },
  { hex: '#000000', label: 'Black' },
];

// Curated set matching the server's bundled Twemoji fallback assets.
const CURATED_EMOJIS = [
  '😀', '😂', '😅', '😍', '😭', '😡', '🥳', '😱', '🤔', '😴', '🥰', '🤯', '😏', '🙄', '😊',
  '❤️', '💔', '💯', '✨', '🔥', '🎉', '💀', '👀', '💩', '🙏', '👑', '⚡', '💥', '🎶', '🌟',
  '👍', '👎', '👏', '🙌', '💪', '✌️', '🤝', '👋',
  '🎂', '🍕', '☕', '🏆', '💰', '📸', '🎮',
];

// --- element lookups (populated in initPanel) --------------------------------

let els = {};

function lookupElements() {
  const byId = (id) => document.getElementById(id);
  els = {
    tabs: {
      video: { btn: byId('ptab-video'), body: byId('panel-video') },
      text: { btn: byId('ptab-text'), body: byId('panel-text') },
      captions: { btn: byId('ptab-captions'), body: byId('panel-captions') },
      overlay: { btn: byId('ptab-overlay'), body: byId('panel-overlay') },
      sound: { btn: byId('ptab-sound'), body: byId('panel-sound') },
      transitions: { btn: byId('ptab-transitions'), body: byId('panel-transitions') },
    },
    textAddBtn: byId('text-add-btn'),
    transDurationSlider: byId('trans-duration-slider'),
    transDurationValue: byId('trans-duration-value'),
    transAddBtn: byId('trans-add-btn'),
    transStatus: byId('trans-status'),
    transList: byId('trans-list'),
    aspectGroup: byId('aspect-ratio-group'),
    zoomSlider: byId('zoom-slider'),
    zoomValue: byId('zoom-value'),
    blurSlider: byId('blur-slider'),
    blurValue: byId('blur-value'),
    panXSlider: byId('pan-x-slider'),
    panXValue: byId('pan-x-value'),
    panYSlider: byId('pan-y-slider'),
    panYValue: byId('pan-y-value'),
    panLockToggle: byId('pan-lock-toggle'),
    kfAddBtn: byId('kf-add-btn'),
    kfStatus: byId('kf-status'),
    kfClearBtn: byId('kf-clear-btn'),
    faceTrackBtn: byId('face-track-btn'),
    speedSlider: byId('speed-slider'),
    speedValue: byId('speed-value'),
    mirrorToggle: byId('mirror-toggle'),
    presetList: byId('preset-list'),
    presetName: byId('preset-name'),
    presetSaveBtn: byId('preset-save-btn'),
    // Overlay tab
    overlayFile: byId('overlay-file'),
    overlayChooseBtn: byId('overlay-choose-btn'),
    overlayPresets: byId('overlay-presets'),
    overlaySizeGroup: byId('overlay-size-group'),
    overlaySizeSlider: byId('overlay-size-slider'),
    overlaySizeValue: byId('overlay-size-value'),
    overlayRemoveBtn: byId('overlay-remove-btn'),
    cropSliders: {
      cropTop: byId('crop-top'),
      cropBottom: byId('crop-bottom'),
      cropLeft: byId('crop-left'),
      cropRight: byId('crop-right'),
    },
    cropValues: {
      cropTop: byId('crop-top-value'),
      cropBottom: byId('crop-bottom-value'),
      cropLeft: byId('crop-left-value'),
      cropRight: byId('crop-right-value'),
    },
    // Sound tab
    audioFile: byId('audio-file'),
    soundChooseBtn: byId('sound-choose-btn'),
    sfxPresets: byId('sfx-presets'),
    audioVolumeGroup: byId('audio-volume-group'),
    audioVolumeSlider: byId('audio-volume-slider'),
    audioVolumeValue: byId('audio-volume-value'),
    audioCurrent: byId('audio-current'),
    audioRemoveBtn: byId('audio-remove-btn'),
    // Text tab
    textInput: byId('caption-text'),
    emojiBtn: byId('emoji-picker-btn'),
    emojiPanel: byId('emoji-panel'),
    styleButtons: () => document.querySelectorAll('[data-caption-style]'),
    fontSelect: byId('font-select'),
    colorPicker: byId('color-picker'),
    fontSizeSlider: byId('font-size-slider'),
    fontSizeValue: byId('font-size-value'),
    dropShadowToggle: byId('drop-shadow-toggle'),
    layerStart: byId('layer-start'),
    layerEnd: byId('layer-end'),
    duplicateBtn: byId('duplicate-layer-btn'),
    deleteBtn: byId('delete-layer-btn'),
    noLayerMsg: byId('panel-text-empty'),
    textControls: byId('panel-text-controls'),
    // Captions tab
    capModeButtons: () => document.querySelectorAll('[data-caption-mode]'),
    capGenerateBtn: byId('captions-generate-btn'),
    capStatus: byId('captions-status'),
    capStyleButtons: () => document.querySelectorAll('[data-cap-style]'),
    capFontSelect: byId('cap-font-select'),
    capColorPicker: byId('cap-color-picker'),
    capSizeSlider: byId('cap-size-slider'),
    capSizeValue: byId('cap-size-value'),
    capShadowToggle: byId('cap-shadow-toggle'),
    capYSlider: byId('cap-y-slider'),
    capYValue: byId('cap-y-value'),
    capTimingSlider: byId('cap-timing-slider'),
    capTimingValue: byId('cap-timing-value'),
  };
}

// --- tab switching -------------------------------------------------------------

export function showTab(which) {
  for (const [name, tab] of Object.entries(els.tabs)) {
    tab.btn.classList.toggle('active', name === which);
    tab.body.classList.toggle('hidden', name !== which);
  }
}

function activeTab() {
  return Object.keys(els.tabs).find((name) => els.tabs[name].btn.classList.contains('active'));
}

// --- shared builders --------------------------------------------------------------

function buildFontOptions(select) {
  select.innerHTML = '';
  for (const font of state.fonts) {
    const option = document.createElement('option');
    option.value = font.id;
    option.textContent = font.available ? font.label : `${font.label} (not installed)`;
    option.disabled = !font.available;
    select.appendChild(option);
  }
}

function buildColorPicker(container, onPick) {
  container.innerHTML = '';
  for (const c of CAPTION_COLORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch';
    btn.style.background = c.hex;
    btn.dataset.hex = c.hex;
    btn.setAttribute('aria-label', c.label);
    btn.title = c.label;
    btn.addEventListener('click', () => onPick(c.hex));
    container.appendChild(btn);
  }
}

function markActiveSwatch(container, hex) {
  container.querySelectorAll('.color-swatch').forEach((b) => b.classList.toggle('active', b.dataset.hex === hex));
}

// --- video panel ------------------------------------------------------------------

function buildAspectButtons() {
  els.aspectGroup.innerHTML = '';
  for (const ratio of state.aspectRatios) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle-btn';
    btn.textContent = ratio.id;
    btn.title = ratio.label;
    btn.classList.toggle('active', ratio.id === state.aspect.id);
    btn.addEventListener('click', () => {
      state.aspect = { id: ratio.id, width: ratio.width, height: ratio.height };
      els.aspectGroup.querySelectorAll('.toggle-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      emit('settings');
    });
    els.aspectGroup.appendChild(btn);
  }
}

function wireVideoControls() {
  // When keyframes exist, editing zoom/position writes into the keyframe at
  // the playhead (creating one if needed) — the CapCut behavior — so you
  // scrub, tweak, and it records. With no keyframes it's just the static value.
  const keyframeEditIfActive = () => {
    if (state.keyframes.length === 0) return;
    addKeyframe(getCurrentTime(), { zoom: state.zoom, panX: state.panX, panY: state.panY });
  };
  els.zoomSlider.addEventListener('input', () => {
    state.zoom = parseFloat(els.zoomSlider.value) / 100;
    els.zoomValue.textContent = `${els.zoomSlider.value}%`;
    keyframeEditIfActive();
    emit('settings');
  });
  els.blurSlider.addEventListener('input', () => {
    state.blur = parseFloat(els.blurSlider.value);
    els.blurValue.textContent = `${els.blurSlider.value}%`;
    emit('settings');
  });
  els.panXSlider.addEventListener('input', () => {
    state.panX = parseFloat(els.panXSlider.value);
    els.panXValue.textContent = els.panXSlider.value;
    keyframeEditIfActive();
    emit('settings');
  });
  els.panYSlider.addEventListener('input', () => {
    state.panY = parseFloat(els.panYSlider.value);
    els.panYValue.textContent = els.panYSlider.value;
    keyframeEditIfActive();
    emit('settings');
  });
  els.speedSlider.addEventListener('input', () => {
    state.speed = parseFloat(els.speedSlider.value);
    els.speedValue.textContent = `${state.speed.toFixed(2)}x`;
    emit('settings');
  });
  els.mirrorToggle.addEventListener('change', () => {
    state.mirror = els.mirrorToggle.checked;
    emit('settings');
  });
  // Position lock: when on, applying a preset never moves the clip (panX/panY
  // stay put). Persisted so the choice sticks across sessions. Default on —
  // position is per-clip framing, not something a shared "look" should hijack.
  els.panLockToggle.checked = positionLocked();
  els.panLockToggle.addEventListener('change', () => {
    localStorage.setItem(PAN_LOCK_KEY, els.panLockToggle.checked ? '1' : '0');
  });
  wirePresets();
  wireKeyframes();
}

// --- keyframes (zoom/position animation) --------------------------------------

function wireKeyframes() {
  // ◆ toggles a keyframe at the playhead: adds/updates one using the current
  // zoom & position, or removes the one already sitting there.
  els.kfAddBtn.addEventListener('click', () => {
    const t = getCurrentTime();
    const existing = keyframeAt(t);
    if (existing) removeKeyframe(existing.id);
    else addKeyframe(t, { zoom: state.zoom, panX: state.panX, panY: state.panY });
  });
  els.kfClearBtn.addEventListener('click', () => clearKeyframes());
  els.faceTrackBtn.addEventListener('click', runFaceTrack);
  on('keyframes', renderKeyframeUI);
  // As the playhead moves over a keyframed range, show the interpolated
  // zoom/position on the sliders (read-out) and light ◆ on exact keyframes.
  on('time', () => {
    if (state.keyframes.length) syncKeyframeSliders();
    renderKeyframeUI();
  });
  renderKeyframeUI();
}

function renderKeyframeUI() {
  const n = state.keyframes.length;
  const onKf = n > 0 && !!keyframeAt(getCurrentTime());
  els.kfAddBtn.classList.toggle('active', onKf);
  els.kfClearBtn.classList.toggle('hidden', n === 0);
  if (n === 0) {
    els.kfStatus.textContent =
      'No keyframes — the clip holds still. Drop one here, move the playhead, change zoom or position to animate a punch-in.';
  } else {
    els.kfStatus.textContent = `${n} keyframe${n === 1 ? '' : 's'} — the clip animates zoom & position between them.${
      onKf ? ' (a keyframe is at the playhead)' : ''
    }`;
  }
}

// Pushes the interpolated transform at the playhead onto the sliders so they
// read out the current animated value (skips whichever the user is dragging).
function syncKeyframeSliders() {
  const tf = keyframeTransformAt(getCurrentTime());
  if (!tf) return;
  if (document.activeElement !== els.zoomSlider) {
    els.zoomSlider.value = Math.round(tf.zoom * 100);
    els.zoomValue.textContent = `${Math.round(tf.zoom * 100)}%`;
  }
  if (document.activeElement !== els.panXSlider) {
    els.panXSlider.value = Math.round(tf.panX);
    els.panXValue.textContent = String(Math.round(tf.panX));
  }
  if (document.activeElement !== els.panYSlider) {
    els.panYSlider.value = Math.round(tf.panY);
    els.panYValue.textContent = String(Math.round(tf.panY));
  }
  // Keep the live state values aligned with what's shown, so a subsequent
  // slider tweak upserts a keyframe from the right baseline.
  state.zoom = tf.zoom;
  state.panX = tf.panX;
  state.panY = tf.panY;
}

// Auto-reframe: scans the clip for a face and fills in follow keyframes.
async function runFaceTrack() {
  if (!state.source) {
    els.kfStatus.textContent = 'Load a clip first, then track a face.';
    return;
  }
  const btn = els.faceTrackBtn;
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  els.kfStatus.textContent = 'Scanning the clip for a face…';
  try {
    const result = await trackFace({
      onProgress: (p) => {
        els.kfStatus.textContent = `Scanning for a face… ${Math.round(p * 100)}%`;
      },
    });
    if (result.ok) {
      renderKeyframeUI();
      els.kfStatus.textContent = `Tracking a face with ${result.keyframes} keyframes — tweak or clear them like any others.`;
    } else if (result.reason === 'no-face') {
      els.kfStatus.textContent = 'No face found — this works best on face-forward clips. You can still keyframe by hand.';
    } else if (result.reason === 'load-failed') {
      els.kfStatus.textContent = 'The face detector could not load. Please try again.';
    } else {
      els.kfStatus.textContent = 'Load a clip first, then track a face.';
    }
  } catch {
    els.kfStatus.textContent = 'Face tracking hit an error — please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// --- presets (up to 3, saved in localStorage) ---------------------------------------
// A preset captures the video settings (aspect/zoom/blur/pan/speed/mirror).
// The one flagged default (★) is auto-applied whenever a clip loads, so an
// imported clip lands in the user's template. Nothing here is per-clip.

const PRESETS_KEY = 'clipEditor.presets.v1';
const DEFAULT_PRESET_KEY = 'clipEditor.defaultPreset.v1';
const PAN_LOCK_KEY = 'clipEditor.lockPosition.v1';

// Defaults to locked (missing key === locked) so presets don't move framing
// out of the box — the main source of "the preset messed up my clip".
function positionLocked() {
  return localStorage.getItem(PAN_LOCK_KEY) !== '0';
}

function loadPresets() {
  try {
    return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]');
  } catch {
    return [];
  }
}

function savePresets(list) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
}

function getDefaultPresetId() {
  return localStorage.getItem(DEFAULT_PRESET_KEY) || null;
}

function currentVideoSettings() {
  return {
    aspect: { ...state.aspect },
    zoom: state.zoom,
    blur: state.blur,
    panX: state.panX,
    panY: state.panY,
    speed: state.speed,
    mirror: state.mirror,
  };
}

export function applyPresetSettings(s) {
  if (!s) return;
  if (s.aspect) state.aspect = { ...s.aspect };
  if (Number.isFinite(s.zoom)) state.zoom = s.zoom;
  if (Number.isFinite(s.blur)) state.blur = s.blur;
  // Position is per-clip framing. Unless the user has unlocked it, a preset
  // must NOT move the clip — leaving panX/panY exactly where they are.
  if (!positionLocked()) {
    if (Number.isFinite(s.panX)) state.panX = s.panX;
    if (Number.isFinite(s.panY)) state.panY = s.panY;
  }
  if (Number.isFinite(s.speed)) state.speed = s.speed;
  if (typeof s.mirror === 'boolean') state.mirror = s.mirror;
  buildAspectButtons();
  refreshVideoPanel();
  emit('settings');
}

// The default preset, applied on clip import (main.js calls this).
export function activePresetSettings() {
  const id = getDefaultPresetId();
  return loadPresets().find((p) => p.id === id)?.settings || null;
}

function renderPresetList() {
  els.presetList.innerHTML = '';
  const presets = loadPresets();
  const defId = getDefaultPresetId();
  if (presets.length === 0) {
    els.presetList.innerHTML = '<p class="field-hint">No presets saved yet.</p>';
  }
  for (const p of presets) {
    const row = document.createElement('div');
    row.className = 'preset-row';

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'preset-star' + (p.id === defId ? ' on' : '');
    star.textContent = p.id === defId ? '★' : '☆';
    star.title = 'Auto-apply this preset when a clip loads';
    star.addEventListener('click', () => {
      localStorage.setItem(DEFAULT_PRESET_KEY, p.id === defId ? '' : p.id);
      renderPresetList();
    });

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'preset-apply';
    name.textContent = p.name;
    name.title = 'Apply this preset';
    name.addEventListener('click', () => applyPresetSettings(p.settings));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preset-del';
    del.textContent = '✕';
    del.title = 'Delete preset';
    del.addEventListener('click', () => {
      savePresets(loadPresets().filter((x) => x.id !== p.id));
      if (defId === p.id) localStorage.setItem(DEFAULT_PRESET_KEY, '');
      renderPresetList();
    });

    row.append(star, name, del);
    els.presetList.appendChild(row);
  }
}

function wirePresets() {
  const save = () => {
    const name = els.presetName.value.trim();
    if (!name) return;
    const presets = loadPresets();
    const existing = presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.settings = currentVideoSettings();
    } else {
      if (presets.length >= 3) {
        els.presetName.placeholder = 'Max 3 — delete one first';
        return;
      }
      presets.push({ id: `p-${Date.now()}`, name, settings: currentVideoSettings() });
    }
    savePresets(presets);
    els.presetName.value = '';
    renderPresetList();
  };
  els.presetSaveBtn.addEventListener('click', save);
  els.presetName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
  renderPresetList();
}

// --- overlay tab --------------------------------------------------------------------

// Adds a new overlay clip from a file (image or video). It's auto-selected
// (addOverlay selects it) so its size/crop/position controls appear, and
// the preview builds the element from state.overlays.
function addOverlayFromFile(file) {
  if (!file) return;
  addOverlay({ file, isVideo: file.type.startsWith('video/'), label: file.name });
  showTab('overlay');
}

// Fills the overlay controls from the selected overlay (or hides them).
function refreshOverlayPanel() {
  const o = selectedOverlay();
  els.overlaySizeGroup.classList.toggle('hidden', !o);
  if (!o) return;
  els.overlaySizeSlider.value = o.sizePercent;
  els.overlaySizeValue.textContent = `${o.sizePercent}%`;
  for (const key of Object.keys(els.cropSliders)) {
    els.cropSliders[key].value = o[key];
    els.cropValues[key].textContent = `${o[key]}%`;
  }
}

async function buildOverlayPresets() {
  try {
    const presets = await fetchOverlayPresets();
    els.overlayPresets.innerHTML = '';
    if (presets.length === 0) {
      els.overlayPresets.innerHTML = '<p class="field-hint">No bundled overlays yet — drop files into assets/overlays/ and they show up here for everyone.</p>';
      return;
    }
    for (const preset of presets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-item';
      const isVideo = /\.(webm|mp4|mov)$/i.test(preset.id);
      btn.innerHTML = isVideo
        ? `<span class="preset-thumb">🎞</span><span>${preset.label}</span>`
        : `<img class="preset-thumb" src="${preset.url}" alt="" /><span>${preset.label}</span>`;
      btn.addEventListener('click', async () => {
        addOverlayFromFile(await presetAsFile(preset));
      });
      els.overlayPresets.appendChild(btn);
    }
  } catch (err) {
    console.error('Failed to load overlay presets:', err);
  }
}

function wireOverlayControls() {
  els.overlayChooseBtn.addEventListener('click', () => els.overlayFile.click());
  els.overlayFile.addEventListener('change', () => {
    addOverlayFromFile(els.overlayFile.files[0] || null);
    els.overlayFile.value = '';
  });
  els.overlaySizeSlider.addEventListener('input', () => {
    const o = selectedOverlay();
    if (o) updateOverlay(o.id, { sizePercent: parseFloat(els.overlaySizeSlider.value) });
    els.overlaySizeValue.textContent = `${els.overlaySizeSlider.value}%`;
  });

  // Crop sliders — each trims 0-45% off one edge of the SELECTED overlay's
  // media. Opposite edges are clamped so they can never remove the whole
  // image.
  for (const key of Object.keys(els.cropSliders)) {
    els.cropSliders[key].addEventListener('input', () => {
      const o = selectedOverlay();
      if (!o) return;
      const opposite = { cropTop: 'cropBottom', cropBottom: 'cropTop', cropLeft: 'cropRight', cropRight: 'cropLeft' }[key];
      let val = parseFloat(els.cropSliders[key].value);
      const max = 90 - o[opposite]; // keep at least 10% of the axis
      if (val > max) {
        val = max;
        els.cropSliders[key].value = val;
      }
      updateOverlay(o.id, { [key]: val });
      els.cropValues[key].textContent = `${val}%`;
    });
  }

  els.overlayRemoveBtn.addEventListener('click', () => {
    const o = selectedOverlay();
    if (o) removeOverlay(o.id);
  });
}

// --- sound tab ----------------------------------------------------------------------

// Adds a new sound clip at the playhead. Its duration is read from the
// file's own metadata (sets the bar length + how much plays); it's
// auto-selected so its volume/remove controls appear.
function addSoundFromFile(file, label, url) {
  if (!file) return;
  const audioUrl = url || URL.createObjectURL(file);
  const start = getCurrentTime();
  const sound = addSound({
    file,
    label: label || file.name.replace(/\.[^.]+$/, ''),
    url: audioUrl,
    volumePercent: parseFloat(els.audioVolumeSlider.value),
    start,
    end: start + 1,
    offset: 0,
    duration: 1,
  });
  const probe = new Audio(audioUrl);
  probe.addEventListener(
    'loadedmetadata',
    () => {
      const dur = probe.duration || 1;
      updateSound(sound.id, { duration: dur, end: sound.start + dur });
    },
    { once: true }
  );
  showTab('sound');
}

// Fills the sound controls from the selected sound (or hides them).
function refreshSoundPanel() {
  const s = selectedSound();
  els.audioVolumeGroup.classList.toggle('hidden', !s);
  if (!s) return;
  els.audioVolumeSlider.value = s.volumePercent;
  els.audioVolumeValue.textContent = `${s.volumePercent}%`;
  els.audioCurrent.textContent = `${s.label} — drag its bar or edges on the timeline; ✂ Split cuts it.`;
}

async function buildSfxPresets() {
  try {
    const presets = await fetchSfxPresets();
    els.sfxPresets.innerHTML = '';
    if (presets.length === 0) {
      els.sfxPresets.innerHTML = '<p class="field-hint">No bundled sounds yet — drop files into assets/sfx/ and they show up here for everyone.</p>';
      return;
    }
    for (const preset of presets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-item';
      btn.innerHTML = `<span class="preset-thumb">🔊</span><span>${preset.label}</span>`;
      btn.addEventListener('click', async () => {
        // Audible feedback on pick — hearing the effect beats reading its name.
        new Audio(preset.url).play().catch(() => {});
        addSoundFromFile(await presetAsFile(preset), preset.label, preset.url);
      });
      els.sfxPresets.appendChild(btn);
    }
  } catch (err) {
    console.error('Failed to load sound presets:', err);
  }
}

function wireSoundControls() {
  els.soundChooseBtn.addEventListener('click', () => els.audioFile.click());
  els.audioFile.addEventListener('change', () => {
    addSoundFromFile(els.audioFile.files[0] || null);
    els.audioFile.value = '';
  });
  els.audioVolumeSlider.addEventListener('input', () => {
    const s = selectedSound();
    if (s) updateSound(s.id, { volumePercent: parseFloat(els.audioVolumeSlider.value) });
    els.audioVolumeValue.textContent = `${els.audioVolumeSlider.value}%`;
  });
  els.audioRemoveBtn.addEventListener('click', () => {
    const s = selectedSound();
    if (s) removeSound(s.id);
  });
}

// --- transitions tab -----------------------------------------------------------------

// The boundary (between two output-touching pieces) closest to the
// playhead — transitions never span a free-mode black gap.
function boundaryNearestPlayhead() {
  const outT = getCurrentOutputTime();
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < state.segments.length - 1; i++) {
    const seg = state.segments[i];
    const next = state.segments[i + 1];
    const outEnd = seg.outStart + (seg.end - seg.start);
    if (next.outStart - outEnd > 0.05) continue;
    const dist = Math.abs(outT - outEnd);
    if (dist < bestDist) {
      bestDist = dist;
      best = seg;
    }
  }
  return best;
}

function renderTransitionList() {
  els.transList.innerHTML = '';
  if (state.transitions.length === 0) {
    els.transList.innerHTML = '<p class="field-hint">None yet.</p>';
    return;
  }
  for (const tr of state.transitions) {
    const idx = state.segments.findIndex((s) => s.id === tr.afterSegmentId);
    const row = document.createElement('div');
    row.className = 'trans-row';
    const label = document.createElement('span');
    label.textContent = `⚡ White Flash · after piece ${idx + 1} · ${tr.duration.toFixed(1)}s`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger-btn trans-remove';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Remove transition');
    del.addEventListener('click', () => removeTransition(tr.id));
    row.appendChild(label);
    row.appendChild(del);
    els.transList.appendChild(row);
  }
}

function wireTransitionControls() {
  els.transDurationSlider.addEventListener('input', () => {
    els.transDurationValue.textContent = `${parseFloat(els.transDurationSlider.value).toFixed(1)}s`;
  });
  els.transAddBtn.addEventListener('click', () => {
    if (state.segments.length < 2) {
      els.transStatus.textContent = 'There’s only one piece — use ✂ Split to make a cut first.';
      return;
    }
    const seg = boundaryNearestPlayhead();
    if (!seg) {
      els.transStatus.textContent = 'No touching cut near the playhead (transitions can’t span a black gap).';
      return;
    }
    addTransitionAfter(seg.id, parseFloat(els.transDurationSlider.value));
    els.transStatus.textContent = 'Added — the ✦ badge on the cut marks it; click the badge (or ✕ below) to remove.';
  });
}

// --- captions tab -------------------------------------------------------------------

async function generateCaptions() {
  if (!state.source) {
    els.capStatus.textContent = 'Load a clip first.';
    return;
  }
  if (!state.whisper.ready) {
    els.capStatus.textContent = !state.whisper.binaryFound
      ? 'whisper-cli is missing — run "npm run build-whisper" in the project folder (or "brew install whisper-cpp" with Homebrew).'
      : 'No whisper model found — run "npm run fetch-whisper-model" in the project folder.';
    return;
  }

  els.capGenerateBtn.disabled = true;
  els.capGenerateBtn.textContent = 'Transcribing…';
  els.capStatus.textContent = 'Listening to the clip…';
  try {
    const segments = await transcribe(state.source, state.captionSettings.mode);
    if (segments.length === 0) {
      els.capStatus.textContent = 'No speech was detected in this clip.';
      return;
    }
    // Regenerating replaces the previous caption set — hand-made text
    // layers (group:null) are never touched.
    removeCaptionLayers();
    const s = state.captionSettings;
    const offset = s.timingOffset || 0;
    for (const seg of segments) {
      const start = Math.max(0, seg.start + offset);
      addTextLayer(
        {
          text: seg.text,
          style: s.style,
          fontId: s.fontId || defaultFontId(),
          fontSize: s.fontSize,
          color: s.color,
          dropShadow: s.dropShadow,
          xPercent: 50,
          yPercent: s.yPercent,
          start,
          end: start + (seg.end - seg.start),
          // Untouched whisper times, so the timing-nudge slider can always
          // re-derive from the original (see applyCaptionTiming).
          baseStart: seg.start,
          baseEnd: seg.end,
          group: 'caption',
        },
        { select: false }
      );
    }
    els.capStatus.textContent = `${segments.length} caption ${segments.length === 1 ? 'block' : 'blocks'} added — restyle them below, or click Generate again after changing the mode.`;
  } catch (err) {
    els.capStatus.textContent = `Transcription failed: ${err.message}`;
  } finally {
    els.capGenerateBtn.disabled = false;
    els.capGenerateBtn.textContent = 'Generate captions';
  }
}

function wireCaptionControls() {
  els.capModeButtons().forEach((btn) => {
    btn.addEventListener('click', () => {
      state.captionSettings.mode = btn.dataset.captionMode;
      els.capModeButtons().forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  els.capGenerateBtn.addEventListener('click', generateCaptions);

  els.capStyleButtons().forEach((btn) => {
    btn.addEventListener('click', () => {
      state.captionSettings.style = btn.dataset.capStyle;
      els.capStyleButtons().forEach((b) => b.classList.toggle('active', b === btn));
      applyCaptionStyle();
    });
  });

  els.capFontSelect.addEventListener('change', () => {
    state.captionSettings.fontId = els.capFontSelect.value;
    applyCaptionStyle();
  });

  buildColorPicker(els.capColorPicker, (hex) => {
    state.captionSettings.color = hex;
    markActiveSwatch(els.capColorPicker, hex);
    applyCaptionStyle();
  });
  markActiveSwatch(els.capColorPicker, state.captionSettings.color);

  els.capSizeSlider.addEventListener('input', () => {
    state.captionSettings.fontSize = parseFloat(els.capSizeSlider.value);
    els.capSizeValue.textContent = `${els.capSizeSlider.value}px`;
    applyCaptionStyle();
  });

  els.capShadowToggle.addEventListener('change', () => {
    state.captionSettings.dropShadow = els.capShadowToggle.checked;
    applyCaptionStyle();
  });

  els.capYSlider.addEventListener('input', () => {
    state.captionSettings.yPercent = parseFloat(els.capYSlider.value);
    els.capYValue.textContent = `${els.capYSlider.value}%`;
    applyCaptionStyle();
  });

  els.capTimingSlider.addEventListener('input', () => {
    const v = parseFloat(els.capTimingSlider.value);
    state.captionSettings.timingOffset = v;
    els.capTimingValue.textContent = `${v > 0 ? '+' : ''}${v.toFixed(2)}s`;
    applyCaptionTiming();
  });
}

// --- text tab -------------------------------------------------------------------------

function buildEmojiPanel() {
  els.emojiPanel.innerHTML = '';
  for (const emoji of CURATED_EMOJIS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-item';
    btn.textContent = emoji;
    btn.addEventListener('click', () => insertEmojiAtCursor(emoji));
    els.emojiPanel.appendChild(btn);
  }
}

function insertEmojiAtCursor(emoji) {
  const layer = selectedLayer();
  if (!layer) return;
  const input = els.textInput;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const value = input.value;
  input.value = value.slice(0, start) + emoji + value.slice(end);
  const cursor = start + emoji.length;
  input.focus();
  input.setSelectionRange(cursor, cursor);
  updateLayer(layer.id, { text: input.value });
}

function wireTextControls() {
  // Same "new text at the playhead" the timeline's + Text button does —
  // reachable from the tab itself so text can be created without leaving
  // the panel.
  els.textAddBtn.addEventListener('click', () => {
    const duration = sourceDuration();
    const t = getCurrentTime();
    addTextLayer({
      start: duration > 0 ? Math.min(t, Math.max(0, duration - 0.5)) : 0,
      end: duration > 0 ? Math.min(t + 3, duration) : 3,
    });
  });

  els.textInput.addEventListener('input', () => {
    const layer = selectedLayer();
    if (layer) updateLayer(layer.id, { text: els.textInput.value });
  });

  els.emojiBtn.addEventListener('click', () => {
    els.emojiPanel.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!els.emojiPanel.classList.contains('hidden') && !els.emojiPanel.contains(e.target) && e.target !== els.emojiBtn) {
      els.emojiPanel.classList.add('hidden');
    }
  });

  els.styleButtons().forEach((btn) => {
    btn.addEventListener('click', () => {
      const layer = selectedLayer();
      if (layer) updateLayer(layer.id, { style: btn.dataset.captionStyle });
    });
  });

  els.fontSelect.addEventListener('change', () => {
    const layer = selectedLayer();
    if (layer) updateLayer(layer.id, { fontId: els.fontSelect.value });
  });

  buildColorPicker(els.colorPicker, (hex) => {
    const layer = selectedLayer();
    if (layer) updateLayer(layer.id, { color: hex });
  });

  els.fontSizeSlider.addEventListener('input', () => {
    els.fontSizeValue.textContent = `${els.fontSizeSlider.value}px`;
    const layer = selectedLayer();
    if (layer) updateLayer(layer.id, { fontSize: parseFloat(els.fontSizeSlider.value) });
  });

  els.dropShadowToggle.addEventListener('change', () => {
    const layer = selectedLayer();
    if (layer) updateLayer(layer.id, { dropShadow: els.dropShadowToggle.checked });
  });

  const commitTime = () => {
    const layer = selectedLayer();
    if (!layer) return;
    const duration = sourceDuration() || Infinity;
    let start = parseFloat(els.layerStart.value);
    let end = parseFloat(els.layerEnd.value);
    if (!Number.isFinite(start)) start = layer.start;
    if (!Number.isFinite(end)) end = layer.end;
    start = Math.max(0, Math.min(start, duration));
    end = Math.max(start + 0.2, Math.min(end, duration));
    updateLayer(layer.id, { start, end });
  };
  els.layerStart.addEventListener('change', commitTime);
  els.layerEnd.addEventListener('change', commitTime);

  els.duplicateBtn.addEventListener('click', () => {
    const layer = selectedLayer();
    if (!layer) return;
    const copy = { ...layer };
    delete copy.id;
    // Nudged down slightly so the copy is visibly a separate thing.
    copy.yPercent = Math.min(100, copy.yPercent + 8);
    addTextLayer(copy);
  });

  els.deleteBtn.addEventListener('click', () => {
    const layer = selectedLayer();
    if (layer) removeLayer(layer.id);
  });
}

// --- refresh from state -------------------------------------------------------------

// Fills the text panel's inputs from the selected layer. Inputs the user is
// actively typing in are skipped — refilling them would jump the cursor.
function refreshTextPanel() {
  const layer = selectedLayer();
  els.noLayerMsg.classList.toggle('hidden', !!layer);
  els.textControls.classList.toggle('hidden', !layer);
  if (!layer) return;

  if (document.activeElement !== els.textInput) els.textInput.value = layer.text;
  els.styleButtons().forEach((b) => b.classList.toggle('active', b.dataset.captionStyle === layer.style));
  if (document.activeElement !== els.fontSelect) els.fontSelect.value = layer.fontId;
  markActiveSwatch(els.colorPicker, layer.color);
  els.fontSizeSlider.value = layer.fontSize;
  els.fontSizeValue.textContent = `${layer.fontSize}px`;
  els.dropShadowToggle.checked = layer.dropShadow;
  if (document.activeElement !== els.layerStart) els.layerStart.value = layer.start.toFixed(2);
  if (document.activeElement !== els.layerEnd) els.layerEnd.value = layer.end.toFixed(2);
}

function refreshVideoPanel() {
  els.zoomSlider.value = Math.round(state.zoom * 100);
  els.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
  els.blurSlider.value = state.blur;
  els.blurValue.textContent = `${state.blur}%`;
  els.panXSlider.value = state.panX;
  els.panXValue.textContent = String(state.panX);
  els.panYSlider.value = state.panY;
  els.panYValue.textContent = String(state.panY);
  els.speedSlider.value = state.speed;
  els.speedValue.textContent = `${state.speed.toFixed(2)}x`;
  els.mirrorToggle.checked = state.mirror;
}

export function initPanel() {
  lookupElements();
  buildAspectButtons();
  buildFontOptions(els.fontSelect);
  buildFontOptions(els.capFontSelect);
  buildEmojiPanel();
  wireVideoControls();
  wireTextControls();
  wireCaptionControls();
  wireOverlayControls();
  wireSoundControls();
  wireTransitionControls();
  buildOverlayPresets();
  buildSfxPresets();
  refreshVideoPanel();
  refreshTextPanel();
  refreshOverlayPanel();
  refreshSoundPanel();
  renderTransitionList();

  const tabForKind = { layer: 'text', overlay: 'overlay', sound: 'sound' };

  for (const [name, tab] of Object.entries(els.tabs)) {
    tab.btn.addEventListener('click', () => {
      // Switching to a tab that isn't the selected clip's own tab deselects
      // (Video/Captions/Transitions always do). Text/Overlay/Sound keep a
      // matching clip selected so its controls stay shown.
      if (tabForKind[state.sel && state.sel.kind] !== name) selectLayer(null);
      showTab(name);
    });
  }

  // Selecting any clip routes to its tab and fills its controls; deselecting
  // while on a clip tab backs out to Video.
  on('selection', () => {
    const kind = state.sel && state.sel.kind;
    if (tabForKind[kind]) showTab(tabForKind[kind]);
    else if (['text', 'overlay', 'sound'].includes(activeTab())) showTab('video');
    refreshTextPanel();
    refreshOverlayPanel();
    refreshSoundPanel();
  });
  on('layers', refreshTextPanel);
  on('settings', () => {
    refreshOverlayPanel();
    refreshSoundPanel();
  });
  on('segments', renderTransitionList);

  // Auto-apply the default (★) preset whenever a clip loads, so an imported
  // clip lands in the user's template.
  on('source', () => {
    const s = activePresetSettings();
    if (s) applyPresetSettings(s);
  });
}
