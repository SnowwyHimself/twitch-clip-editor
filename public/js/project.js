// Phase 1 — project save/load + autosave. A project is a JSON snapshot of the
// editable editor state plus any imported sound/overlay media, stored
// server-side under projects/<id>/. The source video isn't copied: URL sources
// re-resolve through the existing preview-cache, file sources re-resolve by
// path (packaged app) or prompt the user to re-locate the file.

import { state, emit, on, off, resetHistory } from './state.js';
import { attachSource, setPlaceholder } from './preview.js';
import { fetchPreviewSource } from './api.js';

const PROJECT_VERSION = 1;
const AUTOSAVE_ID = 'autosave';
const AUTOSAVE_INTERVAL_MS = 15000;
const AUTOSAVE_DEBOUNCE_MS = 1500;

let currentProjectId = null;
let currentProjectName = 'Untitled';
const listeners = new Set(); // notified when project id/name changes

export function onProjectChange(fn) {
  listeners.add(fn);
}
function notify() {
  for (const fn of listeners) fn({ id: currentProjectId, name: currentProjectName });
}
export function currentProject() {
  return { id: currentProjectId, name: currentProjectName };
}

// --- serialization ------------------------------------------------------------

// The editable slice of state. Runtime-only fields (sel, fonts, aspectRatios,
// whisper) and live handles (source.file / previewUrl, overlay/sound File
// objects) are excluded — media is uploaded separately and re-linked on open.
function serialize() {
  const src = state.source;
  return {
    version: PROJECT_VERSION,
    id: currentProjectId,
    name: currentProjectName,
    savedAt: Date.now(),
    source: src
      ? {
          kind: src.kind,
          url: src.url || null,
          section: src.section || null,
          name: src.name || (src.file && src.file.name) || null,
          path: src.path || (src.file && src.file.path) || null,
          width: src.width || null,
          height: src.height || null,
          duration: src.duration || null,
        }
      : null,
    aspect: state.aspect,
    zoom: state.zoom,
    blur: state.blur,
    speed: state.speed,
    mirror: state.mirror,
    panX: state.panX,
    panY: state.panY,
    audio: state.audio,
    layout: state.layout,
    split: state.split,
    keyframes: state.keyframes,
    faceTrack: state.faceTrack,
    segments: state.segments,
    timelineMode: state.timelineMode,
    transitions: state.transitions,
    layers: state.layers,
    captionsHidden: state.captionsHidden,
    captionSettings: state.captionSettings,
    overlays: state.overlays.map((o) => ({ ...o, file: undefined, mediaId: o.file ? o.id : null })),
    sounds: state.sounds.map((s) => ({ ...s, file: undefined, mediaId: s.file ? s.id : null })),
  };
}

function collectMedia() {
  const media = [];
  for (const o of state.overlays) if (o.file) media.push({ id: o.id, file: o.file });
  for (const s of state.sounds) if (s.file) media.push({ id: s.id, file: s.file });
  return media;
}

// --- save ---------------------------------------------------------------------

async function postSave(project, media) {
  const fd = new FormData();
  fd.append('project', JSON.stringify(project));
  for (const m of media) fd.append('media', m.file, m.id); // originalname = media id
  const res = await fetch('/api/project/save', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Save failed (${res.status})`);
  return res.json();
}

// Save to the current project (creating one on first save).
export async function saveProject() {
  if (!state.source) return { ok: false, reason: 'no-clip' };
  const project = serialize();
  const { id, name, savedAt } = await postSave(project, collectMedia());
  currentProjectId = id;
  currentProjectName = name;
  notify();
  return { ok: true, id, name, savedAt };
}

// Save As — always a fresh project id/name.
export async function saveProjectAs(name) {
  if (!state.source) return { ok: false, reason: 'no-clip' };
  currentProjectId = null;
  currentProjectName = name || 'Untitled';
  return saveProject();
}

export function renameCurrent(name) {
  currentProjectName = name || 'Untitled';
  notify();
}

// --- autosave -----------------------------------------------------------------

let autosaveTimer = null;
let autosaveDebounce = null;
let autosaveEnabled = false;

async function writeAutosave() {
  if (!autosaveEnabled || !state.source) return;
  const project = serialize();
  project.id = AUTOSAVE_ID;
  project.autosaveOf = currentProjectId;
  project.name = currentProjectName;
  try {
    await postSave(project, collectMedia());
  } catch {
    /* autosave is best-effort */
  }
}

export function startAutosave() {
  autosaveEnabled = true;
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(writeAutosave, AUTOSAVE_INTERVAL_MS);
  // Debounced save on every destructive change.
  const bump = () => {
    clearTimeout(autosaveDebounce);
    autosaveDebounce = setTimeout(writeAutosave, AUTOSAVE_DEBOUNCE_MS);
  };
  for (const ev of ['segments', 'layers', 'settings', 'keyframes', 'facetrack', 'history']) on(ev, bump);
}

// --- listing ------------------------------------------------------------------

export async function listProjects() {
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) return { projects: [], autosave: null };
    return res.json();
  } catch {
    return { projects: [], autosave: null };
  }
}

export async function deleteProject(id) {
  await fetch(`/api/project/${id}`, { method: 'DELETE' }).catch(() => {});
}

// --- open ---------------------------------------------------------------------

// Attaches the project's source and resolves once it's playable. URL sources
// re-resolve via preview-cache; file sources via their absolute path (packaged
// app). Returns { ok } or { ok:false, reason:'need-file' } when the file must
// be re-picked by the user.
// Resolves on the next 'source' event (fired once the video's metadata loads),
// with a timeout guard so a failed load can't hang the open.
function waitForSource() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      off('source', finish);
      resolve();
    };
    on('source', finish);
    setTimeout(finish, 15000);
  });
}

async function attachProjectSource(data) {
  const src = data.source;
  if (!src) return { ok: false, reason: 'no-source' };
  if (src.kind === 'url' && src.url) {
    setPlaceholder('Re-loading clip…');
    const { previewUrl } = await fetchPreviewSource(src.url, src.section || undefined);
    const ready = waitForSource();
    attachSource(previewUrl, { kind: 'url', url: src.url, section: src.section }, { isObjectUrl: false });
    await ready;
    return { ok: true };
  }
  if (src.kind === 'file' && src.path) {
    const res = await fetch('/api/preview-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: src.path }),
    });
    if (res.ok) {
      const { previewUrl } = await res.json();
      const ready = waitForSource();
      attachSource(previewUrl, { kind: 'file', name: src.name, path: src.path }, { isObjectUrl: false });
      await ready;
      return { ok: true };
    }
  }
  return { ok: false, reason: 'need-file' };
}

async function rehydrateMedia(projectId, items) {
  const out = [];
  for (const item of items) {
    const copy = { ...item };
    delete copy.mediaId;
    if (item.mediaId) {
      try {
        const blob = await fetch(`/api/project/${projectId}/media/${item.mediaId}`).then((r) => r.blob());
        copy.file = new File([blob], item.mediaId, { type: blob.type });
      } catch {
        copy.file = null;
      }
    }
    out.push(copy);
  }
  return out;
}

function applyStateFields(data, overlays, sounds) {
  if (data.aspect) state.aspect = data.aspect;
  if (Number.isFinite(data.zoom)) state.zoom = data.zoom;
  if (Number.isFinite(data.blur)) state.blur = data.blur;
  if (Number.isFinite(data.speed)) state.speed = data.speed;
  state.mirror = !!data.mirror;
  if (Number.isFinite(data.panX)) state.panX = data.panX;
  if (Number.isFinite(data.panY)) state.panY = data.panY;
  state.audio = data.audio && typeof data.audio === 'object'
    ? { volumePercent: 100, muted: false, fadeIn: 0, fadeOut: 0, ...data.audio }
    : { volumePercent: 100, muted: false, fadeIn: 0, fadeOut: 0 };
  state.layout = data.layout === 'split' ? 'split' : 'fill';
  if (data.split) state.split = data.split;
  state.keyframes = data.keyframes || [];
  state.faceTrack = data.faceTrack || { enabled: false, samples: [] };
  state.segments = data.segments || [];
  state.timelineMode = data.timelineMode || 'snap';
  state.transitions = data.transitions || [];
  state.layers = data.layers || [];
  state.captionsHidden = !!data.captionsHidden;
  if (data.captionSettings) state.captionSettings = data.captionSettings;
  state.overlays = overlays;
  state.sounds = sounds;
  state.sel = null;
}

// Opens a saved project by id. Returns { ok } or { ok:false, reason }.
export async function openProject(id) {
  let data;
  try {
    data = await fetch(`/api/project/${id}`).then((r) => (r.ok ? r.json() : null));
  } catch {
    data = null;
  }
  if (!data) return { ok: false, reason: 'not-found' };
  return applyProjectData(id, data);
}

async function applyProjectData(id, data) {
  const src = await attachProjectSource(data);
  if (!src.ok) return { ok: false, reason: src.reason, data };
  // Media is stored under the SAVED project id (autosave stores its own copies).
  const mediaProjectId = id;
  const overlays = await rehydrateMedia(mediaProjectId, data.overlays || []);
  const sounds = await rehydrateMedia(mediaProjectId, data.sounds || []);
  applyStateFields(data, overlays, sounds);
  currentProjectId = data.autosaveOf || (id === AUTOSAVE_ID ? null : id);
  currentProjectName = data.name || 'Untitled';
  emit('segments');
  emit('layers');
  emit('settings');
  emit('keyframes');
  emit('facetrack');
  emit('selection');
  resetHistory();
  notify();
  return { ok: true };
}

// Restore the autosave slot (called from the start screen prompt).
export async function restoreAutosave() {
  let data;
  try {
    data = await fetch(`/api/project/${AUTOSAVE_ID}`).then((r) => (r.ok ? r.json() : null));
  } catch {
    data = null;
  }
  if (!data) return { ok: false, reason: 'not-found' };
  return applyProjectData(AUTOSAVE_ID, data);
}

// For a file source that couldn't be auto-resolved (moved/deleted), the caller
// re-picks the file; this finishes loading the rest of the project onto it.
export async function finishOpenWithFile(id, data, file) {
  const ready = waitForSource();
  attachSource(URL.createObjectURL(file), { kind: 'file', file }, { isObjectUrl: true });
  await ready;
  const overlays = await rehydrateMedia(id, data.overlays || []);
  const sounds = await rehydrateMedia(id, data.sounds || []);
  applyStateFields(data, overlays, sounds);
  currentProjectId = id === AUTOSAVE_ID ? null : id;
  currentProjectName = data.name || 'Untitled';
  emit('segments');
  emit('layers');
  emit('settings');
  emit('keyframes');
  emit('facetrack');
  emit('selection');
  resetHistory();
  notify();
  return { ok: true };
}
