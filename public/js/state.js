// The single editor state object ("edit spec") every other module renders
// from and writes into — preview, timeline, properties panel, and the
// export payload are all pure functions of this. It's deliberately plain
// JSON-serializable data (files aside): the same spec a future
// ffmpeg.wasm/extension build would consume, so nothing about the editor
// UI couples to the server renderer.
//
// Time domains, once, for the whole app:
// - SOURCE seconds: positions in the original downloaded clip. Segment
//   in/out points, text layer start/end, the sound effect's start, and
//   the video element's currentTime all live here.
// - OUTPUT seconds: positions on the final timeline. Each segment carries
//   an explicit `outStart` (where it sits in the output), so cuts
//   collapse away in snap mode and gaps (rendered as black) can exist in
//   free mode. Speed is NOT part of this domain; export.js divides by
//   speed when building ffmpeg enable times.

export const state = {
  // { kind: 'url'|'file', url, section, file, previewUrl, duration, width, height }
  source: null,

  // Canvas / global video settings. These start neutral (no-op): zoom
  // 100%, no blur, 1x speed, no mirror, no pan. A saved preset (see
  // presets in panel.js) can auto-apply a preferred look on import.
  // panX/panY move the main clip over the blurred background, -100..100
  // (% of half the canvas; 0 = centered).
  aspect: { id: '9:16', width: 1080, height: 1920 },
  zoom: 1.0,
  blur: 0,
  speed: 1,
  mirror: false,
  panX: 0,
  panY: 0,

  // Zoom/position keyframes for the main clip — animate a punch-in or a
  // slow push/pan. Each is { id, t, zoom, panX, panY } where t is a SOURCE
  // second. Empty = no animation (the static zoom/panX/panY above are used).
  // When non-empty, the transform at any time is interpolated between the
  // surrounding keyframes (see keyframeTransformAt).
  keyframes: [],

  // Layout: 'fill' = one clip fills the canvas (zoom/pan/blur, the default).
  // 'split' = Twitch vertical: a facecam region stacked on top of a gameplay
  // region. Each region is a cover-crop of the source centred at (cx,cy) with
  // its own zoom; ratio is the facecam region's share of the canvas height.
  layout: 'fill',
  split: {
    ratio: 0.34,
    facecam: { cx: 0.17, cy: 0.34, zoom: 2.2 }, // default: zoomed into the top-left (where facecams usually sit)
    gameplay: { cx: 0.5, cy: 0.52, zoom: 1.2 }, // default: centred gameplay
  },

  // Face tracking (auto-reframe). A distinct render mode from keyframes/pan:
  // when enabled the clip is shown as a frame-filling window that pans LEFT/
  // RIGHT only to follow the chosen face, clamped to the source edges (never
  // black bars). samples: [{ t (source s), x (0..1 face centre in source
  // width), z (depth zoom, 1 = none) }], sorted by t.
  faceTrack: { enabled: false, samples: [] },

  // The KEPT pieces of the source — source-ordered, non-overlapping in
  // both domains. { id, start, end, outStart }: start/end are the source
  // in/out points (trim handles pull them back out over cut footage —
  // nothing is ever destroyed), outStart is the piece's position on the
  // output timeline.
  segments: [],

  // Single selection across every clip kind: { kind, id } | null, where
  // kind is 'segment' | 'layer' | 'sound' | 'overlay'. One field so the
  // Split/Delete buttons and the panel can act on whatever's selected,
  // regardless of type.
  sel: null,

  // 'snap' (CapCut): pieces always close up, deletes ripple. 'free'
  // (Premiere): pieces sit wherever they're dropped; output gaps play as
  // black.
  timelineMode: 'snap',

  // Transitions at piece boundaries. { id, afterSegmentId, type, duration }
  // — currently only type 'white-flash' (dip to white).
  transitions: [],

  // Text layers — see addTextLayer for the shape of one. Layers created
  // by Auto captions carry group:'caption' so the Captions tab can style
  // and regenerate them as a set; hand-made layers have group:null.
  layers: [],

  // When true, every caption (group:'caption') is hidden in preview and
  // skipped at export — the data is kept so it restores exactly when re-shown.
  captionsHidden: false,

  // The Captions tab's shared settings, applied to every group:'caption'
  // layer at once (like CapCut/TikTok's caption styling, which styles the
  // whole caption track, not one block at a time).
  captionSettings: {
    mode: 'words', // 'words' = one word at a time | 'blocks' = short lines
    style: 'outline',
    fontId: null, // null -> default font, resolved at generation time
    fontSize: 58,
    color: '#ffffff',
    dropShadow: false,
    yPercent: 75,
    // Nudge every caption's timing by this many seconds (whisper often
    // reports words slightly early, especially on noisy clips) — positive
    // = later. Applied relative to each caption's original whisper time
    // (baseStart/baseEnd), so it's always re-derivable, not cumulative.
    timingOffset: 0.15,
  },

  // Media overlays — each its own clip on the Overlay row (create/delete/
  // split individually, like text). start/end are SOURCE seconds (when
  // it's on screen), offset is how far into the media the clip starts
  // (matters for split — the right half continues the video), crop* are
  // 0-45% off each edge of the media, and they render ABOVE the video. A
  // video overlay plays/pauses in sync with the editor while in range.
  // { id, file, isVideo, url, sizePercent, xPercent, yPercent, cropTop,
  //   cropBottom, cropLeft, cropRight, start, end, offset, duration }
  overlays: [],
  // Sound clips — each its own clip on the Sound row (create/delete/split
  // individually). start/end are SOURCE seconds (timeline placement),
  // offset is how far into the audio file the clip begins, duration is the
  // file's length. { id, file, label, url, volumePercent, start, end,
  //   offset, duration }
  sounds: [],

  // Server-provided option lists, loaded once at boot
  fonts: [],
  aspectRatios: [],
  whisper: { ready: false, binaryFound: false, modelFound: false },
};

export const MIN_SEGMENT_SECONDS = 0.3;
export const MIN_LAYER_SECONDS = 0.2;

// --- tiny event bus -------------------------------------------------------
// Event names: 'source' (new media + metadata known), 'segments' (pieces,
// mode, or transitions changed), 'layers', 'selection', 'settings' (any
// global video setting / overlay / sfx), 'time' ({src, out} — playhead
// moved, high-frequency), 'history' (undo/redo availability changed).

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(fn);
}

export function off(event, fn) {
  const arr = listeners.get(event);
  if (!arr) return;
  const i = arr.indexOf(fn);
  if (i !== -1) arr.splice(i, 1);
}

export function emit(event, detail) {
  for (const fn of listeners.get(event) || []) fn(detail);
  if (HISTORY_EVENTS.has(event)) scheduleHistoryRecord(event);
}

// --- helpers --------------------------------------------------------------

export function sourceDuration() {
  return state.source && Number.isFinite(state.source.duration) ? state.source.duration : 0;
}

export function keptSegments() {
  return state.segments;
}

// --- output-time mapping ----------------------------------------------------

export function outputDuration() {
  return state.segments.reduce((max, seg) => Math.max(max, seg.outStart + (seg.end - seg.start)), 0);
}

// Source position -> output position. Footage that's currently cut (in no
// piece) maps to the start of the next piece — so a text layer anchored to
// cut footage collapses onto the cut point rather than drifting.
export function sourceToOutput(t) {
  let lastEnd = 0;
  for (const seg of state.segments) {
    if (t < seg.start) return seg.outStart;
    if (t <= seg.end) return seg.outStart + (t - seg.start);
    lastEnd = seg.outStart + (seg.end - seg.start);
  }
  return lastEnd;
}

// Output position -> source position, or null when it falls in an output
// gap (free mode) — there is no footage there, the preview shows black.
export function outputToSource(t) {
  for (const seg of state.segments) {
    const len = seg.end - seg.start;
    if (t >= seg.outStart - 0.001 && t <= seg.outStart + len) {
      return seg.start + Math.max(0, t - seg.outStart);
    }
  }
  return null;
}

// Like outputToSource but never null: snaps into the nearest piece —
// used for scrub targets where "closest footage" beats "nothing".
export function outputToSourceClamped(t) {
  const exact = outputToSource(t);
  if (exact !== null) return exact;
  let best = null;
  let bestDist = Infinity;
  for (const seg of state.segments) {
    const len = seg.end - seg.start;
    const distBefore = seg.outStart - t;
    const distAfter = t - (seg.outStart + len);
    if (distBefore >= 0 && distBefore < bestDist) {
      bestDist = distBefore;
      best = seg.start;
    }
    if (distAfter >= 0 && distAfter < bestDist) {
      bestDist = distAfter;
      best = seg.end;
    }
  }
  return best !== null ? best : 0;
}

// The piece whose output span contains outT, or null (gap).
export function pieceAtOutput(outT) {
  return (
    state.segments.find((seg) => outT >= seg.outStart - 0.001 && outT < seg.outStart + (seg.end - seg.start)) || null
  );
}

// Lays pieces end to end (snap mode's invariant; also used when switching
// free -> snap). Keeps source order.
export function normalizeOutStarts() {
  let cursor = 0;
  for (const seg of state.segments) {
    seg.outStart = cursor;
    cursor += seg.end - seg.start;
  }
}

export function setTimelineMode(mode) {
  if (state.timelineMode === mode) return;
  state.timelineMode = mode;
  if (mode === 'snap') normalizeOutStarts();
  emit('segments');
}

// --- segments ---------------------------------------------------------------

let segmentCounter = 0;

function newSegment(start, end, outStart) {
  return { id: `seg-${Date.now()}-${segmentCounter++}`, start, end, outStart };
}

export function resetSegments() {
  const duration = sourceDuration();
  state.segments = duration > 0 ? [newSegment(0, duration, 0)] : [];
  state.sel = null;
  state.transitions = [];
  state.keyframes = [];
  state.faceTrack = { enabled: false, samples: [] };
  emit('segments');
  emit('keyframes');
  emit('facetrack');
}

// Splits whichever piece contains this SOURCE time into two touching
// pieces (contiguous in both domains) — splitting only creates a
// boundary, it never changes what's kept. Returns the new right piece.
export function splitSegmentAt(time) {
  const idx = state.segments.findIndex(
    (seg) => time > seg.start + MIN_SEGMENT_SECONDS && time < seg.end - MIN_SEGMENT_SECONDS
  );
  if (idx === -1) return null;
  const seg = state.segments[idx];
  const right = newSegment(time, seg.end, seg.outStart + (time - seg.start));
  seg.end = time;
  state.segments.splice(idx + 1, 0, right);
  // A transition sitting after the split piece belongs after the RIGHT
  // half now (it marks the boundary with the next piece).
  for (const tr of state.transitions) {
    if (tr.afterSegmentId === seg.id) tr.afterSegmentId = right.id;
  }
  emit('segments');
  return right;
}

// Delete: in snap mode the remaining pieces close up (ripple); in free
// mode they stay put and the hole plays as black. Either way the footage
// itself is preserved — neighbors' trim handles can always be dragged
// back out over it.
export function removeSegment(id) {
  if (state.segments.length <= 1) return;
  const idx = state.segments.findIndex((s) => s.id === id);
  if (idx === -1) return;
  state.segments.splice(idx, 1);
  state.transitions = state.transitions.filter((tr) => tr.afterSegmentId !== id);
  if (state.timelineMode === 'snap') normalizeOutStarts();
  if (isSelected('segment', id)) clearSelection();
  emit('segments');
}

// --- transitions ---------------------------------------------------------------

let transitionCounter = 0;

// Attaches a white-flash at the boundary after this piece (it must have a
// following piece). One transition per boundary — re-adding replaces.
export function addTransitionAfter(segmentId, duration) {
  const idx = state.segments.findIndex((s) => s.id === segmentId);
  if (idx === -1 || idx === state.segments.length - 1) return null;
  state.transitions = state.transitions.filter((tr) => tr.afterSegmentId !== segmentId);
  const tr = {
    id: `tr-${Date.now()}-${transitionCounter++}`,
    afterSegmentId: segmentId,
    type: 'white-flash',
    duration,
  };
  state.transitions.push(tr);
  emit('segments');
  return tr;
}

export function removeTransition(id) {
  const before = state.transitions.length;
  state.transitions = state.transitions.filter((tr) => tr.id !== id);
  if (state.transitions.length !== before) emit('segments');
}

export function transitionAfter(segmentId) {
  return state.transitions.find((tr) => tr.afterSegmentId === segmentId) || null;
}

// --- selection -------------------------------------------------------------------
// One selection across all clip kinds (only one thing is ever selected).
// isSelected(kind, id) is the highlight check; the typed selectX/selectedX
// wrappers keep call sites readable.

export function select(kind, id) {
  if (id == null) return clearSelection();
  if (state.sel && state.sel.kind === kind && state.sel.id === id) return;
  state.sel = { kind, id };
  emit('selection');
}

export function clearSelection() {
  if (!state.sel) return;
  state.sel = null;
  emit('selection');
}

export function isSelected(kind, id) {
  return !!state.sel && state.sel.kind === kind && state.sel.id === id;
}

export function selectLayer(id) {
  if (id == null) clearSelection();
  else select('layer', id);
}
export function selectSegment(id) {
  select('segment', id);
}
export function selectSound(id) {
  select('sound', id);
}
export function selectOverlay(id) {
  select('overlay', id);
}

export function selectedLayer() {
  return state.sel && state.sel.kind === 'layer' ? state.layers.find((l) => l.id === state.sel.id) || null : null;
}
export function selectedSegment() {
  return state.sel && state.sel.kind === 'segment' ? state.segments.find((s) => s.id === state.sel.id) || null : null;
}
export function selectedSound() {
  return state.sel && state.sel.kind === 'sound' ? state.sounds.find((s) => s.id === state.sel.id) || null : null;
}
export function selectedOverlay() {
  return state.sel && state.sel.kind === 'overlay' ? state.overlays.find((o) => o.id === state.sel.id) || null : null;
}

// --- text layers ------------------------------------------------------------------

let layerCounter = 0;

export function addTextLayer(partial = {}, { select = true } = {}) {
  const layer = {
    id: `layer-${Date.now()}-${layerCounter++}`,
    text: 'New text',
    style: 'outline', // 'outline' | 'plain' | 'box'
    fontId: defaultFontId(),
    fontSize: 64,
    color: '#ffffff',
    dropShadow: false,
    xPercent: 50,
    yPercent: 25,
    start: 0,
    end: 3,
    group: null, // 'caption' for Auto captions layers
    ...partial,
  };
  state.layers.push(layer);
  emit('layers');
  if (select) selectLayer(layer.id);
  return layer;
}

export function updateLayer(id, patch) {
  const layer = state.layers.find((l) => l.id === id);
  if (!layer) return;
  Object.assign(layer, patch);
  emit('layers');
}

export function removeLayer(id) {
  const idx = state.layers.findIndex((l) => l.id === id);
  if (idx === -1) return;
  state.layers.splice(idx, 1);
  if (isSelected('layer', id)) clearSelection();
  emit('layers');
}

// Splits a text layer into two at a SOURCE time — the two halves are
// independent layers with identical styling. Returns the new right half.
export function splitLayerAt(id, srcTime) {
  const layer = state.layers.find((l) => l.id === id);
  if (!layer) return null;
  if (srcTime <= layer.start + MIN_LAYER_SECONDS || srcTime >= layer.end - MIN_LAYER_SECONDS) return null;
  const right = { ...layer, id: `layer-${Date.now()}-${layerCounter++}`, start: srcTime };
  layer.end = srcTime;
  state.layers.splice(state.layers.indexOf(layer) + 1, 0, right);
  emit('layers');
  return right;
}

export function captionLayers() {
  return state.layers.filter((l) => l.group === 'caption');
}

export function removeCaptionLayers() {
  if (captionLayers().length === 0) return;
  const sel = selectedLayer();
  if (sel && sel.group === 'caption') clearSelection();
  state.layers = state.layers.filter((l) => l.group !== 'caption');
  emit('layers');
}

// --- sounds -----------------------------------------------------------------------
// Sounds/overlays hold File objects, so they stay OUT of undo history and
// ride the 'settings' event (same as when each was a single item).

let soundCounter = 0;

export function addSound(partial = {}, { select: doSelect = true } = {}) {
  const sound = {
    id: `sound-${Date.now()}-${soundCounter++}`,
    file: null,
    label: 'Sound',
    url: null,
    volumePercent: 80,
    start: 0,
    end: 1,
    offset: 0,
    duration: 1,
    ...partial,
  };
  state.sounds.push(sound);
  emit('settings');
  if (doSelect) selectSound(sound.id);
  return sound;
}

export function updateSound(id, patch) {
  const s = state.sounds.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, patch);
  emit('settings');
}

export function removeSound(id) {
  const i = state.sounds.findIndex((s) => s.id === id);
  if (i === -1) return;
  state.sounds.splice(i, 1);
  if (isSelected('sound', id)) clearSelection();
  emit('settings');
}

// Split at a SOURCE time — the right half continues the audio (its offset
// advances so it plays where the left half left off).
export function splitSoundAt(id, srcTime) {
  const s = state.sounds.find((x) => x.id === id);
  if (!s) return null;
  if (srcTime <= s.start + MIN_LAYER_SECONDS || srcTime >= s.end - MIN_LAYER_SECONDS) return null;
  const right = {
    ...s,
    id: `sound-${Date.now()}-${soundCounter++}`,
    start: srcTime,
    offset: s.offset + (srcTime - s.start),
  };
  s.end = srcTime;
  state.sounds.splice(state.sounds.indexOf(s) + 1, 0, right);
  emit('settings');
  return right;
}

// --- overlays ---------------------------------------------------------------------

let overlayCounter = 0;

export function addOverlay(partial = {}, { select: doSelect = true } = {}) {
  const duration = sourceDuration();
  const o = {
    id: `ovl-${Date.now()}-${overlayCounter++}`,
    file: null,
    isVideo: false,
    url: null,
    sizePercent: 35,
    xPercent: 50,
    yPercent: 50,
    cropTop: 0,
    cropBottom: 0,
    cropLeft: 0,
    cropRight: 0,
    start: 0,
    end: duration > 0 ? duration : 5,
    offset: 0,
    duration: 0,
    ...partial,
  };
  state.overlays.push(o);
  emit('settings');
  if (doSelect) selectOverlay(o.id);
  return o;
}

export function updateOverlay(id, patch) {
  const o = state.overlays.find((x) => x.id === id);
  if (!o) return;
  Object.assign(o, patch);
  emit('settings');
}

// Clamps one crop edge (0–100%) so the two opposite edges still leave a sliver
// of the axis (never a zero-size crop, which would break the render). The
// single source of truth shared by the crop sliders AND the on-canvas crop
// handles, so both produce identical values.
const CROP_OPPOSITE = { cropTop: 'cropBottom', cropBottom: 'cropTop', cropLeft: 'cropRight', cropRight: 'cropLeft' };
export const CROP_MIN_REMAINING = 2; // % of the axis that must survive
export function clampCropValue(overlay, key, value) {
  const max = Math.min(100, 100 - CROP_MIN_REMAINING - (overlay[CROP_OPPOSITE[key]] || 0));
  return Math.max(0, Math.min(max, Math.round(value)));
}

export function removeOverlay(id) {
  const i = state.overlays.findIndex((o) => o.id === id);
  if (i === -1) return;
  state.overlays.splice(i, 1);
  if (isSelected('overlay', id)) clearSelection();
  emit('settings');
}

export function splitOverlayAt(id, srcTime) {
  const o = state.overlays.find((x) => x.id === id);
  if (!o) return null;
  if (srcTime <= o.start + MIN_LAYER_SECONDS || srcTime >= o.end - MIN_LAYER_SECONDS) return null;
  const right = {
    ...o,
    id: `ovl-${Date.now()}-${overlayCounter++}`,
    start: srcTime,
    // A video overlay continues playing where the left half stopped.
    offset: o.isVideo ? o.offset + (srcTime - o.start) : o.offset,
  };
  o.end = srcTime;
  state.overlays.splice(state.overlays.indexOf(o) + 1, 0, right);
  emit('settings');
  return right;
}

// --- zoom/position keyframes --------------------------------------------------
// Keyframes hold a full {zoom, panX, panY} snapshot at a source time. The
// transform at any moment is interpolated (ease-in-out) between the two
// surrounding keyframes, so a couple of keyframes make a punch-in or push.

const KEYFRAME_EPSILON = 0.04; // s — keyframes closer than this share a slot
let keyframeCounter = 0;

// Adds (or, if one already sits at this time, updates) a keyframe capturing
// the given transform — defaults to the current live zoom/panX/panY.
export function addKeyframe(t, values) {
  const v = values || { zoom: state.zoom, panX: state.panX, panY: state.panY };
  const existing = state.keyframes.find((k) => Math.abs(k.t - t) <= KEYFRAME_EPSILON);
  if (existing) {
    existing.zoom = v.zoom;
    existing.panX = v.panX;
    existing.panY = v.panY;
    emit('keyframes');
    return existing;
  }
  const kf = { id: `kf-${Date.now()}-${keyframeCounter++}`, t, zoom: v.zoom, panX: v.panX, panY: v.panY };
  state.keyframes.push(kf);
  state.keyframes.sort((a, b) => a.t - b.t);
  emit('keyframes');
  return kf;
}

export function removeKeyframe(id) {
  const i = state.keyframes.findIndex((k) => k.id === id);
  if (i === -1) return;
  state.keyframes.splice(i, 1);
  emit('keyframes');
}

export function clearKeyframes() {
  if (state.keyframes.length === 0) return;
  state.keyframes = [];
  emit('keyframes');
}

// The keyframe sitting at this time, if any (used to light up the ◆ button).
export function keyframeAt(t) {
  return state.keyframes.find((k) => Math.abs(k.t - t) <= KEYFRAME_EPSILON) || null;
}

// Interpolated {zoom, panX, panY} at time t, or null when there are no
// keyframes (caller then uses the static state values). Clamps to the first/
// last keyframe outside the keyframed range (hold, don't extrapolate).
export function keyframeTransformAt(t) {
  const kf = state.keyframes;
  if (kf.length === 0) return null;
  const pick = (k) => ({ zoom: k.zoom, panX: k.panX, panY: k.panY });
  if (t <= kf[0].t) return pick(kf[0]);
  if (t >= kf[kf.length - 1].t) return pick(kf[kf.length - 1]);
  let i = 0;
  while (i < kf.length - 1 && kf[i + 1].t <= t) i++;
  const a = kf[i];
  const b = kf[i + 1];
  const span = b.t - a.t;
  const raw = span > 0 ? (t - a.t) / span : 0;
  const e = raw * raw * (3 - 2 * raw); // smoothstep ease-in-out
  return {
    zoom: a.zoom + (b.zoom - a.zoom) * e,
    panX: a.panX + (b.panX - a.panX) * e,
    panY: a.panY + (b.panY - a.panY) * e,
  };
}

// --- face tracking (auto-reframe) --------------------------------------------

// Turns a scanned face path into the active reframe. samples must be sorted by
// t; x is the face centre (0..1 of source width), z the depth zoom (default 1).
export function setFaceTrack(samples) {
  state.faceTrack = { enabled: true, samples: samples.slice().sort((a, b) => a.t - b.t) };
  emit('facetrack');
}

// Toggle without losing the samples — off cleanly reverts to the plain crop.
export function setFaceTrackEnabled(on) {
  state.faceTrack.enabled = !!on;
  emit('facetrack');
}

export function clearFaceTrack() {
  state.faceTrack = { enabled: false, samples: [] };
  emit('facetrack');
}

export function faceTrackActive() {
  return state.faceTrack.enabled && state.faceTrack.samples.length > 0;
}

// Interpolated { x, z } at source time t (linear; holds the ends). Null when
// tracking is off/empty so callers fall back to the normal render.
export function faceTrackAt(t) {
  const s = state.faceTrack.samples;
  if (!faceTrackActive()) return null;
  if (t <= s[0].t) return { x: s[0].x, z: s[0].z || 1 };
  if (t >= s[s.length - 1].t) return { x: s[s.length - 1].x, z: s[s.length - 1].z || 1 };
  let i = 0;
  while (i < s.length - 1 && s[i + 1].t <= t) i++;
  const a = s[i];
  const b = s[i + 1];
  const span = b.t - a.t || 1e-6;
  const u = (t - a.t) / span;
  return { x: a.x + (b.x - a.x) * u, z: (a.z || 1) + ((b.z || 1) - (a.z || 1)) * u };
}

// Pushes the Captions tab's shared style onto every caption layer at once.
export function applyCaptionStyle() {
  const s = state.captionSettings;
  for (const layer of captionLayers()) {
    Object.assign(layer, {
      style: s.style,
      fontId: s.fontId || defaultFontId(),
      fontSize: s.fontSize,
      color: s.color,
      dropShadow: s.dropShadow,
      yPercent: s.yPercent,
    });
  }
  emit('layers');
}

// Re-times every caption from its original whisper time + the current
// timingOffset. baseStart/baseEnd are the untouched whisper times, so
// dragging the nudge slider back and forth is always relative to those
// (never drifts). Preserves each caption's length.
export function applyCaptionTiming() {
  const offset = state.captionSettings.timingOffset || 0;
  const duration = sourceDuration();
  for (const layer of captionLayers()) {
    if (!Number.isFinite(layer.baseStart)) continue;
    const len = layer.baseEnd - layer.baseStart;
    let start = Math.max(0, layer.baseStart + offset);
    if (duration > 0) start = Math.min(start, Math.max(0, duration - len));
    layer.start = start;
    layer.end = start + len;
  }
  emit('layers');
}

export function defaultFontId() {
  const def = state.fonts.find((f) => f.isDefault && f.available);
  if (def) return def.id;
  const firstAvailable = state.fonts.find((f) => f.available);
  return firstAvailable ? firstAvailable.id : 'montserrat';
}

// --- undo / redo -------------------------------------------------------------------
// Snapshot-based history over the EDIT itself: segments (incl. mode and
// transitions) and text layers. Global sliders and the overlay/sound
// files stay out — File objects can't be serialized, and undoing a zoom
// tweak isn't what anyone reaches for Cmd+Z expecting. Mutations arrive
// through the 'segments'/'layers' events; recording is debounced so a
// continuous drag or a typing burst collapses into one history entry.

const HISTORY_EVENTS = new Set(['segments', 'layers', 'keyframes']);
const HISTORY_LIMIT = 100;
const HISTORY_DEBOUNCE_MS = 350;

let history = [];
let historyIndex = -1;
let restoring = false;
let recordTimer = null;

function historySnapshot() {
  return JSON.stringify({
    segments: state.segments,
    timelineMode: state.timelineMode,
    transitions: state.transitions,
    layers: state.layers,
    keyframes: state.keyframes,
  });
}

// Segment operations (split/delete/trim-release/move-release) are
// discrete — each deserves its own undo step, so they record on the next
// tick (coalescing only same-burst emits). Layer changes include per-
// keystroke text edits, so those debounce into one step per pause.
function scheduleHistoryRecord(event) {
  if (restoring) return;
  clearTimeout(recordTimer);
  const delay = event === 'segments' ? 0 : HISTORY_DEBOUNCE_MS;
  recordTimer = setTimeout(() => {
    const snap = historySnapshot();
    if (history[historyIndex] === snap) return;
    history = history.slice(0, historyIndex + 1);
    history.push(snap);
    if (history.length > HISTORY_LIMIT) history.shift();
    historyIndex = history.length - 1;
    emit('history');
  }, delay);
}

function restoreSnapshot(snap) {
  const data = JSON.parse(snap);
  restoring = true;
  try {
    state.segments = data.segments;
    state.timelineMode = data.timelineMode;
    state.transitions = data.transitions;
    state.layers = data.layers;
    state.keyframes = data.keyframes || [];
    state.sel = null;
    emit('selection');
    emit('segments');
    emit('layers');
    emit('keyframes');
  } finally {
    restoring = false;
  }
  emit('history');
}

export function canUndo() {
  return historyIndex > 0;
}

export function canRedo() {
  return historyIndex < history.length - 1;
}

export function undo() {
  if (!canUndo()) return;
  // A pending (not yet flushed) record would re-add the state being
  // undone the moment the debounce fires — drop it.
  clearTimeout(recordTimer);
  historyIndex -= 1;
  restoreSnapshot(history[historyIndex]);
}

export function redo() {
  if (!canRedo()) return;
  clearTimeout(recordTimer);
  historyIndex += 1;
  restoreSnapshot(history[historyIndex]);
}

// Fresh baseline when a new source loads — no undoing across clips.
export function resetHistory() {
  clearTimeout(recordTimer);
  history = [historySnapshot()];
  historyIndex = 0;
  emit('history');
}
