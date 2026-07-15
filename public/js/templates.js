// Project templates: capture the reusable LOOK of a project (aspect, layout,
// background, caption group style, watermark, manual text layers) and re-apply
// it to a fresh project — never the source clip or the auto-caption transcript.
import { state, emit, resetHistory, addTextLayer, outputDuration } from './state.js';
import { fetchTemplates, saveTemplate, renameTemplate, deleteTemplate } from './api.js';

const TEMPLATE_VERSION = 1;

// Held between applying a template and the first clip loading, so we can clamp
// fixed-duration text to the new clip's length AND re-apply the background style
// (blur is a per-clip setting that resetSegments() wipes when the clip loads).
let pendingClip = null; // { blur } or null

// Everything a template remembers. Manual text layers (group:null) ride along
// with their content/style/position/timing; auto-caption layers (group:'caption',
// the transcript) are deliberately excluded — only the caption STYLE is kept.
export function captureTemplateData() {
  return {
    version: TEMPLATE_VERSION,
    aspect: state.aspect,
    layout: state.layout,
    split: state.split,
    blur: state.blur,
    captionSettings: state.captionSettings,
    captionsHidden: state.captionsHidden,
    watermark: state.watermark,
    textLayers: state.layers
      .filter((l) => l.group !== 'caption')
      .map((l) => {
        const { id, ...rest } = l; // drop the runtime id; a fresh one is assigned on apply
        return rest;
      }),
  };
}

// A tiny at-a-glance summary for the template card (no thumbnail render).
export function templateSummary() {
  return {
    aspect: (state.aspect && state.aspect.id) || null,
    layout: state.layout || 'fill',
    textCount: state.layers.filter((l) => l.group !== 'caption').length,
    watermark: !!(state.watermark && state.watermark.enabled),
  };
}

export async function saveCurrentAsTemplate(name) {
  return saveTemplate({ name, data: captureTemplateData(), summary: templateSummary() });
}
export { fetchTemplates, renameTemplate, deleteTemplate };

// Reset the editor to a fresh, source-less project carrying the template's look.
// Used by "New from template" from the start screen (no clip loaded yet).
export function applyTemplateData(data) {
  if (!data) return;
  // Fresh project surface — no clip, no content beyond the template's own text.
  state.source = null;
  state.segments = [];
  state.appendedClips = [];
  state.overlays = [];
  state.sounds = [];
  state.keyframes = [];
  state.transitions = [];
  state.layers = [];
  state.sel = null;
  state.selPieces = [];

  // The reusable look.
  if (data.aspect) state.aspect = data.aspect;
  state.layout = data.layout === 'split' ? 'split' : 'fill';
  if (data.split) state.split = { ...state.split, ...data.split };
  if (Number.isFinite(data.blur)) state.blur = data.blur;
  if (data.captionSettings) state.captionSettings = { ...state.captionSettings, ...data.captionSettings };
  state.captionsHidden = !!data.captionsHidden;
  if (data.watermark) state.watermark = { ...state.watermark, ...data.watermark };

  // Re-create the manual text layers with fresh ids (addTextLayer applies the
  // template's captured values over the defaults, so the look is preserved).
  for (const l of data.textLayers || []) {
    addTextLayer({ ...l, group: null }, { select: false });
  }

  // Background blur is a per-clip setting that resetSegments() zeroes on load, so
  // remember it and re-apply after the clip arrives (see onTemplateClipLoaded).
  pendingClip = { blur: Number.isFinite(data.blur) ? data.blur : null };
  emit('settings'); // aspect / background / watermark controls
  emit('segments');
  emit('layers');
  emit('keyframes');
  emit('selection');
  resetHistory();
}

// On the first clip load into a template-based project, fit the template's text
// to the clip: fullDuration layers already re-pin via syncFullDurationLayers;
// fixed-duration layers get clamped into [0, clipLength] so nothing sits past
// the end regardless of how long (or short) the clip is.
export function onTemplateClipLoaded() {
  if (!pendingClip) return;
  const { blur } = pendingClip;
  pendingClip = null;

  // Re-apply the background style that the clip load reset.
  if (Number.isFinite(blur) && blur !== state.blur) {
    state.blur = blur;
    emit('settings');
  }

  const dur = outputDuration() || 0;
  if (dur <= 0) return;
  let changed = false;
  for (const l of state.layers) {
    if (l.fullDuration) continue;
    const len = Math.min(Math.max(0.3, l.end - l.start), dur);
    if (l.end > dur) {
      l.end = dur;
      l.start = Math.max(0, Math.min(l.start, dur - len));
      changed = true;
    }
    if (l.start >= l.end) {
      l.start = Math.max(0, l.end - len);
      changed = true;
    }
  }
  if (changed) emit('layers');
}
