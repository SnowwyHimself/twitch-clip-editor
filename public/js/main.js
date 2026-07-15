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
  clearSelection,
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
  shuttleForward,
  shuttleBackward,
  shuttleStop,
} from './preview.js';
import { initTimeline, splitAtPlayhead, trimToPlayhead } from './timeline.js';
import { initPanel, setAddClipHandler, runAddAction } from './panel.js';
import { registerAction, actionForEvent, isEnabled, GROUPS } from './actions.js';
import { initCommandUI, openPalette, openShortcuts, paletteOpen, shortcutsOpen } from './palette.js';
import { initWhatsNew } from './whatsnew.js';
import { initPhone, openPhoneModal } from './phone.js';
import { initExport } from './export.js';
import { initBrandKit } from './brandkit.js';
import { initCaptionSettings } from './captionsettings.js';
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
import { confirmDialog, addClipDialog, promptDialog } from './confirm.js';
import { initOnboarding, onSourceLoaded } from './onboarding.js';
import { initExportQueue } from './exportqueue.js';
import { showToast } from './toast.js';
import {
  saveCurrentAsTemplate,
  fetchTemplates,
  renameTemplate,
  deleteTemplate,
  applyTemplateData,
  onTemplateClipLoaded,
} from './templates.js';

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

// Resolve a picked File's real disk path (desktop app only) so a file-based
// project can re-open itself later without re-prompting. Empty in a plain
// browser — there restore falls back to re-picking the file, as before.
function filePath(file) {
  return (window.electronAPI && window.electronAPI.getFilePath && window.electronAPI.getFilePath(file)) || null;
}

// Loads the bundled first-run sample through the SAME file pipeline as a
// user-picked file — so preview and export behave identically to any other clip
// (the sample's bytes upload on export like any file source).
async function loadSampleClip() {
  const res = await fetch('/assets/sample/onboarding-sample.mp4');
  if (!res.ok) throw new Error('sample fetch failed');
  const blob = await res.blob();
  loadFromFile(new File([blob], 'sample-clip.mp4', { type: 'video/mp4' }));
}

function loadFromFile(file) {
  hideRestoreBanner();
  attachSource(
    URL.createObjectURL(file),
    { kind: 'file', file, path: filePath(file), size: file.size },
    { isObjectUrl: true }
  );
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

// Deletes whatever is selected — text layer, sound, overlay, appended clip, or
// a video piece — mirroring the timeline toolbar's Delete button.
function deleteSelection() {
  const layer = selectedLayer();
  const sound = selectedSound();
  const overlay = selectedOverlay();
  const segment = selectedSegment();
  const appendedClip = selectedAppendedClip();
  if (layer) removeLayer(layer.id);
  else if (sound) removeSound(sound.id);
  else if (overlay) removeOverlay(overlay.id);
  else if (appendedClip) removeAppendedClip(appendedClip.id);
  else if (segment) removeSegment(segment.id);
}

// ⌘E — open the Export dialog (no-op with no clip; the button is disabled then).
function openExport() {
  const btn = document.getElementById('export-btn');
  if (btn && !btn.disabled) btn.click();
}

const hasSource = () => !!state.source;
const clickIfPresent = (id) => {
  const el = document.getElementById(id);
  if (el && !el.disabled) el.click();
};

// Every user-facing action lives here ONCE. Keyboard shortcuts, the command
// palette, and the shortcuts overlay all run these same entries — the run()
// bodies call the existing functions/controls, so there's no duplicated logic.
function registerAllActions() {
  const A = registerAction;
  // Playback
  A({ id: 'play-pause', group: GROUPS.PLAYBACK, label: 'Play / pause', shortcut: { key: ' ', display: 'Space' }, enabled: hasSource, run: togglePlay });
  A({ id: 'shuttle-forward', group: GROUPS.PLAYBACK, label: 'Shuttle forward (again = 2×)', shortcut: { key: 'l', display: 'L' }, enabled: hasSource, run: shuttleForward });
  A({ id: 'shuttle-back', group: GROUPS.PLAYBACK, label: 'Shuttle backward (again = 2×)', shortcut: { key: 'j', display: 'J' }, enabled: hasSource, run: shuttleBackward });
  A({ id: 'shuttle-pause', group: GROUPS.PLAYBACK, label: 'Pause shuttle', shortcut: { key: 'k', display: 'K' }, enabled: hasSource, run: shuttleStop });
  A({ id: 'seek-forward', group: GROUPS.PLAYBACK, label: 'Step forward', shortcut: { key: 'ArrowRight', shift: false, display: '→' }, enabled: hasSource, run: () => seekOutput(getCurrentOutputTime() + 0.1) });
  A({ id: 'seek-back', group: GROUPS.PLAYBACK, label: 'Step back', shortcut: { key: 'ArrowLeft', shift: false, display: '←' }, enabled: hasSource, run: () => seekOutput(getCurrentOutputTime() - 0.1) });
  A({ id: 'seek-forward-1s', group: GROUPS.PLAYBACK, label: 'Jump forward 1s', shortcut: { key: 'ArrowRight', shift: true, display: '⇧→' }, enabled: hasSource, run: () => seekOutput(getCurrentOutputTime() + 1) });
  A({ id: 'seek-back-1s', group: GROUPS.PLAYBACK, label: 'Jump back 1s', shortcut: { key: 'ArrowLeft', shift: true, display: '⇧←' }, enabled: hasSource, run: () => seekOutput(getCurrentOutputTime() - 1) });
  A({ id: 'seek-start', group: GROUPS.PLAYBACK, label: 'Go to start', shortcut: { key: 'Home', display: 'Home' }, enabled: hasSource, run: () => seekOutput(0) });
  A({ id: 'seek-end', group: GROUPS.PLAYBACK, label: 'Go to end', shortcut: { key: 'End', display: 'End' }, enabled: hasSource, run: () => seekOutput(outputDuration()) });

  // Editing
  A({ id: 'undo', group: GROUPS.EDITING, label: 'Undo', shortcut: { mod: true, shift: false, key: 'z', display: '⌘Z', whileTyping: true }, enabled: canUndo, run: undo });
  A({ id: 'redo', group: GROUPS.EDITING, label: 'Redo', shortcut: { mod: true, shift: true, key: 'z', display: '⌘⇧Z', whileTyping: true }, enabled: canRedo, run: redo });
  A({ id: 'split', group: GROUPS.EDITING, label: 'Split at playhead', shortcut: { key: 's', display: 'S' }, enabled: hasSource, run: splitAtPlayhead });
  A({ id: 'trim-in', group: GROUPS.EDITING, label: 'Trim in to playhead', shortcut: { key: 'i', display: 'I' }, enabled: () => !!selectedSegment(), run: () => trimToPlayhead('in') });
  A({ id: 'trim-out', group: GROUPS.EDITING, label: 'Trim out to playhead', shortcut: { key: 'o', display: 'O' }, enabled: () => !!selectedSegment(), run: () => trimToPlayhead('out') });
  A({ id: 'duplicate', group: GROUPS.EDITING, label: 'Duplicate selected layer', shortcut: { mod: true, key: 'd', display: '⌘D', whileTyping: true }, enabled: () => !!selectedLayer(), run: () => { const l = selectedLayer(); if (l) duplicateLayer(l.id); } });
  A({ id: 'delete', group: GROUPS.EDITING, label: 'Delete selection', shortcut: { key: 'Delete', display: 'Del' }, run: deleteSelection });
  A({ id: 'delete-bksp', group: GROUPS.EDITING, label: 'Delete selection', shortcut: { key: 'Backspace' }, hidden: true, run: deleteSelection });
  A({ id: 'deselect', group: GROUPS.EDITING, label: 'Deselect', shortcut: { key: 'Escape', display: 'Esc' }, run: clearSelection });
  A({ id: 'add-text', group: GROUPS.EDITING, label: 'Add text', enabled: hasSource, run: () => runAddAction('text') });
  A({ id: 'add-captions', group: GROUPS.EDITING, label: 'Generate auto captions', enabled: hasSource, run: () => runAddAction('captions') });
  A({ id: 'add-overlay', group: GROUPS.EDITING, label: 'Add overlay', enabled: hasSource, run: () => runAddAction('overlay') });
  A({ id: 'add-sound', group: GROUPS.EDITING, label: 'Add sound', enabled: hasSource, run: () => runAddAction('sound') });

  // Timeline
  A({ id: 'zoom-in', group: GROUPS.TIMELINE, label: 'Zoom in timeline', shortcut: { key: '+', display: '+' }, enabled: hasSource, run: () => clickIfPresent('tl-zoom-in') });
  A({ id: 'zoom-in-eq', group: GROUPS.TIMELINE, label: 'Zoom in timeline', shortcut: { key: '=' }, hidden: true, enabled: hasSource, run: () => clickIfPresent('tl-zoom-in') });
  A({ id: 'zoom-out', group: GROUPS.TIMELINE, label: 'Zoom out timeline', shortcut: { key: '-', display: '−' }, enabled: hasSource, run: () => clickIfPresent('tl-zoom-out') });
  A({ id: 'zoom-fit', group: GROUPS.TIMELINE, label: 'Fit timeline to project', enabled: hasSource, run: () => clickIfPresent('tl-zoom-fit') });
  A({ id: 'toggle-snap', group: GROUPS.TIMELINE, label: 'Toggle snap / free timeline', enabled: hasSource, run: () => { snapToggle.checked = !snapToggle.checked; snapToggle.dispatchEvent(new Event('change')); } });

  // App
  A({ id: 'save', group: GROUPS.APP, label: 'Save project', shortcut: { mod: true, key: 's', display: '⌘S', whileTyping: true }, enabled: hasSource, run: doSave });
  A({ id: 'export', group: GROUPS.APP, label: 'Export', shortcut: { mod: true, key: 'e', display: '⌘E', whileTyping: true }, enabled: hasSource, run: openExport });
  A({ id: 'open-project', group: GROUPS.APP, label: 'Open project…', run: () => clickIfPresent('project-open-btn') });
  A({ id: 'save-as-template', group: GROUPS.APP, label: 'Save as template…', run: () => clickIfPresent('save-template-btn') });
  A({ id: 'brand-kit', group: GROUPS.APP, label: 'Open brand kit', run: () => clickIfPresent('brand-kit-btn') });
  A({ id: 'caption-settings', group: GROUPS.APP, label: 'Caption quality settings', run: () => clickIfPresent('cap-quality-settings-btn') });
  A({ id: 'phone-access', group: GROUPS.APP, label: 'Send to phone / Phone access', run: () => openPhoneModal() });
  A({ id: 'command-palette', group: GROUPS.APP, label: 'Command palette', shortcut: { mod: true, key: 'k', display: '⌘K', whileTyping: true }, run: openPalette });
  A({ id: 'shortcuts', group: GROUPS.APP, label: 'Keyboard shortcuts', shortcut: { key: '?', display: '?' }, run: openShortcuts });
}

// One global keydown → the registry. ⌘-combos may fire while typing (they're
// flagged whileTyping); single-key shortcuts never do. The palette/overlay own
// their keys while open.
function wireShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (paletteOpen() || shortcutsOpen()) return; // those surfaces own their keys
    // Esc while typing blurs the field (not a registry command).
    if (e.key === 'Escape' && isTypingTarget(e.target)) {
      e.target.blur();
      return;
    }
    const a = actionForEvent(e, { typing: isTypingTarget(e.target) });
    if (!a) return;
    e.preventDefault();
    if (isEnabled(a)) a.run();
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
const startTemplates = document.getElementById('start-templates');
const startTemplatesList = document.getElementById('start-templates-list');
const saveTemplateBtn = document.getElementById('save-template-btn');

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

// --- templates -----------------------------------------------------------------

async function refreshStartTemplates() {
  if (!startTemplates) return;
  if (state.source) {
    startTemplates.classList.add('hidden');
    return;
  }
  const templates = await fetchTemplates();
  if (!templates.length) {
    startTemplates.classList.add('hidden');
    return;
  }
  startTemplates.classList.remove('hidden');
  startTemplatesList.innerHTML = '';
  for (const t of templates) {
    const s = t.summary || {};
    const bits = [
      s.aspect,
      s.layout === 'split' ? 'split' : null,
      s.textCount ? `${s.textCount} text` : null,
      s.watermark ? 'watermark' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const card = document.createElement('div');
    card.className = 'template-card';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'template-card-open';
    open.innerHTML = `<span class="template-card-name">${escapeHtml(t.name)}</span><span class="template-card-sum">${escapeHtml(bits || 'Look only')}</span>`;
    open.addEventListener('click', () => newFromTemplate(t));
    card.appendChild(open);

    const actions = document.createElement('div');
    actions.className = 'template-card-actions';
    const ren = document.createElement('button');
    ren.type = 'button';
    ren.className = 'template-icon-btn';
    ren.title = 'Rename';
    ren.innerHTML = icon('pencil', 13);
    ren.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = await promptDialog({ title: 'Rename template', label: 'Template name', value: t.name, confirmLabel: 'Rename' });
      if (name) {
        await renameTemplate(t.id, name);
        refreshStartTemplates();
      }
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'template-icon-btn';
    del.title = 'Delete';
    del.innerHTML = icon('trash', 13);
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog({ title: 'Delete template?', itemName: t.name, confirmLabel: 'Delete' });
      if (ok) {
        await deleteTemplate(t.id);
        refreshStartTemplates();
      }
    });
    actions.append(ren, del);
    card.appendChild(actions);
    startTemplatesList.appendChild(card);
  }
}

function newFromTemplate(t) {
  applyTemplateData(t.data);
  hideRestoreBanner();
  // Still no clip, so the start screen stays; refresh it and prompt for a clip.
  refreshStartTemplates();
  setPlaceholder('Template ready — paste a clip link or open a file to start.');
}

function wireTemplates() {
  if (saveTemplateBtn) {
    saveTemplateBtn.addEventListener('click', async () => {
      const cur = projectNameEl.textContent || '';
      const suggested = cur && cur !== 'Untitled' ? cur : '';
      const name = await promptDialog({
        title: 'Save as template',
        label: 'Template name',
        value: suggested,
        placeholder: 'My template',
        confirmLabel: 'Save',
      });
      if (!name) return;
      try {
        await saveCurrentAsTemplate(name);
        showToast({ message: `Saved template “${name}”` });
      } catch (err) {
        showToast({ message: `Couldn't save template: ${err && err.message ? err.message : 'error'}` });
      }
    });
  }
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

  on('source', () => {
    startRecent.classList.add('hidden');
    if (startTemplates) startTemplates.classList.add('hidden');
  });

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
  initExportQueue(); // background export pill + queue (wires the pill's cancel)
  initPhone(); // Send to Phone — "Phone access" settings modal + pairing
  initBrandKit(); // loads the global brand kit + seeds this session's watermark
  initCaptionSettings(); // caption quality tier + custom vocabulary
  wireIngestion();
  wireToolbar();
  registerAllActions(); // single action registry (shortcuts + palette + overlay)
  wireShortcuts();
  initCommandUI(); // ⌘K command palette + ? shortcuts overlay
  wireProjects();
  // Keep "apply to whole video" text layers pinned to the project length as
  // clips are added, trimmed, or deleted.
  on('segments', syncFullDurationLayers);
  emit('settings');

  wireTemplates();
  refreshStartRecent();
  refreshStartTemplates();
  offerRestore();
  wireUpdatePill();
  // First-run onboarding: reveals the "try a sample clip" option + tour on the
  // very first launch only. Any real source load retires the offer silently.
  on('source', () => onSourceLoaded());
  // Fit template text to the clip once one loads into a template-based project.
  on('source', () => onTemplateClipLoaded());
  initOnboarding({ loadSample: loadSampleClip });
  initWhatsNew(); // one-time per-version "what's new" card after an update

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
