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
  MIN_LAYER_SECONDS,
  removeTransition,
  updateTransition,
  selectedTransition,
  clearSelection,
  copyStyle,
  pasteStyle,
  canPasteStyle,
  styleKindForSelection,
  duplicateLayer,
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
  addFaceEffect,
  selectedFaceEffect,
  updateFaceEffect,
  removeFaceEffect,
} from './state.js';
import {
  getCurrentTime,
  getCurrentOutputTime,
  seek,
  beginFaceSelect,
  cancelFaceSelect,
  isFaceSelecting,
} from './preview.js';
import { trackSelectedFace, trackFaceBoxes } from './facetrack.js';
import { showToast } from './toast.js';
import { confirmDialog } from './confirm.js';
import { icon } from './icons.js';
import { transcribe, fetchSfxPresets, fetchOverlayPresets, presetAsFile, libraryItemAsFile, libraryFileUrl, fetchLibraryUsage } from './api.js';
import { loadLibrary, renderLibrarySection, saveToLibrary, onLibraryChange, libraryItems } from './library.js';
import { showContextMenu } from './menu.js';

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
    inspectors: {
      project: byId('insp-project'),
      clip: byId('insp-clip'),
      text: byId('insp-text'),
      caption: byId('insp-caption'),
      overlay: byId('insp-overlay'),
      sound: byId('insp-sound'),
      transition: byId('insp-transition'),
      multi: byId('insp-multi'),
    },
    inspectorTitle: byId('inspector-title'),
    inspectorSub: byId('inspector-sub'),
    inspectorOverflow: byId('inspector-overflow'),
    addMenuBtn: byId('add-menu-btn'),
    addMenu: byId('add-menu'),
    // Relocatable blocks the router moves between inspectors (single DOM node,
    // no duplicate ids): video presets → Project/Clip; text controls → Text/Caption.
    videoPresetBlock: byId('video-preset-block'),
    bgBlurBlock: byId('bg-blur-block'),
    captionThisBlock: byId('caption-thisblock'),
    capBlockText: byId('cap-block-text'),
    capBlockStart: byId('cap-block-start'),
    capBlockEnd: byId('cap-block-end'),
    capBlockDelete: byId('cap-block-delete'),
    capBlockEmojiBtn: byId('cap-block-emoji-btn'),
    capBlockEmojiPanel: byId('cap-block-emoji-panel'),
    transDurationSlider: byId('trans-duration-slider'),
    transDurationValue: byId('trans-duration-value'),
    transStatus: byId('trans-status'),
    transRemoveBtn: byId('trans-remove-btn'),
    aspectGroup: byId('aspect-ratio-group'),
    panelVideo: byId('insp-clip'),
    layoutButtons: () => document.querySelectorAll('#layout-group [data-layout]'),
    splitControls: byId('split-controls'),
    facecamZoom: byId('facecam-zoom'),
    facecamZoomValue: byId('facecam-zoom-value'),
    gameplayZoom: byId('gameplay-zoom'),
    gameplayZoomValue: byId('gameplay-zoom-value'),
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
    overlaySaveLib: byId('overlay-save-lib'),
    overlayLibrary: byId('overlay-library'),
    libraryUsage: byId('library-usage'),
    libraryPath: byId('library-path'),
    libraryOpenFolder: byId('library-open-folder'),
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
    soundSaveLib: byId('sound-save-lib'),
    soundLibType: byId('sound-lib-type'),
    soundLibrary: byId('sound-library'),
    musicLibrary: byId('music-library'),
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
    // Text tab
    textInput: byId('caption-text'),
    emojiBtn: byId('emoji-picker-btn'),
    emojiPanel: byId('emoji-panel'),
    styleButtons: () => document.querySelectorAll('[data-caption-style]'),
    fontSelect: byId('font-select'),
    fontImportBtn: byId('font-import-btn'),
    capFontImportBtn: byId('cap-font-import-btn'),
    fontImportFile: byId('font-import-file'),
    colorPicker: byId('color-picker'),
    fontSizeSlider: byId('font-size-slider'),
    fontSizeValue: byId('font-size-value'),
    dropShadowToggle: byId('drop-shadow-toggle'),
    textStylePresets: byId('text-style-presets'),
    strokeWidthSlider: byId('stroke-width-slider'),
    strokeWidthValue: byId('stroke-width-value'),
    strokeColorPicker: byId('stroke-color-picker'),
    uppercaseToggle: byId('uppercase-toggle'),
    textOpacitySlider: byId('text-opacity-slider'),
    textOpacityValue: byId('text-opacity-value'),
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
    capExitButtons: () => document.querySelectorAll('[data-cap-exit]'),
    capExitDuration: byId('cap-exit-duration'),
    capExitDurationValue: byId('cap-exit-duration-value'),
    capFontSelect: byId('cap-font-select'),
    capColorPicker: byId('cap-color-picker'),
    capSizeSlider: byId('cap-size-slider'),
    capSizeValue: byId('cap-size-value'),
    capShadowToggle: byId('cap-shadow-toggle'),
    capKaraokeToggle: byId('cap-karaoke-toggle'),
    capKaraokeColor: byId('cap-karaoke-color'),
    capYSlider: byId('cap-y-slider'),
    capYValue: byId('cap-y-value'),
    capTimingSlider: byId('cap-timing-slider'),
    capTimingInput: byId('cap-timing-input'),
    transcriptGroup: byId('transcript-group'),
    transcriptList: byId('transcript-list'),
    capPresetList: byId('cap-preset-list'),
    capPresetName: byId('cap-preset-name'),
    capPresetSaveBtn: byId('cap-preset-save-btn'),
    captionsVisibleToggle: byId('captions-visible-toggle'),
    captionsRemoveAllBtn: byId('captions-remove-all-btn'),
  };
}

// --- tab switching -------------------------------------------------------------

// The panel shows exactly one inspector, chosen by what's selected on the
// timeline/preview. Insertion lives in the + Add menu; there are no tabs.
function showInspector(which) {
  for (const [name, el] of Object.entries(els.inspectors)) {
    el.classList.toggle('hidden', name !== which);
  }
}

// Move the relocatable presets block into the active inspector's [data-preset-slot]
// (Project or Clip) — one DOM node, no duplicate ids.
function mountPresetSlot(inspectorName) {
  const insp = els.inspectors[inspectorName];
  const slot = insp && insp.querySelector('[data-preset-slot]');
  if (slot && els.videoPresetBlock.parentElement !== slot) slot.appendChild(els.videoPresetBlock);
}

// Background blur is a single global setting shown in BOTH Project and Clip: move
// the one #blur-slider block into whichever is active, and keep it in sync (the
// Project branch doesn't run refreshVideoPanel).
function mountBgBlurSlot(inspectorName) {
  const insp = els.inspectors[inspectorName];
  const slot = insp && insp.querySelector('[data-bgblur-slot]');
  if (slot && els.bgBlurBlock.parentElement !== slot) slot.appendChild(els.bgBlurBlock);
  els.blurSlider.value = state.blur;
  els.blurValue.textContent = `${state.blur}%`;
}

// Fill the Caption inspector's "This caption" mini-editor (text + timing) from
// the selected caption block. Styling is group-level (the "All captions" section
// below), so this stays intentionally minimal — no per-block style controls.
function refreshCaptionBlock(layer) {
  if (!layer) return;
  if (document.activeElement !== els.capBlockText) els.capBlockText.value = layer.text;
  if (document.activeElement !== els.capBlockStart) els.capBlockStart.value = layer.start.toFixed(2);
  if (document.activeElement !== els.capBlockEnd) els.capBlockEnd.value = layer.end.toFixed(2);
}

function setInspectorHeader(title, sub = '') {
  els.inspectorTitle.textContent = title;
  els.inspectorSub.textContent = sub;
}

// A short name for the selected piece, shown in the Clip header.
function pieceLabel(sel) {
  if (!sel) return '';
  if (sel.kind === 'clip') {
    const c = state.appendedClips.find((x) => x.id === sel.id);
    return c ? c.name || c.label || 'added clip' : '';
  }
  const src = state.source || {};
  return (src.file && src.file.name) || src.name || 'main clip';
}

// "N of M" position of a caption block among all caption blocks, by time.
function captionPositionLabel(layer) {
  const caps = state.layers.filter((l) => l.group === 'caption').sort((a, b) => a.start - b.start);
  const idx = caps.findIndex((l) => l.id === layer.id);
  return idx >= 0 ? `${idx + 1} of ${caps.length}` : '';
}

// The single source of truth for what the panel shows: derive the inspector +
// header from the current selection, mount relocatable blocks, refresh controls.
function routeSelection() {
  const sel = state.sel;
  const kind = sel && sel.kind;

  // Overflow (⋯) menu is available whenever the selection has a copyable style.
  els.inspectorOverflow.classList.toggle('hidden', !styleKindForSelection());

  if (state.selPieces.length > 1) {
    mountPresetSlot('clip');
    mountBgBlurSlot('clip');
    setInspectorHeader('Clips', `${state.selPieces.length} selected`);
    showInspector('clip');
    refreshVideoPanel();
    return;
  }

  if (kind === 'segment' || kind === 'clip') {
    mountPresetSlot('clip');
    mountBgBlurSlot('clip');
    setInspectorHeader('Clip', pieceLabel(sel));
    showInspector('clip');
    refreshVideoPanel();
  } else if (kind === 'layer') {
    const layer = selectedLayer();
    if (layer && layer.group === 'caption') {
      els.captionThisBlock.classList.remove('hidden');
      setInspectorHeader('Caption', captionPositionLabel(layer));
      showInspector('caption');
      refreshCaptionBlock(layer);
      syncCaptionControls();
      renderTranscript();
    } else {
      setInspectorHeader('Text');
      showInspector('text');
      refreshTextPanel();
    }
  } else if (kind === 'overlay') {
    setInspectorHeader('Overlay');
    showInspector('overlay');
    refreshOverlayPanel();
  } else if (kind === 'sound') {
    setInspectorHeader('Sound');
    showInspector('sound');
    refreshSoundPanel();
  } else if (kind === 'transition') {
    setInspectorHeader('Transition');
    showInspector('transition');
    refreshTransitionInspector();
  } else {
    mountPresetSlot('project');
    mountBgBlurSlot('project');
    setInspectorHeader('Project');
    showInspector('project');
  }
}

// Force an inspector open with nothing selected — the + Add menu uses this to
// reveal source controls (overlay/sound) before an item exists. The next
// selection change re-routes normally.
function forceInspector(which, title) {
  setInspectorHeader(title || which);
  // Forced Caption view (auto-captions from the + menu) has no block selected yet.
  if (which === 'caption') els.captionThisBlock.classList.add('hidden');
  showInspector(which);
}

// --- shared builders --------------------------------------------------------------

function buildFontOptions(select) {
  const prev = select.value; // preserve the selection across rebuilds (library changes)
  select.innerHTML = '';
  const builtin = document.createElement('optgroup');
  builtin.label = 'Built-in';
  for (const font of state.fonts) {
    const option = document.createElement('option');
    option.value = font.id;
    option.textContent = font.available ? font.label : `${font.label} (not installed)`;
    option.disabled = !font.available;
    builtin.appendChild(option);
  }
  select.appendChild(builtin);
  // "My fonts": imported library fonts, each option rendered in its own typeface.
  const fonts = libraryItems('fonts');
  if (fonts.length) {
    const group = document.createElement('optgroup');
    group.label = 'My fonts';
    for (const it of fonts) {
      const option = document.createElement('option');
      option.value = `lib:${it.id}`;
      option.textContent = it.name;
      option.style.fontFamily = `libfont-${it.id}`;
      group.appendChild(option);
    }
    select.appendChild(group);
  }
  if (prev) select.value = prev;
}

// Font import: adds a .ttf/.otf to the library, then applies it to whatever the
// user is editing (the text layer or the caption group) by selecting its new
// `lib:<id>` option and firing the existing change handler. The library refresh
// (saveToLibrary) has already registered the @font-face + rebuilt both selects.
let fontImportTarget = 'text';
function wireFontImport() {
  if (els.fontImportBtn) {
    els.fontImportBtn.addEventListener('click', () => {
      fontImportTarget = 'text';
      els.fontImportFile.click();
    });
  }
  if (els.capFontImportBtn) {
    els.capFontImportBtn.addEventListener('click', () => {
      fontImportTarget = 'caption';
      els.fontImportFile.click();
    });
  }
  if (els.fontImportFile) {
    els.fontImportFile.addEventListener('change', async () => {
      const file = els.fontImportFile.files[0];
      els.fontImportFile.value = '';
      if (!file) return;
      try {
        const { item } = await saveToLibrary('fonts', file);
        const select = fontImportTarget === 'caption' ? els.capFontSelect : els.fontSelect;
        select.value = `lib:${item.id}`;
        select.dispatchEvent(new Event('change'));
      } catch (err) {
        // Server rejects woff2 / non-font with a friendly message.
        alert(err && err.message ? err.message : 'Could not import that font.');
      }
    });
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

// D1 one-click text style presets — designed combos of style/colour/stroke/
// case/shadow. Applied to the selected layer.
const TEXT_STYLE_PRESETS = [
  { name: 'Bold outline', style: 'outline', color: '#ffffff', strokeWidth: 18, strokeColor: '#000000', uppercase: true, dropShadow: false },
  { name: 'Clean white', style: 'plain', color: '#ffffff', strokeWidth: 0, strokeColor: '#000000', uppercase: false, dropShadow: true },
  { name: 'Pill caption', style: 'box', color: '#ffffff', strokeWidth: 0, strokeColor: '#000000', uppercase: false, dropShadow: false },
  { name: 'Yellow pop', style: 'outline', color: '#ffd23f', strokeWidth: 16, strokeColor: '#000000', uppercase: true, dropShadow: false },
  { name: 'Accent edge', style: 'outline', color: '#ffffff', strokeWidth: 14, strokeColor: '#7c5cff', uppercase: false, dropShadow: false },
  { name: 'Red hit', style: 'outline', color: '#ff5c5c', strokeWidth: 16, strokeColor: '#000000', uppercase: true, dropShadow: false },
  { name: 'Soft shadow', style: 'plain', color: '#ffffff', strokeWidth: 0, strokeColor: '#000000', uppercase: false, dropShadow: true },
  { name: 'Lower third', style: 'plain', color: '#ffffff', strokeWidth: 0, strokeColor: '#000000', uppercase: false, dropShadow: false },
];

// D1 remainder slider mappings: prop = layer field, get(raw)=slider→value,
// put(layer)=value→slider position, label(raw)=display. Shared by wire+refresh.
const TEXT_SLIDER_SPECS = [
  { id: 'text-rotation-slider', valId: 'text-rotation-value', prop: 'rotation', get: (v) => v, put: (l) => Math.round(l.rotation || 0), label: (v) => `${Math.round(v)}°` },
  { id: 'text-letterspacing-slider', valId: 'text-letterspacing-value', prop: 'letterSpacing', get: (v) => v / 100, put: (l) => Math.round((l.letterSpacing || 0) * 100), label: (v) => String(Math.round(v)) },
  { id: 'text-lineheight-slider', valId: 'text-lineheight-value', prop: 'lineHeight', get: (v) => v / 100, put: (l) => Math.round((l.lineHeight || 1) * 100), label: (v) => (v / 100).toFixed(1) },
  { id: 'text-shadow-dist-slider', valId: 'text-shadow-dist-value', prop: 'shadowDistance', get: (v) => v / 100, put: (l) => Math.round((l.shadowDistance != null ? l.shadowDistance : 0.07) * 100), label: (v) => `${Math.round(v)}%` },
  { id: 'text-shadow-blur-slider', valId: 'text-shadow-blur-value', prop: 'shadowBlur', get: (v) => v / 100, put: (l) => Math.round((l.shadowBlur != null ? l.shadowBlur : 0.05) * 100), label: (v) => `${Math.round(v)}%` },
  { id: 'text-shadow-op-slider', valId: 'text-shadow-op-value', prop: 'shadowOpacity', get: (v) => v / 100, put: (l) => Math.round((l.shadowOpacity != null ? l.shadowOpacity : 0.4) * 100), label: (v) => `${Math.round(v)}%` },
  { id: 'text-bg-op-slider', valId: 'text-bg-op-value', prop: 'bgOpacity', get: (v) => v / 100, put: (l) => Math.round((l.bgOpacity != null ? l.bgOpacity : 1) * 100), label: (v) => `${Math.round(v)}%` },
  { id: 'text-bg-pad-slider', valId: 'text-bg-pad-value', prop: 'bgPadding', get: (v) => v / 100, put: (l) => Math.round((l.bgPadding != null ? l.bgPadding : 1) * 100), label: (v) => `${(v / 100).toFixed(1)}x` },
  { id: 'text-bg-radius-slider', valId: 'text-bg-radius-value', prop: 'bgRadius', get: (v) => v / 100, put: (l) => Math.round((l.bgRadius != null ? l.bgRadius : 1) * 100), label: (v) => `${(v / 100).toFixed(1)}x` },
];

function buildTextStylePresets() {
  els.textStylePresets.innerHTML = '';
  for (const p of TEXT_STYLE_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-style-preset';
    btn.title = p.name;
    const sample = document.createElement('span');
    sample.className = 'tsp-sample';
    sample.textContent = 'Aa';
    if (p.style === 'box') {
      sample.style.background = p.color;
      sample.style.color = '#111';
      sample.style.padding = '0 4px';
      sample.style.borderRadius = '4px';
    } else {
      sample.style.color = p.color;
      if (p.strokeWidth > 0) sample.style.webkitTextStroke = `1px ${p.strokeColor}`;
    }
    if (p.uppercase) sample.style.textTransform = 'uppercase';
    btn.appendChild(sample);
    btn.addEventListener('click', () => {
      const layer = selectedLayer();
      if (!layer) return;
      updateLayer(layer.id, {
        style: p.style,
        color: p.color,
        strokeWidth: p.strokeWidth,
        strokeColor: p.strokeColor,
        uppercase: p.uppercase,
        dropShadow: p.dropShadow,
      });
      refreshTextPanel();
    });
    els.textStylePresets.appendChild(btn);
  }
}

// --- video panel ------------------------------------------------------------------

function buildAspectButtons() {
  els.aspectGroup.innerHTML = '';
  for (const ratio of state.aspectRatios) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle-btn';
    btn.textContent = ratio.id === 'original' ? 'Original' : ratio.id;
    btn.title = ratio.label;
    btn.classList.toggle('active', ratio.id === state.aspect.id);
    btn.addEventListener('click', () => {
      if (ratio.id === 'original') {
        // Original takes the current source's native dimensions.
        const w = (state.source && state.source.width) || state.aspect.width;
        const h = (state.source && state.source.height) || state.aspect.height;
        state.aspect = { id: 'original', width: w, height: h };
      } else {
        state.aspect = { id: ratio.id, width: ratio.width, height: ratio.height };
      }
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
  // every piece via commitVideoSettings — zoom/position/blur/colour apply to the
  // whole video at once (splits + stitched clips stay in sync).
  const commitVideo = () => commitVideoSettings();
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
  els.colorResetBtn.addEventListener('click', () => {
    state.color = { brightness: 0, contrast: 0, saturation: 0 };
    commitVideo();
    refreshVideoPanel();
  });
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

// Tracked face effect (blur / cover): reuse the SAME face-selection UX as the
// crop-follow, then scan for the full box path and create a face-effect layer.
let facePerfWarned = false;
async function runFaceEffect(kind) {
  if (isFaceSelecting()) {
    cancelFaceSelect();
    return;
  }
  if (!state.source) {
    setFaceStatus('Load a clip first.', true);
    return;
  }
  if (!facePerfWarned) {
    facePerfWarned = true;
    showToast({ message: 'Tracked face effects add some time to each export.' });
  }
  const priorFaceTrack = { enabled: state.faceTrack.enabled, samples: state.faceTrack.samples.slice() };
  clearFaceTrack(); // plain view so the tap maps cleanly to the footage
  setFaceStatus(`Click the face to ${kind === 'blur' ? 'blur' : 'cover'} in the preview (Esc to cancel).`);
  const target = await beginFaceSelect();
  restoreFaceTrack(priorFaceTrack);
  syncFaceTrackToggle();
  if (!target) {
    setFaceStatus('Cancelled.');
    return;
  }
  setFaceStatus('Scanning the clip and locking onto that face…');
  try {
    const result = await trackFaceBoxes(target, {
      onProgress: (p) => setFaceStatus(`Tracking that face… ${Math.round(p * 100)}%`),
    });
    if (!result.ok) {
      setFaceStatus(
        result.reason === 'no-face'
          ? 'Couldn’t find a face there — try a clearer, more face-forward clip.'
          : 'Couldn’t track that face — try again.',
        true
      );
      return;
    }
    addFaceEffect({ kind, samples: result.samples, ...(kind === 'cover' ? { emoji: '😀' } : {}) });
    setFaceStatus(
      kind === 'blur'
        ? 'Face blurred and tracking. Adjust strength/padding on the right.'
        : 'Pinned to that face. Pick an emoji or image and adjust on the right.'
    );
  } catch (err) {
    setFaceStatus(`Face tracking hit an error: ${(err && err.message) || 'unknown'}. Please try again.`, true);
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

// --- presets (up to 5, saved in localStorage) ---------------------------------------
// A preset captures the video settings (aspect/zoom/blur/pan/speed/mirror).
// The one flagged default (★) is auto-applied whenever a clip loads, so an
// imported clip lands in the user's template. Nothing here is per-clip.

const PRESETS_KEY = 'clipEditor.presets.v1';
const DEFAULT_PRESET_KEY = 'clipEditor.defaultPreset.v1';
const PAN_LOCK_KEY = 'clipEditor.lockPosition.v1';

// Defaults to UNLOCKED (missing key === unlocked) so a preset applies the whole
// framing it captured — including position — and "load a clip, pick a preset"
// actually reframes the clip. Users who prefer to frame each clip by hand can
// turn the lock on.
function positionLocked() {
  return localStorage.getItem(PAN_LOCK_KEY) === '1';
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
    // Layout (Fill vs Facecam split) + the split regions, so a preset restores
    // the whole look — including a facecam-split template.
    layout: state.layout,
    split: state.split ? JSON.parse(JSON.stringify(state.split)) : undefined,
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
  // Layout + split regions (facecam presets). Restored before the panel refresh
  // so updateLayoutUI shows the right layout, and the 'settings' emit below
  // re-lays out the split preview.
  if (s.layout === 'fill' || s.layout === 'split') state.layout = s.layout;
  if (s.split && typeof s.split === 'object') state.split = JSON.parse(JSON.stringify(s.split));
  buildAspectButtons();
  refreshVideoPanel();
  // Commit the preset's reframe/blur onto the edit-target piece(s) (B6). speed
  // and mirror stay global; commitVideoSettings still emits 'settings' for them.
  commitVideoSettings(getCurrentOutputTime());
}

// Adds a preset's saved text layers to the current clip — each starts at t=0
// and keeps its saved duration, so a preset can act as a real template (a
// styled headline already placed). Re-applying the same preset (clicking it
// again) must NOT stack duplicate copies, so a template layer already present
// (same text + position) is skipped.
function addPresetTextLayers(textLayers) {
  if (!Array.isArray(textLayers)) return;
  const samePlace = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.5;
  for (const t of textLayers) {
    const { duration, ...fields } = t;
    const dup = state.layers.some(
      (l) =>
        l.group !== 'caption' &&
        (l.text || '').trim() === (fields.text || '').trim() &&
        samePlace(l.xPercent, fields.xPercent) &&
        samePlace(l.yPercent, fields.yPercent)
    );
    if (dup) continue;
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
      if (presets.length >= 5) {
        els.presetName.placeholder = 'Max 5 — delete one first';
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
  // addOverlay selects it → routeSelection opens the Overlay inspector.
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

// A thumbnail element for a library overlay (image preview, or a film glyph for
// video overlays). Mirrors the built-in preset thumbnails.
function overlayLibraryThumb(item) {
  const isVideo = /\.(webm|mp4|mov)$/i.test(item.filename || '');
  if (isVideo) {
    const span = document.createElement('span');
    span.className = 'preset-thumb';
    span.innerHTML = icon('film');
    return span;
  }
  const img = document.createElement('img');
  img.className = 'preset-thumb';
  img.src = item.url || libraryFileUrl(item.id);
  img.alt = '';
  return img;
}

// Render the "My library" overlays section into the Overlay inspector.
function buildOverlayLibrary() {
  renderLibrarySection(els.overlayLibrary, 'overlays', {
    emptyText: 'Overlays you import can be saved here for reuse.',
    renderThumb: overlayLibraryThumb,
    onPick: async (item) => addOverlayFromFile(await libraryItemAsFile(item)),
  });
}

// Import a user-picked overlay; also save it to the library when the toggle is on.
async function importOverlay(file) {
  if (!file) return;
  addOverlayFromFile(file);
  if (els.overlaySaveLib && els.overlaySaveLib.checked) {
    try {
      await saveToLibrary('overlays', file); // refreshes the library section
    } catch (err) {
      console.error('Save overlay to library failed:', err);
    }
  }
}

function wireOverlayControls() {
  els.overlayChooseBtn.addEventListener('click', () => els.overlayFile.click());
  els.overlayFile.addEventListener('change', () => {
    importOverlay(els.overlayFile.files[0] || null);
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
  // addSound selects it → routeSelection opens the Sound inspector.
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

// Which library bucket a new audio import saves to (Sound effect vs Music) —
// set by the toggle in the Sound inspector. Playback is identical either way.
let soundLibCategory = 'sounds';

// A thumbnail for a library audio item — a small play glyph, matching the SFX
// preset look. Clicking the item (not the thumb) auditions + adds it.
function audioLibraryThumb() {
  const span = document.createElement('span');
  span.className = 'preset-thumb';
  span.innerHTML = icon('music');
  return span;
}

function buildAudioLibrary() {
  const onPick = (item) => {
    new Audio(item.url || libraryFileUrl(item.id)).play().catch(() => {}); // audible feedback
    libraryItemAsFile(item).then((file) => addSoundFromFile(file, item.name, item.url || libraryFileUrl(item.id)));
  };
  renderLibrarySection(els.soundLibrary, 'sounds', {
    emptyText: 'Sound effects you import can be saved here for reuse.',
    renderThumb: audioLibraryThumb,
    onPick,
  });
  renderLibrarySection(els.musicLibrary, 'music', {
    emptyText: 'Music you import can be saved here for reuse.',
    renderThumb: audioLibraryThumb,
    onPick,
  });
}

// Settings display: per-category library disk usage + folder path + Open folder.
const LIB_CAT_LABEL = { sounds: 'Sound effects', music: 'Music', overlays: 'Overlays', fonts: 'Fonts' };
function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
async function renderLibraryUsage() {
  if (!els.libraryUsage) return;
  try {
    const usage = await fetchLibraryUsage();
    els.libraryUsage.innerHTML = Object.entries(LIB_CAT_LABEL)
      .map(([cat, label]) => {
        const c = usage.categories[cat] || { count: 0, bytes: 0 };
        return `<div class="library-usage-row"><span>${label}</span><span>${c.count} · ${formatBytes(c.bytes)}</span></div>`;
      })
      .join('') + `<div class="library-usage-row library-usage-total"><span>Total</span><span>${formatBytes(usage.total)}</span></div>`;
    if (els.libraryPath) els.libraryPath.textContent = usage.path;
    // Open folder only works in the desktop app (Electron IPC).
    if (els.libraryOpenFolder && window.electronAPI && window.electronAPI.openLibraryFolder) {
      els.libraryOpenFolder.classList.remove('hidden');
    }
  } catch {
    /* leave the section empty on failure */
  }
}

async function importSound(file) {
  if (!file) return;
  addSoundFromFile(file);
  if (els.soundSaveLib && els.soundSaveLib.checked) {
    try {
      await saveToLibrary(soundLibCategory, file); // refreshes the sound/music sections
    } catch (err) {
      console.error('Save audio to library failed:', err);
    }
  }
}

function wireSoundControls() {
  els.soundChooseBtn.addEventListener('click', () => els.audioFile.click());
  els.audioFile.addEventListener('change', () => {
    importSound(els.audioFile.files[0] || null);
    els.audioFile.value = '';
  });
  // Sound effect / Music choice for what a new import saves as.
  if (els.soundLibType) {
    els.soundLibType.querySelectorAll('[data-lib-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundLibCategory = btn.dataset.libCat;
        els.soundLibType.querySelectorAll('[data-lib-cat]').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
  }
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

// Transitions render as ✦ badges on the timeline (click a badge to select and
// edit it here; click a cut's empty slot to add one). This keeps the panel
// honest if the selected transition disappears (its cut was removed).
function renderTransitionList() {
  if (state.sel && state.sel.kind === 'transition' && !selectedTransition()) clearSelection();
}

// Fill the Transition inspector from the selected transition.
function refreshTransitionInspector() {
  const tr = selectedTransition();
  if (!tr) return;
  els.transDurationSlider.value = tr.duration;
  els.transDurationValue.textContent = `${tr.duration.toFixed(1)}s`;
  document
    .querySelectorAll('[data-trans-type]')
    .forEach((b) => b.classList.toggle('active', b.dataset.transType === (tr.type || 'white-flash')));
}

function wireTransitionControls() {
  document.querySelectorAll('[data-trans-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tr = selectedTransition();
      if (!tr) return;
      updateTransition(tr.id, { type: btn.dataset.transType });
      document.querySelectorAll('[data-trans-type]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
  els.transDurationSlider.addEventListener('input', () => {
    els.transDurationValue.textContent = `${parseFloat(els.transDurationSlider.value).toFixed(1)}s`;
    const tr = selectedTransition();
    if (tr) updateTransition(tr.id, { duration: parseFloat(els.transDurationSlider.value) });
  });
  els.transRemoveBtn.addEventListener('click', () => {
    const tr = selectedTransition();
    if (tr) removeTransition(tr.id);
  });
}

// --- captions tab -------------------------------------------------------------------

// Duration guardrails (seconds) for a caption block. A block never flashes
// shorter than MIN. Rather than a hard MAX we extend each block to hold until
// the next one starts (so captions are continuous — no flicker gaps between
// normally-spaced words), but cap how far a block lingers past its own last
// word so it clears during a long pause instead of hanging on screen.
const CAP_MIN_BLOCK = 0.4;
const CAP_LINGER_BASE = 0.8; // s a block may hold past its last word...
const CAP_LINGER_PER_WORD = 1.2; // ...plus this much per word (long lines read slower)

// Strips trailing commas/periods (keeps ? and !), used for punctuation cleanup.
function cleanCaptionWord(text) {
  return text.replace(/[.,]+(?=\s|$)/g, '').trim();
}

// Groups word-level whisper segments into N-word caption blocks, optionally
// cleaning punctuation, then decides display timing so captions run continuously
// without lingering through silences. Each block keeps its own word timings
// (rs/re, relative to start) so karaoke + the timing-nudge stay re-derivable.
function groupCaptionWords(words, maxWords, cleanup) {
  const n = Math.max(1, Math.min(5, maxWords || 1));
  const raw = [];
  for (let i = 0; i < words.length; i += n) {
    const chunk = words.slice(i, i + n);
    const start = chunk[0].start;
    const spokenEnd = chunk[chunk.length - 1].end;
    // Keep each word's text + timing RELATIVE to the block start (rs/re) for
    // karaoke emphasis (D2). Relative times ride the timing-nudge automatically
    // (word window = layer.start + rs .. layer.start + re).
    const wordItems = chunk
      .map((w) => ({ text: cleanup ? cleanCaptionWord(w.text) : w.text, rs: w.start - start, re: w.end - start }))
      .filter((w) => w.text);
    const text = wordItems.map((w) => w.text).join(' ');
    if (text) raw.push({ start, spokenEnd, text, words: wordItems });
  }
  // Second pass: hold each block until the next begins, capped so it clears a
  // long pause. whisper stretches a word's `end` across trailing silence, so we
  // key the linger cap off word COUNT (how long the text takes to read), not the
  // reported spoken end — that's what made captions hang after a pause before.
  const blocks = [];
  for (let i = 0; i < raw.length; i += 1) {
    const b = raw[i];
    const next = raw[i + 1];
    const linger = CAP_LINGER_BASE + CAP_LINGER_PER_WORD * b.words.length;
    let end = b.start + linger;
    end = Math.max(end, b.start + CAP_MIN_BLOCK); // prefer at least a readable beat…
    // …but NEVER run into the next caption — clamping to next.start last
    // guarantees only one caption is on screen at a time (no overlap). Fast
    // speech just means a shorter beat, never two stacked captions.
    if (next) end = Math.min(end, Math.max(b.start, next.start));
    blocks.push({ start: b.start, end, text: b.text, words: b.words });
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
    const result = await transcribe(state.source, 'words');
    const words = result.segments || [];
    if (words.length === 0) {
      els.capStatus.textContent = 'No speech was detected in this clip.';
      return;
    }
    // Transparent downgrade: the chosen tier's model isn't available yet, so the
    // best downloaded one ran instead. Surface it (S2 makes this a live download).
    const tierName = { fast: 'Fast', better: 'Better', best: 'Best' };
    const captionDowngradeNote =
      result.downgraded && result.requestedTier !== result.tier
        ? ` (used ${tierName[result.tier] || result.tier} — ${tierName[result.requestedTier] || result.requestedTier} isn’t downloaded yet)`
        : '';
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
          strokeWidth: s.strokeWidth,
          strokeColor: s.strokeColor,
          uppercase: s.uppercase,
          animation: s.animation || 'none',
          xPercent: 50,
          yPercent: s.yPercent,
          start,
          end: start + (seg.end - seg.start),
          // Untouched whisper times, so the timing-nudge slider can always
          // re-derive from the original (see applyCaptionTiming).
          baseStart: seg.start,
          baseEnd: seg.end,
          words: seg.words, // per-word rel timings for karaoke
          group: 'caption',
        },
        { select: false }
      );
    }
    els.capStatus.textContent = `${segments.length} caption ${segments.length === 1 ? 'block' : 'blocks'} added${captionDowngradeNote} — restyle them below, or regenerate after changing the settings.`;
    // Land on the first block so you're immediately editing it (and the Caption
    // inspector, with its "This block" section, is what shows).
    const firstCap = captionLayersByTime()[0];
    if (firstCap) selectLayer(firstCap.id);
  } catch (err) {
    els.capStatus.textContent = `Transcription failed: ${err.message}`;
  } finally {
    els.capGenerateBtn.disabled = false;
    els.capGenerateBtn.textContent = 'Regenerate captions';
  }
}

// Caption blocks ordered by time — shared by the header label + post-generate select.
function captionLayersByTime() {
  return state.layers.filter((l) => l.group === 'caption').sort((a, b) => a.start - b.start);
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

  els.capExitButtons().forEach((btn) => {
    btn.addEventListener('click', () => {
      state.captionSettings.exit = btn.dataset.capExit;
      els.capExitButtons().forEach((b) => b.classList.toggle('active', b === btn));
      applyCaptionStyle();
    });
  });
  if (els.capExitDuration) {
    els.capExitDuration.addEventListener('input', () => {
      const v = parseFloat(els.capExitDuration.value);
      state.captionSettings.exitDuration = v;
      if (els.capExitDurationValue) els.capExitDurationValue.textContent = `${v.toFixed(2)}s`;
      applyCaptionStyle();
    });
  }

  els.capKaraokeToggle.addEventListener('change', () => {
    state.captionSettings.karaoke = els.capKaraokeToggle.checked;
    applyCaptionStyle();
  });
  buildColorPicker(els.capKaraokeColor, (hex) => {
    state.captionSettings.karaokeColor = hex;
    markActiveSwatch(els.capKaraokeColor, hex);
    applyCaptionStyle();
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
  // Permanently delete every caption layer (hand-made text is untouched). Unlike
  // the Show-captions toggle this can't be undone by flipping it back, so confirm.
  els.captionsRemoveAllBtn.addEventListener('click', async () => {
    const count = state.layers.filter((l) => l.group === 'caption').length;
    if (count === 0) return;
    const ok = await confirmDialog({
      title: 'Remove all captions?',
      note: `Deletes all ${count} caption ${count === 1 ? 'block' : 'blocks'}. Your own text layers are kept. You can regenerate captions afterwards.`,
      confirmLabel: 'Remove all',
    });
    if (!ok) return;
    removeCaptionLayers();
    els.capStatus.textContent = 'All captions removed. Generate again any time.';
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
  els.capExitButtons().forEach((b) => b.classList.toggle('active', b.dataset.capExit === (s.exit || 'none')));
  if (els.capExitDuration) {
    const ed = Number.isFinite(s.exitDuration) ? s.exitDuration : 0.35;
    els.capExitDuration.value = ed;
    if (els.capExitDurationValue) els.capExitDurationValue.textContent = `${ed.toFixed(2)}s`;
  }
  if (s.fontId) els.capFontSelect.value = s.fontId;
  markActiveSwatch(els.capColorPicker, s.color);
  els.capSizeSlider.value = s.fontSize;
  els.capSizeValue.textContent = `${s.fontSize}px`;
  els.capShadowToggle.checked = !!s.dropShadow;
  els.capKaraokeToggle.checked = !!s.karaoke;
  markActiveSwatch(els.capKaraokeColor, s.karaokeColor || '#ffe600');
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
    strokeWidth: s.strokeWidth,
    strokeColor: s.strokeColor,
    uppercase: s.uppercase,
    fontId: s.fontId,
    fontSize: s.fontSize,
    color: s.color,
    dropShadow: s.dropShadow,
    yPercent: s.yPercent,
    animation: s.animation,
  };
}

// Built-in caption looks shipped with the app (not deletable). The gallery
// shows these plus any the user saved, all as visual cards.
const BUILTIN_CAPTION_STYLES = [
  { id: 'b-hype', name: 'Hype', style: { style: 'outline', color: '#ffffff', strokeWidth: 18, strokeColor: '#000000', uppercase: true, dropShadow: false, animation: 'bounce' } },
  { id: 'b-clean', name: 'Clean', style: { style: 'plain', color: '#ffffff', strokeWidth: 0, strokeColor: '#000000', uppercase: false, dropShadow: true, animation: 'fade' } },
  { id: 'b-pill', name: 'Pill', style: { style: 'box', color: '#ffffff', strokeWidth: 0, strokeColor: '#000000', uppercase: false, dropShadow: false, animation: 'slide' } },
  { id: 'b-gold', name: 'Gold', style: { style: 'outline', color: '#ffd23f', strokeWidth: 16, strokeColor: '#000000', uppercase: true, dropShadow: false, animation: 'shake' } },
];

// A small styled sample of a caption look for a gallery card.
function captionStyleSample(st) {
  const sample = document.createElement('span');
  sample.className = 'cap-card-sample';
  sample.textContent = 'Aa';
  if (st.style === 'box') {
    sample.style.background = st.color || '#fff';
    sample.style.color = '#111';
    sample.style.padding = '0 5px';
    sample.style.borderRadius = '4px';
  } else {
    sample.style.color = st.color || '#fff';
    const sw = st.strokeWidth != null ? st.strokeWidth : st.style === 'outline' ? 15 : 0;
    if (sw > 0) sample.style.webkitTextStroke = `1px ${st.strokeColor || '#000'}`;
  }
  if (st.uppercase) sample.style.textTransform = 'uppercase';
  return sample;
}
function applyCaptionPreset(style) {
  Object.assign(state.captionSettings, style);
  syncCaptionControls();
  applyCaptionStyle(); // restyle any existing caption layers to the preset
}
function makeCaptionCard(p, { deletable }) {
  const card = document.createElement('div');
  card.className = 'cap-card';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'cap-card-apply';
  apply.title = `Apply "${p.name}"`;
  apply.appendChild(captionStyleSample(p.style));
  const label = document.createElement('span');
  label.className = 'cap-card-name';
  label.textContent = p.name;
  apply.appendChild(label);
  apply.addEventListener('click', () => applyCaptionPreset(p.style));
  card.appendChild(apply);
  if (deletable) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'cap-card-del';
    del.innerHTML = icon('x', 12);
    del.title = 'Delete preset';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog({ title: 'Delete caption preset?', itemName: p.name, confirmLabel: 'Delete' });
      if (!ok) return;
      saveCaptionPresets(loadCaptionPresets().filter((x) => x.id !== p.id));
      renderCaptionPresetList();
    });
    card.appendChild(del);
  }
  return card;
}

// Gallery of caption looks: built-in defaults first, then the user's saved
// presets — all as styled visual cards.
function renderCaptionPresetList() {
  els.capPresetList.innerHTML = '';
  for (const p of BUILTIN_CAPTION_STYLES) {
    els.capPresetList.appendChild(makeCaptionCard(p, { deletable: false }));
  }
  for (const p of loadCaptionPresets()) {
    els.capPresetList.appendChild(makeCaptionCard(p, { deletable: true }));
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
  els.captionsRemoveAllBtn.classList.toggle('hidden', caps.length === 0);
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

function buildEmojiPanelInto(panel, input) {
  panel.innerHTML = '';
  for (const emoji of CURATED_EMOJIS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-item';
    btn.textContent = emoji;
    btn.addEventListener('click', () => insertEmojiInto(input, emoji));
    panel.appendChild(btn);
  }
}

function buildEmojiPanel() {
  buildEmojiPanelInto(els.emojiPanel, els.textInput);
}

function insertEmojiInto(input, emoji) {
  const layer = selectedLayer();
  if (!layer) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const value = input.value;
  input.value = value.slice(0, start) + emoji + value.slice(end);
  const cursor = start + emoji.length;
  input.focus();
  input.setSelectionRange(cursor, cursor);
  updateLayer(layer.id, { text: input.value });
}

// "This caption" mini-editor: edits the selected caption block's text + timing +
// delete. Styling is group-level (the "All captions" section), so there are no
// per-block style controls here — that was the confusion the migration created.
function wireCaptionBlockControls() {
  els.capBlockText.addEventListener('input', () => {
    const l = selectedLayer();
    if (l && l.group === 'caption') updateLayer(l.id, { text: els.capBlockText.value });
  });
  const commitCapTime = () => {
    const l = selectedLayer();
    if (!l || l.group !== 'caption') return;
    const duration = sourceDuration() || Infinity;
    let start = parseFloat(els.capBlockStart.value);
    let end = parseFloat(els.capBlockEnd.value);
    if (!Number.isFinite(start)) start = l.start;
    if (!Number.isFinite(end)) end = l.end;
    start = Math.max(0, Math.min(start, duration));
    end = Math.max(start + 0.2, Math.min(end, duration));
    updateLayer(l.id, { start, end });
  };
  els.capBlockStart.addEventListener('change', commitCapTime);
  els.capBlockEnd.addEventListener('change', commitCapTime);
  els.capBlockDelete.addEventListener('click', () => {
    const l = selectedLayer();
    if (l) removeLayer(l.id);
  });
  buildEmojiPanelInto(els.capBlockEmojiPanel, els.capBlockText);
  els.capBlockEmojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    els.capBlockEmojiPanel.classList.toggle('hidden');
  });
}

// Create a new text layer at the playhead (used by the + Add menu). addTextLayer
// selects it → routeSelection opens the Text inspector: add → immediately editing.
export function addTextAtPlayhead() {
  const duration = sourceDuration();
  const t = getCurrentTime();
  addTextLayer({
    start: duration > 0 ? Math.min(t, Math.max(0, duration - 0.5)) : 0,
    end: duration > 0 ? Math.min(t + 3, duration) : 3,
  });
}

function wireTextControls() {
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

  // D1 text options: stroke, uppercase, opacity, and one-click style presets.
  els.strokeWidthSlider.addEventListener('input', () => {
    els.strokeWidthValue.textContent = `${els.strokeWidthSlider.value}%`;
    const layer = selectedLayer();
    if (layer) updateLayer(layer.id, { strokeWidth: parseFloat(els.strokeWidthSlider.value) });
  });
  buildColorPicker(els.strokeColorPicker, (hex) => {
    const layer = selectedLayer();
    if (layer) updateLayer(layer.id, { strokeColor: hex });
  });
  els.uppercaseToggle.addEventListener('change', () => {
    const layer = selectedLayer();
    if (layer) updateLayer(layer.id, { uppercase: els.uppercaseToggle.checked });
  });
  els.textOpacitySlider.addEventListener('input', () => {
    els.textOpacityValue.textContent = `${els.textOpacitySlider.value}%`;
    const layer = selectedLayer();
    if (layer) updateLayer(layer.id, { opacity: parseFloat(els.textOpacitySlider.value) / 100 });
  });
  // D1 remainder sliders — spec-driven so wiring + refresh share the mapping.
  for (const spec of TEXT_SLIDER_SPECS) {
    const slider = document.getElementById(spec.id);
    slider.addEventListener('input', () => {
      const raw = parseFloat(slider.value);
      document.getElementById(spec.valId).textContent = spec.label(raw);
      const layer = selectedLayer();
      if (layer) updateLayer(layer.id, { [spec.prop]: spec.get(raw) });
    });
  }
  buildTextStylePresets();

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
  // keeps it there as clips change; unchecked restores the timing it had before
  // pinning (stashed on pin) so it goes back to a normal, non-spanning layer.
  els.layerFullToggle.addEventListener('change', () => {
    const layer = selectedLayer();
    if (!layer) return;
    if (els.layerFullToggle.checked) {
      updateLayer(layer.id, {
        fullDuration: true,
        preFullStart: layer.start,
        preFullEnd: layer.end,
        start: 0,
        end: outputDuration(),
      });
    } else {
      // Prefer the pre-pin span; fall back to the caption's raw whisper timing
      // (+ nudge), then to a short default — so unpinning never leaves the layer
      // stretched across the whole timeline.
      const dur = outputDuration();
      let start = layer.preFullStart;
      let end = layer.preFullEnd;
      // Self-heal a caption whose stashed span still covers (nearly) the whole
      // video — that means it was pinned from an already-pinned state (e.g. old
      // saved data from before this fix), so the stash is garbage. Whisper time
      // is the caption's true home, so drop back to it.
      const stashSpansAll =
        Number.isFinite(start) && Number.isFinite(end) && start <= 0.05 && end >= dur - 0.05;
      if (layer.group === 'caption' && stashSpansAll) {
        start = undefined;
        end = undefined;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        if (layer.group === 'caption' && Number.isFinite(layer.baseStart) && Number.isFinite(layer.baseEnd)) {
          const off = state.captionSettings.timingOffset || 0;
          start = Math.max(0, layer.baseStart + off);
          end = start + (layer.baseEnd - layer.baseStart);
        } else {
          start = Math.min(layer.start, Math.max(0, dur - 3));
          end = Math.min(dur, start + 3);
        }
      }
      start = Math.max(0, Math.min(start, dur));
      end = Math.max(start + MIN_LAYER_SECONDS, Math.min(end, dur));
      updateLayer(layer.id, { fullDuration: false, start, end, preFullStart: undefined, preFullEnd: undefined });
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
  // D1 controls. strokeWidth null follows the style (outline 15% / else 0).
  const strokePct = layer.strokeWidth != null ? layer.strokeWidth : layer.style === 'outline' ? 15 : 0;
  if (document.activeElement !== els.strokeWidthSlider) els.strokeWidthSlider.value = strokePct;
  els.strokeWidthValue.textContent = `${Math.round(strokePct)}%`;
  markActiveSwatch(els.strokeColorPicker, layer.strokeColor || '#000000');
  els.uppercaseToggle.checked = !!layer.uppercase;
  const op = Math.round((layer.opacity != null ? layer.opacity : 1) * 100);
  if (document.activeElement !== els.textOpacitySlider) els.textOpacitySlider.value = op;
  els.textOpacityValue.textContent = `${op}%`;
  for (const spec of TEXT_SLIDER_SPECS) {
    const slider = document.getElementById(spec.id);
    const pos = spec.put(layer);
    if (document.activeElement !== slider) slider.value = pos;
    document.getElementById(spec.valId).textContent = spec.label(pos);
  }
  // Background-pill controls only matter for the box style.
  document.getElementById('text-bg-group').classList.toggle('hidden', layer.style !== 'box');
  if (document.activeElement !== els.layerStart) els.layerStart.value = layer.start.toFixed(2);
  if (document.activeElement !== els.layerEnd) els.layerEnd.value = layer.end.toFixed(2);
  const full = !!layer.fullDuration;
  els.layerFullToggle.checked = full;
  // Manual timing is meaningless while pinned to the whole video.
  els.layerStart.disabled = full;
  els.layerEnd.disabled = full;
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
  wireCaptionBlockControls();
  wireOverlayControls();
  wireSoundControls();
  wireTransitionControls();
  buildOverlayPresets();
  buildSfxPresets();
  // Personal asset library: load once, render the "My library" sections, and
  // re-render them whenever an item is saved/renamed/deleted.
  loadLibrary().then(() => {
    buildOverlayLibrary();
    buildAudioLibrary();
    buildFontOptions(els.fontSelect);
    buildFontOptions(els.capFontSelect);
    renderLibraryUsage();
  });
  onLibraryChange(() => {
    buildOverlayLibrary();
    buildAudioLibrary();
    buildFontOptions(els.fontSelect);
    buildFontOptions(els.capFontSelect);
    renderLibraryUsage();
  });
  wireFontImport();
  if (els.libraryOpenFolder) {
    els.libraryOpenFolder.addEventListener('click', () => window.electronAPI?.openLibraryFolder?.());
  }
  refreshVideoPanel();
  refreshTextPanel();
  refreshOverlayPanel();
  refreshSoundPanel();
  renderTransitionList();

  wireAddMenu();
  wireDisclosure();
  els.inspectorOverflow.addEventListener('click', () => {
    const r = els.inspectorOverflow.getBoundingClientRect();
    openStyleMenu(r.right, r.bottom + 4);
  });

  // The panel is a pure function of the selection: re-route whenever it changes.
  on('selection', routeSelection);
  on('layers', () => {
    refreshTextPanel();
    // Keep the Caption "This caption" fields + "N of M" header current as blocks
    // change (e.g. edited via the transcript).
    const layer = selectedLayer();
    if (layer && layer.group === 'caption') {
      setInspectorHeader('Caption', captionPositionLabel(layer));
      refreshCaptionBlock(layer);
    }
  });
  // Live text from inline preview editing (Feature 5) — mirror into the
  // inspector's text field without a full refresh (so nothing fights the caret).
  on('text-live', (d) => {
    const layer = selectedLayer();
    if (!layer || (d && d.id && d.id !== layer.id)) return;
    const field = layer.group === 'caption' ? els.capBlockText : els.textInput;
    if (field && document.activeElement !== field) field.value = layer.text;
  });
  on('settings', () => {
    refreshVideoPanel(); // keep the sliders in sync with drag-to-pan
    refreshOverlayPanel();
    refreshSoundPanel();
  });
  on('segments', () => {
    renderTransitionList();
    if (state.sel && state.sel.kind === 'transition') refreshTransitionInspector();
  });

  // Auto-apply the default (★) preset whenever a clip loads, so an imported
  // clip lands in the user's template.
  on('source', () => {
    const p = activePreset();
    if (p) applyPreset(p);
  });

  routeSelection(); // start on the Project inspector
}

// --- copy/paste-style + duplicate menu (Feature 6) --------------------------------
// Built from the current selection; shared by the timeline right-click and the
// inspector overflow (⋯) button. Style = visual props only (not content/timing).
export function openStyleMenu(x, y) {
  const kind = styleKindForSelection();
  if (!kind) return; // nothing stylable selected
  const noun = kind === 'clip' ? 'clip' : kind === 'caption' ? 'caption' : 'text';
  const items = [
    { label: `Copy ${noun} style`, onClick: () => copyStyle() },
    { label: `Paste ${noun} style`, disabled: !canPasteStyle(), onClick: () => pasteStyle() },
  ];
  if (kind === 'text' || kind === 'caption') {
    const l = selectedLayer();
    items.push({ separator: true });
    items.push({ label: 'Duplicate', onClick: () => l && duplicateLayer(l.id) });
  }
  showContextMenu(x, y, items);
}

// --- + Add menu -------------------------------------------------------------------

let addClipHandler = () => {};
// main.js owns clip ingestion (the URL/file dialog); it registers the handler.
export function setAddClipHandler(fn) {
  addClipHandler = fn;
}

function wireAddMenu() {
  const closeMenu = () => {
    els.addMenu.classList.add('hidden');
    els.addMenuBtn.setAttribute('aria-expanded', 'false');
  };
  const openMenu = () => {
    els.addMenu.classList.remove('hidden');
    els.addMenuBtn.setAttribute('aria-expanded', 'true');
  };
  els.addMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    els.addMenu.classList.contains('hidden') ? openMenu() : closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!els.addMenu.contains(e.target) && e.target !== els.addMenuBtn) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  els.addMenu.querySelectorAll('[data-add]').forEach((item) => {
    item.addEventListener('click', () => {
      closeMenu();
      runAddAction(item.dataset.add);
    });
  });
}

// Each add action creates (or reveals the source for) a thing at the playhead
// and lands you editing it — the "add → immediately editing" flow.
export function runAddAction(kind) {
  switch (kind) {
    case 'clip':
      addClipHandler();
      break;
    case 'text':
      addTextAtPlayhead();
      break;
    case 'captions':
      forceInspector('caption', 'Captions'); // show status/controls during transcription
      generateCaptions(); // selects the first block when done → full Caption inspector
      break;
    case 'edit-captions':
      // Direct route to group editing without hunting for a block. If captions
      // exist, land on the first so "This caption" is populated too; otherwise
      // open group mode (This-caption hidden).
      {
        const first = captionLayersByTime()[0];
        if (first) selectLayer(first.id);
        else forceInspector('caption', 'Captions');
      }
      break;
    case 'overlay':
      forceInspector('overlay', 'Overlay'); // reveal source (file + presets) to pick
      break;
    case 'sound':
      forceInspector('sound', 'Sound'); // reveal SFX presets + your-own-file
      break;
    case 'music':
      forceInspector('sound', 'Music');
      els.audioFile.click(); // music = bring your own audio
      break;
    case 'blur-face':
      runFaceEffect('blur');
      break;
    case 'cover-face':
      runFaceEffect('cover');
      break;
  }
}

// --- progressive disclosure -------------------------------------------------------
// <details data-adv> blocks remember open/closed per session so re-selecting an
// item restores how you left its Advanced sections.
const DISCLOSURE_KEY = 'clipEditor.disclosure.v1';

function loadDisclosure() {
  try {
    return JSON.parse(sessionStorage.getItem(DISCLOSURE_KEY) || '{}');
  } catch {
    return {};
  }
}

function wireDisclosure() {
  const openState = loadDisclosure();
  document.querySelectorAll('details.insp-adv[data-adv]').forEach((d) => {
    const key = d.dataset.adv;
    if (openState[key]) d.open = true;
    d.addEventListener('toggle', () => {
      const s = loadDisclosure();
      s[key] = d.open;
      sessionStorage.setItem(DISCLOSURE_KEY, JSON.stringify(s));
    });
  });
}
