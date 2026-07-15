// Thin fetch wrappers for every server endpoint — the only module that
// talks HTTP, so the URL shapes live in exactly one place.

async function parseJsonResponse(res, fallbackError) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || fallbackError);
  return data;
}

export async function fetchFonts() {
  const res = await fetch('/api/fonts');
  return (await parseJsonResponse(res, 'Failed to load fonts')).fonts;
}

export async function fetchAspectRatios() {
  const res = await fetch('/api/aspect-ratios');
  return (await parseJsonResponse(res, 'Failed to load aspect ratios')).aspectRatios;
}

export async function fetchWhisperStatus() {
  const res = await fetch('/api/whisper-status');
  return parseJsonResponse(res, 'Failed to check caption support');
}

export async function fetchPreviewSource(url) {
  const res = await fetch('/api/preview-source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return parseJsonResponse(res, 'Failed to load clip');
}

// source is state.source — a URL source transcribes the already-cached
// download server-side; a file source uploads the file itself. mode:
// 'words' (one caption per word) or 'blocks' (short lines).
export async function transcribe(source, mode) {
  const formData = new FormData();
  formData.append('mode', mode);
  if (source.kind === 'file') {
    formData.append('video', source.file);
  } else {
    formData.append('url', source.url);
  }
  const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
  // { segments, tier, requestedTier, downgraded } — tier fields let the caller
  // note a transparent downgrade (requested model not downloaded yet).
  return parseJsonResponse(res, 'Transcription failed');
}

export async function fetchSfxPresets() {
  const res = await fetch('/api/sfx-presets');
  return (await parseJsonResponse(res, 'Failed to load sound presets')).presets;
}

export async function fetchOverlayPresets() {
  const res = await fetch('/api/overlay-presets');
  return (await parseJsonResponse(res, 'Failed to load overlay presets')).presets;
}

// Turns a served preset file into a File object, so presets ride the same
// FormData path to the renderer as user-picked files.
export async function presetAsFile(preset) {
  const res = await fetch(preset.url);
  const blob = await res.blob();
  return new File([blob], preset.id, { type: blob.type });
}

// --- personal asset library (global, userData) ---
export async function fetchLibrary() {
  const res = await fetch('/api/library');
  return (await parseJsonResponse(res, 'Failed to load your library')).items;
}
export async function importToLibrary(category, file) {
  const fd = new FormData();
  fd.append('category', category);
  fd.append('file', file, file.name);
  const res = await fetch('/api/library/import', { method: 'POST', body: fd });
  return parseJsonResponse(res, 'Failed to save to your library'); // { item, deduped }
}
export async function renameLibraryItem(id, name) {
  const res = await fetch('/api/library/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name }),
  });
  return (await parseJsonResponse(res, 'Failed to rename')).item;
}
export async function removeLibraryItem(id) {
  const res = await fetch('/api/library/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return parseJsonResponse(res, 'Failed to remove');
}
export const libraryFileUrl = (id) => `/api/library/file/${id}`;
export async function fetchLibraryUsage() {
  const res = await fetch('/api/library/usage');
  return parseJsonResponse(res, 'Failed to read library usage'); // { categories, total, path }
}
// A library item as a File, so it rides the same FormData export path as presets
// and user-picked files (used for sounds/overlays; fonts export server-side).
export async function libraryItemAsFile(item) {
  const res = await fetch(item.url || libraryFileUrl(item.id));
  const blob = await res.blob();
  return new File([blob], item.filename || item.name || item.id, { type: blob.type });
}

// --- brand kit (global, userData) ---
export async function fetchBrandKit() {
  const res = await fetch('/api/brand-kit');
  return parseJsonResponse(res, 'Failed to load brand kit');
}

// Saves the brand kit JSON; optionally uploads a new watermark image, or removes
// the current one (removeWatermark=true).
export async function saveBrandKit(kit, { imageFile = null, removeWatermark = false } = {}) {
  const formData = new FormData();
  formData.append('kit', JSON.stringify(kit));
  if (imageFile) formData.append('watermark', imageFile);
  if (removeWatermark) formData.append('removeWatermark', 'true');
  const res = await fetch('/api/brand-kit', { method: 'POST', body: formData });
  return parseJsonResponse(res, 'Failed to save brand kit');
}

// Cache-busted so a freshly-uploaded watermark shows immediately.
export function watermarkUrl(v) {
  return `/api/brand-kit/watermark?v=${v || Date.now()}`;
}

// --- caption settings (tier + custom vocabulary, global userData) ---
export async function fetchCaptionSettings() {
  const res = await fetch('/api/caption-settings');
  return parseJsonResponse(res, 'Failed to load caption settings');
}

export async function saveCaptionSettings(patch) {
  const res = await fetch('/api/caption-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return parseJsonResponse(res, 'Failed to save caption settings');
}

// --- misc persistent app UI state (onboarding shown, last-seen version) ---
export async function fetchAppState() {
  try {
    const res = await fetch('/api/app-state');
    return await parseJsonResponse(res, 'Failed to load app state');
  } catch {
    return {};
  }
}
export async function saveAppState(patch) {
  try {
    const res = await fetch('/api/app-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return await parseJsonResponse(res, 'Failed to save app state');
  } catch {
    return {};
  }
}

// --- caption model downloads ---
export async function startModelDownload(tier) {
  const res = await fetch('/api/model/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier }),
  });
  return parseJsonResponse(res, 'Failed to start download');
}
export async function modelDownloadStatus(jobId) {
  const res = await fetch(`/api/model/status/${jobId}`);
  return parseJsonResponse(res, 'Failed to read download status');
}
export async function cancelModelDownload(jobId) {
  await fetch(`/api/model/cancel/${jobId}`, { method: 'POST' });
}
export async function removeModel(tier) {
  const res = await fetch('/api/model/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier }),
  });
  return parseJsonResponse(res, 'Failed to remove model');
}

export async function startExport(endpoint, formData) {
  const res = await fetch(endpoint, { method: 'POST', body: formData });
  return parseJsonResponse(res, 'Failed to start export');
}

export async function fetchJobStatus(jobId) {
  const res = await fetch(`/api/status/${jobId}`);
  return parseJsonResponse(res, 'Failed to fetch job status');
}
