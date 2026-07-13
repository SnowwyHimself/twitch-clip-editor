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
  outputDuration,
  addTransitionAfter,
  removeTransition,
  orderedPieces,
  addOverlay,
  updateOverlay,
  removeOverlay,
  selectedOverlay,
  addSound,
  updateSound,
  removeSound,
  selectedSound,
  setAudio,
  clampVolumePercent,
  setColor,
  commitVideoSettings,
  applyVideoSettingsToAllPieces,
  editTargetPieces,
  pieceSettings,
  clampColorValue,
  addKeyframe,
  removeKeyframe,
  clearKeyframes,
  keyframeAt,
  keyframeTransformAt,
  clampCropValue,
  setFaceTrackEnabled,
  setFaceTrackZoom,
  clearFaceTrack,
  restoreFaceTrack,
  faceTrackActive,
} from './state.js';
import {
  getCurrentTime,
  getCurrentOutputTime,
  seek,
  beginFaceSelect,
  cancelFaceSelect,
  isFaceSelecting,
} from './preview.js';
import { trackSelectedFace } from './facetrack.js';
import { confirmDialog } from './confirm.js';
import { icon } from './icons.js';
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
    panelVideo: byId('panel-video'),
    layoutButtons: () => document.querySelectorAll('#layout-group [data-layout]'),
    splitControls: byId('split-controls'),
    facecamZoom: byId('facecam-zoom'),
    facecamZoomValue: byId('facecam-zoom-value'),
    gameplayZoom: byId('gameplay-zoom'),
    gameplayZoomValue: byId('gameplay-zoom-value'),
    perclipRow: byId('perclip-row'),
    perclipLabel: byId('perclip-label'),
    applyAllBtn: byId('apply-all-btn'),
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
    kfPunchBtn: byId('kf-punch-btn'),
    faceTrackBtn: byId('face-track-btn'),
    facetrackToggleRow: byId('facetrack-toggle-row'),
    facetrackToggle: byId('facetrack-toggle'),
    facetrackZoomRow: byId('facetrack-zoom-row'),
    facetrackZoom: byId('facetrack-zoom'),
    facetrackZoomValue: byId('facetrack-zoom-value'),
    facetrackStatus: byId('facetrack-status'),
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
    audioMuteToggle: byId('audio-mute-toggle'),
    audioDuckToggle: byId('audio-duck-toggle'),
    audioFadeInSlider: byId('audio-fadein-slider'),
    audioFadeInValue: byId('audio-fadein-value'),
    audioFadeOutSlider: byId('audio-fadeout-slider'),
    audioFadeOutValue: byId('audio-fadeout-value'),
    audioCurrent: byId('audio-current'),
    audioRemoveBtn: byId('audio-remove-btn'),
    // Main-clip audio (Video tab)
    clipVolumeSlider: byId('clip-volume-slider'),
    clipVolumeValue: byId('clip-volume-value'),
    clipMuteToggle: byId('clip-mute-toggle'),
    clipFadeInSlider: byId('clip-fadein-slider'),
    clipFadeInValue: byId('clip-fadein-value'),
    clipFadeOutSlider: byId('clip-fadeout-slider'),
    clipFadeOutValue: byId('clip-fadeout-value'),
    colorBrightness: byId('color-brightness'),
    colorBrightnessValue: byId('color-brightness-value'),
    colorContrast: byId('color-contrast'),
    colorContrastValue: byId('color-contrast-value'),
    colorSaturation: byId('color-saturation'),
    colorSaturationValue: byId('color-saturation-value'),
    colorResetBtn: byId('color-reset-btn'),
    safeZoneToggle: byId('safe-zone-toggle'),
    safeZone: byId('safe-zone'),
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
    layerFullToggle: byId('layer-full-toggle'),
    duplicateBtn: byId('duplicate-layer-btn'),
    deleteBtn: byId('delete-layer-btn'),
    noLayerMsg: byId('panel-text-empty'),
    textControls: byId('panel-text-controls'),
    // Captions tab
    capMaxWordsSlider: byId('cap-maxwords-slider'),
    capMaxWordsValue: byId('cap-maxwords-value'),
    capPunctToggle: byId('cap-punct-toggle'),
    capGenerateBtn: byId('captions-generate-btn'),
    capStatus: byId('captions-status'),
    capStyleButtons: () => document.querySelectorAll('[data-cap-style]'),
    capAnimButtons: () => document.querySelectorAll('[data-cap-anim]'),
    capFontSelect: byId('cap-font-select'),
    capColorPicker: byId('cap-color-picker'),
    capSizeSlider: byId('cap-size-slider'),
    capSizeValue: byId('cap-size-value'),
    capShadowToggle: byId('cap-shadow-toggle'),
    capYSlider: byId('cap-y-slider'),
    capYValue: byId('cap-y-value'),
    capTimingSlider: byId('cap-timing-slider'),
    capTimingInput: byId('cap-timing-input'),
    capTimingValue: byId('cap-timing-value'),
    transcriptGroup: byId('transcript-group'),
    transcriptList: byId('transcript-list'),
    capPresetList: byId('cap-preset-list'),
    capPresetName: byId('cap-preset-name'),
    capPresetSaveBtn: byId('cap-preset-save-btn'),
    captionsVisibleToggle: byId('captions-visible-toggle'),
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
  // Video reframe/blur/grade edits write the global mirror then commit it onto
  // the selected piece(s) via commitVideoSettings (B6 per-piece).
  const commitVideo = () => commitVideoSettings(getCurrentOutputTime());
  els.zoomSlider.addEventListener('input', () => {
    state.zoom = parseFloat(els.zoomSlider.value) / 100;
    els.zoomValue.textContent = `${els.zoomSlider.value}%`;
    keyframeEditIfActive();
    commitVideo();
  });
  els.blurSlider.addEventListener('input', () => {
    state.blur = parseFloat(els.blurSlider.value);
    els.blurValue.textContent = `${els.blurSlider.value}%`;
    commitVideo();
  });
  els.panXSlider.addEventListener('input', () => {
    state.panX = parseFloat(els.panXSlider.value);
    els.panXValue.textContent = els.panXSlider.value;
    keyframeEditIfActive();
    commitVideo();
  });
  els.panYSlider.addEventListener('input', () => {
    state.panY = parseFloat(els.panYSlider.value);
    els.panYValue.textContent = els.panYSlider.value;
    keyframeEditIfActive();
    commitVideo();
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
  els.clipVolumeSlider.addEventListener('input', () => {
    setAudio({ volumePercent: clampVolumePercent(els.clipVolumeSlider.value) });
    els.clipVolumeValue.textContent = `${els.clipVolumeSlider.value}%`;
  });
  els.clipMuteToggle.addEventListener('change', () => {
    setAudio({ muted: els.clipMuteToggle.checked });
  });
  els.clipFadeInSlider.addEventListener('input', () => {
    setAudio({ fadeIn: parseFloat(els.clipFadeInSlider.value) });
    els.clipFadeInValue.textContent = `${parseFloat(els.clipFadeInSlider.value).toFixed(1)}s`;
  });
  els.clipFadeOutSlider.addEventListener('input', () => {
    setAudio({ fadeOut: parseFloat(els.clipFadeOutSlider.value) });
    els.clipFadeOutValue.textContent = `${parseFloat(els.clipFadeOutSlider.value).toFixed(1)}s`;
  });
  const wireColor = (slider, valueEl, key) => {
    slider.addEventListener('input', () => {
      const v = clampColorValue(slider.value);
      state.color = { ...state.color, [key]: v };
      commitVideo();
      valueEl.textContent = String(v);
    });
  };
  wireColor(els.colorBrightness, els.colorBrightnessValue, 'brightness');
  wireColor(els.colorContrast, els.colorContrastValue, 'contrast');
  wireColor(els.colorSaturation, els.colorSaturationValue, 'saturation');
  els.applyAllBtn.addEventListener('click', async () => {
    const primary = editTargetPieces(getCurrentOutputTime())[0];
    if (!primary) return;
    const ok = await confirmDialog({
      title: 'Apply to all clips?',
      note: "Copies this clip's zoom, position, blur and colour to every clip on the timeline.",
      confirmLabel: 'Apply to all',
    });
    if (ok) applyVideoSettingsToAllPieces(pieceSettings(primary));
  });
  els.colorResetBtn.addEventListener('click', () => {
    state.color = { brightness: 0, contrast: 0, saturation: 0 };
    commitVideo();
    refreshVideoPanel();
  });
  // Safe-zone guides — a preview aid, persisted (not in the project/export).
  const SAFE_ZONE_KEY = 'clipEditor.safeZones.v1';
  const applySafeZone = (on) => {
    els.safeZone.classList.toggle('hidden', !on);
    els.safeZoneToggle.checked = on;
  };
  els.safeZoneToggle.addEventListener('change', () => {
    localStorage.setItem(SAFE_ZONE_KEY, els.safeZoneToggle.checked ? '1' : '0');
    applySafeZone(els.safeZoneToggle.checked);
  });
  applySafeZone(localStorage.getItem(SAFE_ZONE_KEY) === '1');
  // Position lock: when on, applying a preset never moves the clip (panX/panY
  // stay put). Persisted so the choice sticks across sessions. Default on —
  // position is per-clip framing, not something a shared "look" should hijack.
  els.panLockToggle.checked = positionLocked();
  els.panLockToggle.addEventListener('change', () => {
    localStorage.setItem(PAN_LOCK_KEY, els.panLockToggle.checked ? '1' : '0');
  });
  // Layout: Fill vs Facecam split.
  els.layoutButtons().forEach((btn) => {
    btn.addEventListener('click', () => {
      state.layout = btn.dataset.layout;
      emit('settings');
    });
  });
  els.facecamZoom.addEventListener('input', () => {
    state.split.facecam.zoom = parseFloat(els.facecamZoom.value) / 100;
    els.facecamZoomValue.textContent = `${els.facecamZoom.value}%`;
    emit('settings');
  });
  els.gameplayZoom.addEventListener('input', () => {
    state.split.gameplay.zoom = parseFloat(els.gameplayZoom.value) / 100;
    els.gameplayZoomValue.textContent = `${els.gameplayZoom.value}%`;
    emit('settings');
  });

  wirePresets();
  wireKeyframes();
}

function updateLayoutUI() {
  const split = state.layout === 'split';
  els.panelVideo.classList.toggle('split-mode', split);
  els.splitControls.classList.toggle('hidden', !split);
  els.layoutButtons().forEach((b) => b.classList.toggle('active', b.dataset.layout === state.layout));
  els.facecamZoom.value = Math.round((state.split.facecam.zoom || 1) * 100);
  els.facecamZoomValue.textContent = `${els.facecamZoom.value}%`;
  els.gameplayZoom.value = Math.round((state.split.gameplay.zoom || 1) * 100);
  els.gameplayZoomValue.textContent = `${els.gameplayZoom.value}%`;
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
  els.kfPunchBtn.addEventListener('click', punchInAtPlayhead);
  els.faceTrackBtn.addEventListener('click', runFaceTrack);
  els.facetrackToggle.addEventListener('change', () => setFaceTrackEnabled(els.facetrackToggle.checked));
  els.facetrackZoom.addEventListener('input', () => {
    setFaceTrackZoom(els.facetrackZoom.value);
    els.facetrackZoomValue.textContent = `${(state.faceTrack.zoom || 1).toFixed(1)}x`;
  });
  on('facetrack', renderFaceTrackUI);
  renderFaceTrackUI();
  on('keyframes', renderKeyframeUI);
  // As the playhead moves over a keyframed range, show the interpolated
  // zoom/position on the sliders (read-out) and light ◆ on exact keyframes.
  on('time', () => {
    if (state.keyframes.length) syncKeyframeSliders();
    renderKeyframeUI();
  });
  renderKeyframeUI();
}

// One-click punch-in: a quick zoom-in centred on the playhead. Drops a
// keyframe at the current framing now, then a zoomed-in one ~0.5s later that
// holds — the signature CapCut/Reels emphasis move. Uses the same keyframe
// engine (so preview and export already match), and keeps the current pan.
const PUNCH_DURATION = 0.5;
function punchInAtPlayhead() {
  const dur = sourceDuration();
  if (dur <= 0) return;
  let start = Math.min(getCurrentTime(), Math.max(0, dur - 0.1));
  let end = Math.min(dur - 0.01, start + PUNCH_DURATION);
  // Near the clip's end there isn't room ahead — pull the ramp back instead.
  if (end - start < 0.1) start = Math.max(0, end - PUNCH_DURATION);
  const target = state.zoom < 1.3 ? 1.4 : Math.min(3, state.zoom + 0.2);
  addKeyframe(start, { zoom: state.zoom, panX: state.panX, panY: state.panY });
  addKeyframe(end, { zoom: target, panX: state.panX, panY: state.panY });
  seek(end); // land on the punched-in framing so the effect is visible
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

// Status line helper — writes the message and flags real failures so they're
// visibly distinct (styled red) instead of blending into the hint text.
function setFaceStatus(text, isError = false) {
  els.facetrackStatus.textContent = text;
  els.facetrackStatus.classList.toggle('error', !!isError);
}

// Syncs ONLY the toggle row + checkbox to the current state — deliberately
// leaves the status line alone so a just-set outcome/error message survives
// (renderFaceTrackUI, which also rewrites the status, would clobber it).
function syncFaceTrackToggle() {
  const hasSamples = state.faceTrack.samples.length > 0;
  els.facetrackToggleRow.classList.toggle('hidden', !hasSamples);
  els.facetrackToggle.checked = faceTrackActive();
  // Tracked-zoom slider shows only while tracking is actually on.
  els.facetrackZoomRow.classList.toggle('hidden', !faceTrackActive());
  els.facetrackZoom.value = state.faceTrack.zoom || 1;
  els.facetrackZoomValue.textContent = `${(state.faceTrack.zoom || 1).toFixed(1)}x`;
}

// Auto-reframe: user picks a face on the preview, then we scan + follow it.
async function runFaceTrack() {
  if (!state.source) {
    setFaceStatus('Load a clip first, then select a face.');
    return;
  }
  // A second click on the button (while "Click a face to follow" is up) cancels
  // the selection — the in-flight beginFaceSelect resolves null and the branch
  // below restores whatever was there before.
  if (isFaceSelecting()) {
    cancelFaceSelect();
    return;
  }
  const btn = els.faceTrackBtn;
  const originalLabel = btn.textContent;
  // Snapshot before clearing, so cancelling leaves any prior tracking untouched.
  const priorFaceTrack = { enabled: state.faceTrack.enabled, samples: state.faceTrack.samples.slice() };
  clearFaceTrack(); // show the plain view so the tap maps cleanly to the footage
  setFaceStatus('Click the face you want to follow in the preview (Esc to cancel).');
  const target = await beginFaceSelect();
  if (!target) {
    restoreFaceTrack(priorFaceTrack);
    syncFaceTrackToggle();
    setFaceStatus(
      priorFaceTrack.samples.length
        ? 'Cancelled — kept the previous tracking. Turn it on/off below or select a new face.'
        : 'Cancelled. Select a face to start auto-reframing.'
    );
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  setFaceStatus('Scanning the clip and locking onto that face…');
  try {
    const result = await trackSelectedFace(target, {
      onProgress: (p) => setFaceStatus(`Following that face… ${Math.round(p * 100)}%`),
    });
    if (result.ok) {
      setFaceStatus('Tracking that face — the clip follows it left/right. Turn off to revert.');
    } else if (result.reason === 'no-face') {
      setFaceStatus('Couldn’t find a face to follow — try a clearer, more face-forward clip.', true);
    } else if (result.reason === 'load-failed') {
      setFaceStatus('The face detector could not load. Check your connection and try again.', true);
    } else {
      setFaceStatus('Couldn’t start tracking — load a clip and try again.', true);
    }
  } catch (err) {
    setFaceStatus(`Face tracking hit an error: ${(err && err.message) || 'unknown'}. Please try again.`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
    // Only re-sync the toggle here — NOT the full renderFaceTrackUI — so the
    // success/error message set just above stays on screen.
    syncFaceTrackToggle();
  }
}

// Reflects the current face-track state in the toggle + status line. Called on
// the 'facetrack' event and at init; runFaceTrack uses syncFaceTrackToggle
// instead so its own outcome message isn't overwritten.
function renderFaceTrackUI() {
  syncFaceTrackToggle();
  const hasSamples = state.faceTrack.samples.length > 0;
  if (faceTrackActive()) {
    setFaceStatus(
      'Tracking a face — the clip follows it left/right. Turn off to revert, or select a different face.'
    );
  } else if (hasSamples) {
    setFaceStatus('Face tracking is off (kept). Turn it back on, or select a new face.');
  } else {
    setFaceStatus(
      'Auto-reframe: follows a chosen face left/right, keeping the frame filled. Works best on face-forward clips.'
    );
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

// The current hand-made text layers, captured for a preset template. Auto
// caption layers (group:'caption') are never included — they belong to a
// specific clip's transcript, not a reusable template. Duration is stored so
// applied layers start at t=0 and keep their length.
function currentPresetTextLayers() {
  return state.layers
    .filter((l) => l.group !== 'caption' && l.text && l.text.trim())
    .map((l) => ({
      text: l.text,
      style: l.style,
      fontId: l.fontId,
      fontSize: l.fontSize,
      color: l.color,
      dropShadow: l.dropShadow,
      xPercent: l.xPercent,
      yPercent: l.yPercent,
      wrapWidth: l.wrapWidth,
      duration: Math.max(0.1, (l.end || 0) - (l.start || 0)),
    }));
}

function applyPresetSettings(s) {
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
  // Commit the preset's reframe/blur onto the edit-target piece(s) (B6). speed
  // and mirror stay global; commitVideoSettings still emits 'settings' for them.
  commitVideoSettings(getCurrentOutputTime());
}

// Adds a preset's saved text layers to the current clip — each starts at t=0
// and keeps its saved duration, so a preset can act as a real template (a
// styled headline already placed).
function addPresetTextLayers(textLayers) {
  if (!Array.isArray(textLayers)) return;
  for (const t of textLayers) {
    const { duration, ...fields } = t;
    addTextLayer({ ...fields, start: 0, end: Math.max(0.1, duration || 3), group: null }, { select: false });
  }
}

// Applies a whole preset: video settings plus any template text layers.
export function applyPreset(preset) {
  if (!preset) return;
  applyPresetSettings(preset.settings);
  addPresetTextLayers(preset.textLayers);
}

// The default (★) preset, applied on clip import (main.js/init call this).
export function activePreset() {
  const id = getDefaultPresetId();
  return loadPresets().find((p) => p.id === id) || null;
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
    star.innerHTML = icon('star');
    star.title = 'Auto-apply this preset when a clip loads';
    star.addEventListener('click', () => {
      localStorage.setItem(DEFAULT_PRESET_KEY, p.id === defId ? '' : p.id);
      renderPresetList();
    });

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'preset-apply';
    const textCount = (p.textLayers && p.textLayers.length) || 0;
    name.textContent = p.name;
    if (textCount > 0) {
      // Small badge so it's clear this preset is a template that also drops in
      // text layers, not just video settings.
      const badge = document.createElement('span');
      badge.className = 'preset-text-badge';
      badge.textContent = 'T';
      badge.title = `Includes ${textCount} text layer${textCount === 1 ? '' : 's'}`;
      name.appendChild(badge);
    }
    name.title = textCount > 0 ? `Apply this preset (+${textCount} text)` : 'Apply this preset';
    name.addEventListener('click', () => applyPreset(p));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preset-del';
    del.innerHTML = icon('x', 12);
    del.title = 'Delete preset';
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Delete preset?',
        itemName: p.name,
        confirmLabel: 'Delete',
      });
      if (!ok) return;
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
    const textLayers = currentPresetTextLayers();
    const existing = presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.settings = currentVideoSettings();
      existing.textLayers = textLayers;
    } else {
      if (presets.length >= 3) {
        els.presetName.placeholder = 'Max 3 — delete one first';
        return;
      }
      presets.push({ id: `p-${Date.now()}`, name, settings: currentVideoSettings(), textLayers });
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
        ? `<span class="preset-thumb">${icon('film')}</span><span>${preset.label}</span>`
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
      const val = clampCropValue(o, key, parseFloat(els.cropSliders[key].value));
      els.cropSliders[key].value = val;
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
      updateSound(sound.id, { duration: dur, end: sound.start + dur }, { history: false });
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
  els.audioMuteToggle.checked = !!s.muted;
  els.audioDuckToggle.checked = !!s.duck;
  els.audioFadeInSlider.value = s.fadeIn || 0;
  els.audioFadeInValue.textContent = `${(s.fadeIn || 0).toFixed(1)}s`;
  els.audioFadeOutSlider.value = s.fadeOut || 0;
  els.audioFadeOutValue.textContent = `${(s.fadeOut || 0).toFixed(1)}s`;
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
      btn.innerHTML = `<span class="preset-thumb">${icon('music')}</span><span>${preset.label}</span>`;
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
  els.audioMuteToggle.addEventListener('change', () => {
    const s = selectedSound();
    if (s) updateSound(s.id, { muted: els.audioMuteToggle.checked });
  });
  els.audioDuckToggle.addEventListener('change', () => {
    const s = selectedSound();
    if (s) updateSound(s.id, { duck: els.audioDuckToggle.checked });
  });
  els.audioFadeInSlider.addEventListener('input', () => {
    const s = selectedSound();
    if (s) updateSound(s.id, { fadeIn: parseFloat(els.audioFadeInSlider.value) });
    els.audioFadeInValue.textContent = `${parseFloat(els.audioFadeInSlider.value).toFixed(1)}s`;
  });
  els.audioFadeOutSlider.addEventListener('input', () => {
    const s = selectedSound();
    if (s) updateSound(s.id, { fadeOut: parseFloat(els.audioFadeOutSlider.value) });
    els.audioFadeOutValue.textContent = `${parseFloat(els.audioFadeOutSlider.value).toFixed(1)}s`;
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
  const pieces = orderedPieces();
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < pieces.length - 1; i++) {
    if (pieces[i + 1].outStart - pieces[i].outEnd > 0.05) continue; // no gap-spanning
    const dist = Math.abs(outT - pieces[i].outEnd);
    if (dist < bestDist) {
      bestDist = dist;
      best = pieces[i];
    }
  }
  return best; // { kind, id, outStart, outEnd } | null
}

function renderTransitionList() {
  els.transList.innerHTML = '';
  if (state.transitions.length === 0) {
    els.transList.innerHTML = '<p class="field-hint">None yet.</p>';
    return;
  }
  for (const tr of state.transitions) {
    const idx = orderedPieces().findIndex((p) => p.id === tr.afterSegmentId);
    const row = document.createElement('div');
    row.className = 'trans-row';
    const label = document.createElement('span');
    label.textContent = `⚡ White Flash · after piece ${idx + 1} · ${tr.duration.toFixed(1)}s`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger-btn trans-remove';
    del.innerHTML = icon('x', 12);
    del.setAttribute('aria-label', 'Remove transition');
    del.addEventListener('click', () => removeTransition(tr.id));
    row.appendChild(label);
    row.appendChild(del);
    els.transList.appendChild(row);
  }
}

let transitionType = 'white-flash';

function wireTransitionControls() {
  document.querySelectorAll('[data-trans-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      transitionType = btn.dataset.transType;
      document.querySelectorAll('[data-trans-type]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
  els.transDurationSlider.addEventListener('input', () => {
    els.transDurationValue.textContent = `${parseFloat(els.transDurationSlider.value).toFixed(1)}s`;
  });
  els.transAddBtn.addEventListener('click', () => {
    if (orderedPieces().length < 2) {
      els.transStatus.textContent = 'There’s only one piece — split, or add another clip, to make a boundary first.';
      return;
    }
    const piece = boundaryNearestPlayhead();
    if (!piece) {
      els.transStatus.textContent = 'No touching boundary near the playhead (transitions can’t span a black gap).';
      return;
    }
    addTransitionAfter(piece.id, parseFloat(els.transDurationSlider.value), transitionType);
    els.transStatus.textContent = 'Added — the ✦ badge on the cut marks it; click the badge (or ✕ below) to remove.';
  });
}

// --- captions tab -------------------------------------------------------------------

// Duration guardrails (seconds) for a caption block, layered on top of the A2
// silence clamp: a block never flashes shorter than MIN or lingers past MAX.
const CAP_MIN_BLOCK = 0.4;
const CAP_MAX_BLOCK = 4;

// Strips trailing commas/periods (keeps ? and !), used for punctuation cleanup.
function cleanCaptionWord(text) {
  return text.replace(/[.,]+(?=\s|$)/g, '').trim();
}

// Groups word-level whisper segments into N-word caption blocks, optionally
// cleaning punctuation, and applies the duration guardrails. Each block keeps
// baseStart/baseEnd (its own span) so the timing-nudge slider stays re-derivable.
function groupCaptionWords(words, maxWords, cleanup) {
  const n = Math.max(1, Math.min(5, maxWords || 1));
  const blocks = [];
  for (let i = 0; i < words.length; i += n) {
    const chunk = words.slice(i, i + n);
    const start = chunk[0].start;
    let end = chunk[chunk.length - 1].end;
    const dur = end - start;
    if (dur < CAP_MIN_BLOCK) end = start + CAP_MIN_BLOCK;
    else if (dur > CAP_MAX_BLOCK) end = start + CAP_MAX_BLOCK;
    const text = chunk
      .map((w) => (cleanup ? cleanCaptionWord(w.text) : w.text))
      .filter(Boolean)
      .join(' ');
    if (text) blocks.push({ start, end, text });
  }
  return blocks;
}

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
    // Always transcribe word-level, then group into N-word blocks client-side
    // (see groupCaptionWords) so "words per block" and punctuation cleanup are
    // just post-processing, not a re-transcription.
    const words = await transcribe(state.source, 'words');
    if (words.length === 0) {
      els.capStatus.textContent = 'No speech was detected in this clip.';
      return;
    }
    const s = state.captionSettings;
    const segments = groupCaptionWords(words, s.maxWords || 1, !!s.punctuationCleanup);
    // Regenerating replaces the previous caption set — hand-made text
    // layers (group:null) are never touched.
    removeCaptionLayers();
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
          animation: s.animation || 'none',
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
    els.capStatus.textContent = `${segments.length} caption ${segments.length === 1 ? 'block' : 'blocks'} added — restyle them below, or regenerate after changing the settings.`;
  } catch (err) {
    els.capStatus.textContent = `Transcription failed: ${err.message}`;
  } finally {
    els.capGenerateBtn.disabled = false;
    els.capGenerateBtn.textContent = 'Generate captions';
  }
}

function wireCaptionControls() {
  els.capMaxWordsSlider.addEventListener('input', () => {
    state.captionSettings.maxWords = parseInt(els.capMaxWordsSlider.value, 10) || 1;
    els.capMaxWordsValue.textContent = String(state.captionSettings.maxWords);
  });
  els.capPunctToggle.addEventListener('change', () => {
    state.captionSettings.punctuationCleanup = els.capPunctToggle.checked;
  });

  els.capGenerateBtn.addEventListener('click', generateCaptions);

  els.capStyleButtons().forEach((btn) => {
    btn.addEventListener('click', () => {
      state.captionSettings.style = btn.dataset.capStyle;
      els.capStyleButtons().forEach((b) => b.classList.toggle('active', b === btn));
      applyCaptionStyle();
    });
  });

  els.capAnimButtons().forEach((btn) => {
    btn.addEventListener('click', () => {
      state.captionSettings.animation = btn.dataset.capAnim;
      els.capAnimButtons().forEach((b) => b.classList.toggle('active', b === btn));
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

  // Slider and numeric input both drive timingOffset (±3s); each keeps the
  // other in sync. The numeric box allows an exact value beyond easy dragging.
  const setTimingOffset = (raw, { fromInput = false } = {}) => {
    let v = parseFloat(raw);
    if (!Number.isFinite(v)) return;
    v = Math.max(-3, Math.min(3, v));
    state.captionSettings.timingOffset = v;
    els.capTimingSlider.value = v;
    if (!fromInput) els.capTimingInput.value = v.toFixed(2);
    els.capTimingValue.textContent = `${v > 0 ? '+' : ''}${v.toFixed(2)}s`;
    applyCaptionTiming();
  };
  els.capTimingSlider.addEventListener('input', () => setTimingOffset(els.capTimingSlider.value));
  els.capTimingInput.addEventListener('input', () => setTimingOffset(els.capTimingInput.value, { fromInput: true }));
  els.capTimingInput.addEventListener('blur', () => {
    els.capTimingInput.value = (state.captionSettings.timingOffset || 0).toFixed(2);
  });
  els.captionsVisibleToggle.addEventListener('change', () => {
    state.captionsHidden = !els.captionsVisibleToggle.checked;
    emit('layers'); // re-evaluate caption visibility in the preview + timeline
  });
  on('layers', renderTranscript);
  renderTranscript();
  wireCaptionPresets();
}

// Pushes state.captionSettings back onto the Captions-tab controls (used after
// applying a preset, which sets several fields at once).
function syncCaptionControls() {
  const s = state.captionSettings;
  els.capMaxWordsSlider.value = s.maxWords || 1;
  els.capMaxWordsValue.textContent = String(s.maxWords || 1);
  els.capPunctToggle.checked = s.punctuationCleanup !== false;
  els.capStyleButtons().forEach((b) => b.classList.toggle('active', b.dataset.capStyle === s.style));
  els.capAnimButtons().forEach((b) => b.classList.toggle('active', b.dataset.capAnim === (s.animation || 'none')));
  if (s.fontId) els.capFontSelect.value = s.fontId;
  markActiveSwatch(els.capColorPicker, s.color);
  els.capSizeSlider.value = s.fontSize;
  els.capSizeValue.textContent = `${s.fontSize}px`;
  els.capShadowToggle.checked = !!s.dropShadow;
  els.capYSlider.value = s.yPercent;
  els.capYValue.textContent = `${s.yPercent}%`;
}

// --- caption style presets (localStorage, up to 6) ----------------------------------
const CAPTION_PRESETS_KEY = 'clipEditor.captionPresets.v1';

function loadCaptionPresets() {
  try {
    return JSON.parse(localStorage.getItem(CAPTION_PRESETS_KEY) || '[]');
  } catch {
    return [];
  }
}
function saveCaptionPresets(list) {
  localStorage.setItem(CAPTION_PRESETS_KEY, JSON.stringify(list));
}
// The reusable look — the styling slice of captionSettings (not per-clip timing).
function currentCaptionStyle() {
  const s = state.captionSettings;
  return {
    maxWords: s.maxWords,
    punctuationCleanup: s.punctuationCleanup,
    style: s.style,
    fontId: s.fontId,
    fontSize: s.fontSize,
    color: s.color,
    dropShadow: s.dropShadow,
    yPercent: s.yPercent,
    animation: s.animation,
  };
}
function applyCaptionPreset(style) {
  Object.assign(state.captionSettings, style);
  syncCaptionControls();
  applyCaptionStyle(); // restyle any existing caption layers to the preset
}
function renderCaptionPresetList() {
  els.capPresetList.innerHTML = '';
  const presets = loadCaptionPresets();
  if (presets.length === 0) {
    els.capPresetList.innerHTML = '<p class="field-hint">No caption presets yet.</p>';
    return;
  }
  for (const p of presets) {
    const row = document.createElement('div');
    row.className = 'preset-row';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'preset-apply';
    name.textContent = p.name;
    name.title = 'Apply this caption look';
    name.addEventListener('click', () => applyCaptionPreset(p.style));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preset-del';
    del.innerHTML = icon('x', 12);
    del.title = 'Delete preset';
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Delete caption preset?', itemName: p.name, confirmLabel: 'Delete' });
      if (!ok) return;
      saveCaptionPresets(loadCaptionPresets().filter((x) => x.id !== p.id));
      renderCaptionPresetList();
    });
    row.append(name, del);
    els.capPresetList.appendChild(row);
  }
}
function wireCaptionPresets() {
  const save = () => {
    const name = els.capPresetName.value.trim();
    if (!name) return;
    const presets = loadCaptionPresets();
    const existing = presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.style = currentCaptionStyle();
    } else {
      if (presets.length >= 6) {
        els.capPresetName.placeholder = 'Max 6 — delete one first';
        return;
      }
      presets.push({ id: `cp-${Date.now()}`, name, style: currentCaptionStyle() });
    }
    saveCaptionPresets(presets);
    els.capPresetName.value = '';
    renderCaptionPresetList();
  };
  els.capPresetSaveBtn.addEventListener('click', save);
  els.capPresetName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
  renderCaptionPresetList();
}

function clockLabel(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

// Transcript editor: one editable row per caption block (time order), so
// Whisper mistakes can be fixed in place. Edits write straight to the layer's
// text (preview updates live); clearing a block's text on blur deletes it.
// While a row is focused we skip the rebuild so typing isn't interrupted — the
// DOM already shows what was typed and the layer is already updated.
function renderTranscript() {
  const caps = state.layers.filter((l) => l.group === 'caption');
  els.transcriptGroup.classList.toggle('hidden', caps.length === 0);
  if (document.activeElement && document.activeElement.classList.contains('transcript-input')) return;
  els.transcriptList.innerHTML = '';
  for (const layer of caps.slice().sort((a, b) => a.start - b.start)) {
    const row = document.createElement('div');
    row.className = 'transcript-row';
    const time = document.createElement('button');
    time.type = 'button';
    time.className = 'transcript-time';
    time.textContent = clockLabel(layer.start);
    time.title = 'Jump to this caption';
    time.addEventListener('click', () => seek(layer.start));
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'transcript-input';
    input.value = layer.text;
    input.dataset.capId = layer.id;
    input.addEventListener('input', () => updateLayer(layer.id, { text: input.value }));
    input.addEventListener('change', () => {
      if (!input.value.trim()) removeLayer(layer.id);
    });
    row.append(time, input);
    els.transcriptList.appendChild(row);
  }
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
    // Use contains(): since the icon swap the button holds an <svg>, so a click
    // lands on the SVG child, not the button itself. An identity check on
    // e.target then treated the button's own click as "outside" and closed the
    // panel on the same bubbling event — so it never appeared to open.
    if (
      !els.emojiPanel.classList.contains('hidden') &&
      !els.emojiPanel.contains(e.target) &&
      !els.emojiBtn.contains(e.target)
    ) {
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

  // "Apply to whole video": checked pins the layer to [0, outputDuration] and
  // keeps it there as clips change; unchecked freezes it at the current times
  // and it becomes a normal layer again.
  els.layerFullToggle.addEventListener('change', () => {
    const layer = selectedLayer();
    if (!layer) return;
    if (els.layerFullToggle.checked) {
      updateLayer(layer.id, { fullDuration: true, start: 0, end: outputDuration() });
    } else {
      updateLayer(layer.id, { fullDuration: false });
    }
  });

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
  const full = !!layer.fullDuration;
  els.layerFullToggle.checked = full;
  // Manual timing is meaningless while pinned to the whole video.
  els.layerStart.disabled = full;
  els.layerEnd.disabled = full;
}

// Per-clip header: shown once there are 2+ pieces; the label reflects how many
// pieces the current edit touches (multi-select).
function updatePerClipHeader() {
  const pieceCount = state.segments.length + state.appendedClips.length;
  els.perclipRow.classList.toggle('hidden', pieceCount < 2);
  if (pieceCount < 2) return;
  const targets = editTargetPieces(getCurrentOutputTime());
  els.perclipLabel.textContent = targets.length > 1 ? `Editing ${targets.length} clips` : 'Editing this clip';
}

function refreshVideoPanel() {
  // Skip whichever control the user is actively dragging so this (fired on
  // every 'settings', including from drag-to-pan) never fights their input.
  const a = document.activeElement;
  if (a !== els.zoomSlider) els.zoomSlider.value = Math.round(state.zoom * 100);
  els.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
  if (a !== els.blurSlider) els.blurSlider.value = state.blur;
  els.blurValue.textContent = `${state.blur}%`;
  if (a !== els.panXSlider) els.panXSlider.value = state.panX;
  els.panXValue.textContent = String(state.panX);
  if (a !== els.panYSlider) els.panYSlider.value = state.panY;
  els.panYValue.textContent = String(state.panY);
  if (a !== els.speedSlider) els.speedSlider.value = state.speed;
  els.speedValue.textContent = `${state.speed.toFixed(2)}x`;
  els.mirrorToggle.checked = state.mirror;
  if (a !== els.clipVolumeSlider) els.clipVolumeSlider.value = state.audio.volumePercent;
  els.clipVolumeValue.textContent = `${state.audio.volumePercent}%`;
  els.clipMuteToggle.checked = !!state.audio.muted;
  if (a !== els.clipFadeInSlider) els.clipFadeInSlider.value = state.audio.fadeIn || 0;
  els.clipFadeInValue.textContent = `${(state.audio.fadeIn || 0).toFixed(1)}s`;
  if (a !== els.clipFadeOutSlider) els.clipFadeOutSlider.value = state.audio.fadeOut || 0;
  els.clipFadeOutValue.textContent = `${(state.audio.fadeOut || 0).toFixed(1)}s`;
  const col = state.color || { brightness: 0, contrast: 0, saturation: 0 };
  if (a !== els.colorBrightness) els.colorBrightness.value = col.brightness;
  els.colorBrightnessValue.textContent = String(col.brightness);
  if (a !== els.colorContrast) els.colorContrast.value = col.contrast;
  els.colorContrastValue.textContent = String(col.contrast);
  if (a !== els.colorSaturation) els.colorSaturation.value = col.saturation;
  els.colorSaturationValue.textContent = String(col.saturation);
  updatePerClipHeader();
  updateLayoutUI();
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

  const tabForKind = { layer: 'text', overlay: 'overlay', sound: 'sound', segment: 'video' };

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
    refreshVideoPanel(); // keep the Video-tab sliders in sync with drag-to-pan
    refreshOverlayPanel();
    refreshSoundPanel();
  });
  on('segments', renderTransitionList);

  // Auto-apply the default (★) preset whenever a clip loads, so an imported
  // clip lands in the user's template.
  on('source', () => {
    const p = activePreset();
    if (p) applyPreset(p);
  });
}
