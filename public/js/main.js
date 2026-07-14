// Boot + top-level wiring: loads server option lists into state, wires the
// header (paste-URL ingestion, file open, keyboard shortcuts)
// and the timeline toolbar's add-text / auto-captions buttons, then hands
// off to the preview/timeline/panel/export modules.

import {
  state,
  on,
  emit,
  addTextLayer,
  selectedLayer,
  duplicateLayer,
  removeLayer,
  selectedSegment,
  removeSegment,
  selectedSound,
  removeSound,
  selectedOverlay,
  removeOverlay,
  addAppendedClip,
  selectedAppendedClip,
  removeAppendedClip,
  syncFullDurationLayers,
  sourceDuration,
  outputDuration,
  setTimelineMode,
  undo,
  redo,
  canUndo,
  canRedo,
} from './state.js';
import { fetchFonts, fetchAspectRatios, fetchWhisperStatus, fetchPreviewSource } from './api.js';
import {
  initPreview,
  attachSource,
  setPlaceholder,
  getCurrentTime,
  getCurrentOutputTime,
  seekOutput,
  togglePlay,
} from './preview.js';
import { initTimeline } from './timeline.js';
import { initPanel, setAddClipHandler } from './panel.js';
import { initExport } from './export.js';
import { icon, hydrateIcons } from './icons.js';
import {
  saveProject,
  saveProjectAs,
  openProject,
  listProjects,
  deleteProject,
  restoreAutosave,
  startAutosave,
  onProjectChange,
  finishOpenWithFile,
} from './project.js';
import { confirmDialog, addClipDialog } from './confirm.js';

const urlInput = document.getElementById('clip-url');
const loadUrlBtn = document.getElementById('load-url-btn');
const openFileBtn = document.getElementById('open-file-btn');
const fileInput = document.getElementById('clip-file');
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

// --- clip ingestion -----------------------------------------------------------

async function loadFromUrl() {
  const url = urlInput.value.trim();
  if (!isValidHttpUrl(url)) {
    setPlaceholder('Please paste a valid clip URL (starting with http:// or https://).');
    return;
  }
  hideRestoreBanner(); // a load is underway — never leave the banner up
  setPlaceholder('Fetching clip...');
  loadUrlBtn.disabled = true;
  loadUrlBtn.textContent = 'Loading...';
  try {
    const { previewUrl } = await fetchPreviewSource(url);
    attachSource(previewUrl, { kind: 'url', url }, { isObjectUrl: false });
  } catch (err) {
    setPlaceholder(`Couldn't load clip: ${err.message}`);
  } finally {
    loadUrlBtn.disabled = false;
    loadUrlBtn.textContent = 'Load';
  }
}

function loadFromFile(file) {
  hideRestoreBanner();
  attachSource(URL.createObjectURL(file), { kind: 'file', file }, { isObjectUrl: true });
}

// --- append clips (sequential multi-source) ------------------------------------------

const appendClipFileInput = document.getElementById('append-clip-file');

// Reads a media file's dimensions + duration off a throwaway <video>.
function probeMedia(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const done = () => resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration || 0 });
    v.addEventListener('loadedmetadata', done, { once: true });
    v.addEventListener('error', () => reject(new Error('Could not read that video.')), { once: true });
    v.src = url;
  });
}

async function appendClipFromUrl(url) {
  try {
    const { previewUrl } = await fetchPreviewSource(url);
    const dims = await probeMedia(previewUrl);
    addAppendedClip({ kind: 'url', url, previewUrl, ...dims });
  } catch (err) {
    setPlaceholder(`Couldn't add clip: ${err.message}`);
  }
}

async function appendClipFromFile(file) {
  const previewUrl = URL.createObjectURL(file);
  try {
    const dims = await probeMedia(previewUrl);
    addAppendedClip({ kind: 'file', file, name: file.name, previewUrl, ...dims });
  } catch (err) {
    setPlaceholder(`Couldn't add clip: ${err.message}`);
  }
}

// "+ Clip": opens a chooser offering a pasted URL or a file, both appended
// after the current footage. Pre-fills the URL box if the top bar has one.
async function addClip() {
  if (!state.source) {
    setPlaceholder('Load a clip first, then stitch more after it.');
    return;
  }
  const prefill = isValidHttpUrl(urlInput.value.trim()) ? urlInput.value.trim() : '';
  const choice = await addClipDialog({ prefillUrl: prefill });
  if (!choice) return;
  if (choice.mode === 'url') {
    await appendClipFromUrl(choice.url);
    if (urlInput.value.trim() === choice.url) urlInput.value = '';
  } else {
    appendClipFileInput.click();
  }
}

function wireIngestion() {
  loadUrlBtn.addEventListener('click', loadFromUrl);
  appendClipFileInput.addEventListener('change', () => {
    const file = appendClipFileInput.files[0];
    if (file) appendClipFromFile(file);
    appendClipFileInput.value = '';
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadFromUrl();
  });
  // The core differentiator: paste a link and it loads immediately — no
  // extra click. Deliberately paste only (not typing/blur), so the one
  // explicit user gesture is what triggers the download.
  urlInput.addEventListener('paste', () => {
    setTimeout(() => {
      if (isValidHttpUrl(urlInput.value.trim())) loadFromUrl();
    }, 0);
  });
  // Right-click the field to paste-and-go: read the clipboard, drop it in, and
  // if it's a URL start loading immediately (Electron grants clipboard read; a
  // browser may prompt, in which case we just fall through to the native menu).
  urlInput.addEventListener('contextmenu', (e) => {
    if (!navigator.clipboard || !navigator.clipboard.readText) return; // native menu
    e.preventDefault();
    navigator.clipboard
      .readText()
      .then((text) => {
        const t = (text || '').trim();
        if (!t) return;
        urlInput.value = t;
        if (isValidHttpUrl(t)) loadFromUrl();
      })
      .catch(() => {
        /* permission denied — leave the field as-is */
      });
  });
  // Drag a link straight onto the field.
  urlInput.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  urlInput.addEventListener('drop', (e) => {
    e.preventDefault();
    const dropped = (
      e.dataTransfer.getData('text/uri-list') ||
      e.dataTransfer.getData('text/plain') ||
      ''
    )
      .split('\n')[0]
      .trim();
    if (!dropped) return;
    urlInput.value = dropped;
    if (isValidHttpUrl(dropped)) loadFromUrl();
  });
  openFileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) loadFromFile(file);
  });
}

// --- timeline toolbar ------------------------------------------------------------

function wireToolbar() {
  // Insertion now lives entirely in the panel's + Add menu (add → auto-select →
  // its inspector opens). "Add clip" needs this module's URL/file ingestion, so
  // register it as the menu's clip handler.
  setAddClipHandler(addClip);

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
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      // ⌘D / Ctrl+D duplicates the selected text/caption layer.
      const layer = selectedLayer();
      if (layer) {
        e.preventDefault();
        duplicateLayer(layer.id);
      }
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      seekOutput(getCurrentOutputTime() + (e.shiftKey ? 1 : 0.1));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seekOutput(getCurrentOutputTime() - (e.shiftKey ? 1 : 0.1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      seekOutput(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      seekOutput(outputDuration());
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // Deletes whatever is selected — a text layer, sound, overlay, or a
      // video segment — mirroring the timeline toolbar's Delete button.
      const layer = selectedLayer();
      const sound = selectedSound();
      const overlay = selectedOverlay();
      const segment = selectedSegment();
      const appendedClip = selectedAppendedClip();
      if (layer) {
        e.preventDefault();
        removeLayer(layer.id);
      } else if (sound) {
        e.preventDefault();
        removeSound(sound.id);
      } else if (overlay) {
        e.preventDefault();
        removeOverlay(overlay.id);
      } else if (appendedClip) {
        e.preventDefault();
        removeAppendedClip(appendedClip.id);
      } else if (segment) {
        e.preventDefault();
        removeSegment(segment.id);
      }
    }
  });
}

// --- projects (save / open / autosave / restore) ---------------------------------------

const projectNameEl = document.getElementById('project-name');
const projectSaveBtn = document.getElementById('project-save-btn');
const projectSaveAsBtn = document.getElementById('project-saveas-btn');
const projectOpenBtn = document.getElementById('project-open-btn');
const projectFileInput = document.getElementById('project-file-input');
const projectsModal = document.getElementById('projects-modal');
const projectsList = document.getElementById('projects-list');
const projectsEmpty = document.getElementById('projects-empty');
const projectsCloseBtn = document.getElementById('projects-close-btn');
const restoreBanner = document.getElementById('restore-banner');
const restoreYesBtn = document.getElementById('restore-yes-btn');
const restoreNoBtn = document.getElementById('restore-no-btn');
const startRecent = document.getElementById('start-recent');
const startRecentList = document.getElementById('start-recent-list');

// When a project can't auto-resolve its (moved/renamed) source file, we hold it
// here and let the user re-pick the video, then finish loading.
let pendingFileOpen = null;

function flashSaved() {
  const original = projectSaveBtn.textContent;
  projectSaveBtn.textContent = 'Saved ✓';
  setTimeout(() => {
    projectSaveBtn.textContent = original;
  }, 1200);
}

async function doSave() {
  if (!state.source) {
    setPlaceholder('Load a clip before saving a project.');
    return;
  }
  try {
    await saveProject();
    flashSaved();
  } catch (err) {
    console.error('Save failed', err);
  }
}

async function doSaveAs() {
  if (!state.source) return;
  const name = window.prompt('Save project as:', '');
  if (name === null) return;
  try {
    await saveProjectAs(name.trim() || 'Untitled');
    flashSaved();
  } catch (err) {
    console.error('Save As failed', err);
  }
}

function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function handleOpen(id) {
  projectsModal.classList.add('hidden');
  hideRestoreBanner(); // opening a project is an active session — dismiss now
  const result = await openProject(id);
  if (result.ok) return;
  if (result.reason === 'need-file') {
    pendingFileOpen = { id, data: result.data };
    setPlaceholder('This project’s video file has moved — pick it to finish opening.');
    projectFileInput.click();
  } else {
    setPlaceholder("Couldn't open that project.");
  }
}

async function renderProjectList(container, { compact = false } = {}) {
  const { projects } = await listProjects();
  container.innerHTML = '';
  if (!projects.length) return false;
  for (const p of projects.slice(0, compact ? 6 : 50)) {
    const row = document.createElement('div');
    row.className = 'project-row';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'project-open-row';
    open.innerHTML = `<span class="project-row-name">${escapeHtml(p.name)}</span><span class="project-row-when">${fmtWhen(p.savedAt)}</span>`;
    open.addEventListener('click', () => handleOpen(p.id));
    row.appendChild(open);
    if (!compact) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'project-del';
      del.innerHTML = icon('x', 12);
      del.title = 'Delete project';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog({
          title: 'Delete project?',
          itemName: p.name,
          confirmLabel: 'Delete',
        });
        if (!ok) return;
        await deleteProject(p.id);
        renderProjectList(container, { compact });
      });
      row.appendChild(del);
    }
    container.appendChild(row);
  }
  return true;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function refreshStartRecent() {
  if (state.source) {
    startRecent.classList.add('hidden');
    return;
  }
  const has = await renderProjectList(startRecentList, { compact: true });
  startRecent.classList.toggle('hidden', !has);
}

function wireProjects() {
  projectSaveBtn.addEventListener('click', doSave);
  projectSaveAsBtn.addEventListener('click', doSaveAs);
  projectOpenBtn.addEventListener('click', async () => {
    const has = await renderProjectList(projectsList, { compact: false });
    projectsEmpty.classList.toggle('hidden', has);
    projectsModal.classList.remove('hidden');
  });
  projectsCloseBtn.addEventListener('click', () => projectsModal.classList.add('hidden'));
  projectsModal.addEventListener('click', (e) => {
    if (e.target === projectsModal) projectsModal.classList.add('hidden');
  });

  projectFileInput.addEventListener('change', async () => {
    const file = projectFileInput.files && projectFileInput.files[0];
    projectFileInput.value = '';
    if (!file || !pendingFileOpen) return;
    const { id, data } = pendingFileOpen;
    pendingFileOpen = null;
    await finishOpenWithFile(id, data, file);
  });

  onProjectChange(({ name }) => {
    projectNameEl.textContent = name || 'Untitled';
  });

  // ⌘S / Ctrl+S saves.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      doSave();
    }
  });

  on('source', () => startRecent.classList.add('hidden'));

  startAutosave();
}

function hideRestoreBanner() {
  restoreBanner.classList.add('hidden');
}

async function offerRestore() {
  const { autosave } = await listProjects();
  if (!autosave) return;
  // Launch-only prompt: if a clip is somehow already loaded, never show it.
  if (state.source) return;
  restoreBanner.classList.remove('hidden');
  restoreYesBtn.onclick = async () => {
    hideRestoreBanner();
    const result = await restoreAutosave();
    if (!result.ok && result.reason === 'need-file') {
      pendingFileOpen = { id: 'autosave', data: result.data };
      setPlaceholder('Pick the video file to restore your last project.');
      projectFileInput.click();
    }
  };
  restoreNoBtn.onclick = hideRestoreBanner;
  // Auto-dismiss the moment the user starts working. 'source' covers a loaded/
  // imported clip; 'segments'/'layers' cover opening a project (which may not
  // emit 'source' until a moved file is re-picked). The load/open entry points
  // also call hideRestoreBanner() directly, so it never waits on metadata. The
  // banner must never sit on top of an active session.
  for (const ev of ['source', 'segments', 'layers']) on(ev, hideRestoreBanner);
}

// --- boot ------------------------------------------------------------------------------

// Custom sliders: drive the accent fill (a --fill % the CSS track gradient
// reads) from each range input's value — on user input, on the events that
// re-set slider values programmatically (deferred a frame so values are set),
// and per-frame for the seek scrubber during playback.
function updateSliderFill(el) {
  const min = parseFloat(el.min) || 0;
  const max = Number.isFinite(parseFloat(el.max)) ? parseFloat(el.max) : 100;
  const v = parseFloat(el.value) || 0;
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
}
function updateAllSliderFills() {
  document.querySelectorAll('input[type="range"]').forEach(updateSliderFill);
}
function wireSliderFills() {
  document.addEventListener(
    'input',
    (e) => {
      if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'range') updateSliderFill(e.target);
    },
    true
  );
  const refresh = () => requestAnimationFrame(updateAllSliderFills);
  on('settings', refresh);
  on('layers', refresh);
  on('segments', refresh);
  const seek = document.getElementById('preview-seek');
  on('time', () => seek && updateSliderFill(seek));
  updateAllSliderFills();
  requestAnimationFrame(updateAllSliderFills);
}

async function boot() {
  hydrateIcons(); // fill the static [data-icon] markup with SVGs
  wireSliderFills();
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
  wireProjects();
  // Keep "apply to whole video" text layers pinned to the project length as
  // clips are added, trimmed, or deleted.
  on('segments', syncFullDurationLayers);
  emit('settings');

  refreshStartRecent();
  offerRestore();
  wireUpdatePill();

  // Debug/scripting handle (used by automated tests; harmless in prod —
  // everything still flows through the same emit() paths).
  window.__editor = { state, emit };
}

// Quiet update pill: the main process signals when an update is downloaded +
// verified; the pill is the ONLY UI. Desktop-only — in a plain browser there's
// no electronAPI, so nothing shows. (Exposed on window for a dev smoke-test.)
function wireUpdatePill() {
  const pill = document.getElementById('update-pill');
  const versionEl = document.getElementById('update-pill-version');
  const dismissBtn = document.getElementById('update-pill-dismiss');
  if (!pill) return;
  const show = (version) => {
    if (version) versionEl.textContent = `v${version}`;
    pill.classList.remove('hidden');
  };
  window.__showUpdatePill = show; // dev smoke-test hook
  pill.addEventListener('click', () => window.electronAPI && window.electronAPI.relaunchToUpdate());
  pill.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && window.electronAPI) window.electronAPI.relaunchToUpdate();
  });
  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't trigger the relaunch click on the pill
    pill.classList.add('hidden');
    if (window.electronAPI) window.electronAPI.dismissUpdate();
  });
  if (window.electronAPI && typeof window.electronAPI.onUpdateReady === 'function') {
    window.electronAPI.onUpdateReady((version) => show(version));
  }
}

boot();
