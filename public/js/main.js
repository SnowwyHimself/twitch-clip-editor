// Boot + top-level wiring: loads server option lists into state, wires the
// header (paste-URL ingestion, VOD range, file open, keyboard shortcuts)
// and the timeline toolbar's add-text / auto-captions buttons, then hands
// off to the preview/timeline/panel/export modules.

import {
  state,
  on,
  emit,
  addTextLayer,
  selectedLayer,
  removeLayer,
  selectedSegment,
  removeSegment,
  selectedSound,
  removeSound,
  selectedOverlay,
  removeOverlay,
  sourceDuration,
  setTimelineMode,
  undo,
  redo,
  canUndo,
  canRedo,
} from './state.js';
import { fetchFonts, fetchAspectRatios, fetchWhisperStatus, fetchPreviewSource } from './api.js';
import { initPreview, attachSource, setPlaceholder, getCurrentTime, togglePlay } from './preview.js';
import { initTimeline } from './timeline.js';
import { initPanel, showTab } from './panel.js';
import { initExport } from './export.js';

const urlInput = document.getElementById('clip-url');
const loadUrlBtn = document.getElementById('load-url-btn');
const openFileBtn = document.getElementById('open-file-btn');
const fileInput = document.getElementById('clip-file');
const vodStartInput = document.getElementById('vod-start');
const vodEndInput = document.getElementById('vod-end');
const vodDetails = document.getElementById('vod-range');
const addTextBtn = document.getElementById('tl-add-text');
const autoCaptionsBtn = document.getElementById('tl-auto-captions');
const addOverlayBtn = document.getElementById('tl-add-overlay');
const addSoundBtn = document.getElementById('tl-add-sound');
const transitionsBtn = document.getElementById('tl-transitions');
const undoBtn = document.getElementById('tl-undo');
const redoBtn = document.getElementById('tl-redo');
const snapToggle = document.getElementById('snap-toggle');

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Accepts "90", "1:30", or "1:02:30" — returns seconds or null.
function parseTimeInput(value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':').map((p) => parseFloat(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function currentSection() {
  const start = parseTimeInput(vodStartInput.value);
  const end = parseTimeInput(vodEndInput.value);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

// --- clip ingestion -----------------------------------------------------------

async function loadFromUrl() {
  const url = urlInput.value.trim();
  if (!isValidHttpUrl(url)) {
    setPlaceholder('Please paste a valid clip URL (starting with http:// or https://).');
    return;
  }
  const section = currentSection();
  setPlaceholder('Fetching clip...');
  loadUrlBtn.disabled = true;
  loadUrlBtn.textContent = 'Loading...';
  try {
    const { previewUrl } = await fetchPreviewSource(url, section);
    attachSource(previewUrl, { kind: 'url', url, section }, { isObjectUrl: false });
  } catch (err) {
    setPlaceholder(`Couldn't load clip: ${err.message}`);
  } finally {
    loadUrlBtn.disabled = false;
    loadUrlBtn.textContent = 'Load';
  }
}

function loadFromFile(file) {
  attachSource(URL.createObjectURL(file), { kind: 'file', file }, { isObjectUrl: true });
}

function wireIngestion() {
  loadUrlBtn.addEventListener('click', loadFromUrl);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadFromUrl();
  });
  // The core differentiator: paste a link and it loads immediately — no
  // extra click. Deliberately paste only (not typing/blur), so the one
  // explicit user gesture is what triggers the download.
  urlInput.addEventListener('paste', () => {
    setTimeout(() => {
      if (isValidHttpUrl(urlInput.value.trim()) && !vodDetails.open) loadFromUrl();
    }, 0);
  });
  openFileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) loadFromFile(file);
  });
}

// --- timeline toolbar ------------------------------------------------------------

function wireToolbar() {
  addTextBtn.addEventListener('click', () => {
    const duration = sourceDuration();
    const t = getCurrentTime();
    addTextLayer({
      start: duration > 0 ? Math.min(t, Math.max(0, duration - 0.5)) : 0,
      end: duration > 0 ? Math.min(t + 3, duration) : 3,
    });
  });

  // These toolbar buttons open the matching panel tab (CapCut-style) —
  // the tabs themselves own the actual add/generate flows, including the
  // "your own file vs. bundled preset" choice.
  autoCaptionsBtn.addEventListener('click', () => showTab('captions'));
  addOverlayBtn.addEventListener('click', () => showTab('overlay'));
  addSoundBtn.addEventListener('click', () => showTab('sound'));
  transitionsBtn.addEventListener('click', () => showTab('transitions'));

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  on('history', () => {
    undoBtn.disabled = !canUndo();
    redoBtn.disabled = !canRedo();
  });

  // Snap (CapCut: pieces always close up) vs free-form (Premiere: pieces
  // sit where dropped, gaps play as black).
  snapToggle.addEventListener('change', () => {
    setTimelineMode(snapToggle.checked ? 'snap' : 'free');
  });
}

// --- keyboard shortcuts --------------------------------------------------------------

function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function wireShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Undo/redo work even while typing — standard editor behavior.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (isTypingTarget(e.target)) return;
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // Deletes whatever is selected — a text layer, sound, overlay, or a
      // video segment — mirroring the timeline toolbar's Delete button.
      const layer = selectedLayer();
      const sound = selectedSound();
      const overlay = selectedOverlay();
      const segment = selectedSegment();
      if (layer) {
        e.preventDefault();
        removeLayer(layer.id);
      } else if (sound) {
        e.preventDefault();
        removeSound(sound.id);
      } else if (overlay) {
        e.preventDefault();
        removeOverlay(overlay.id);
      } else if (segment) {
        e.preventDefault();
        removeSegment(segment.id);
      }
    }
  });
}

// --- boot ------------------------------------------------------------------------------

async function boot() {
  try {
    const [fonts, ratios, whisper] = await Promise.all([fetchFonts(), fetchAspectRatios(), fetchWhisperStatus()]);
    state.fonts = fonts;
    state.aspectRatios = ratios;
    state.whisper = whisper;
    const def = ratios.find((r) => r.isDefault) || ratios[0];
    if (def) state.aspect = { id: def.id, width: def.width, height: def.height };
  } catch (err) {
    console.error('Failed to load editor options:', err);
  }

  initPreview();
  initTimeline();
  initPanel();
  initExport();
  wireIngestion();
  wireToolbar();
  wireShortcuts();
  emit('settings');

  // Debug/scripting handle (used by automated tests; harmless in prod —
  // everything still flows through the same emit() paths).
  window.__editor = { state, emit };
}

boot();
