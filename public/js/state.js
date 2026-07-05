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

  // Canvas / global video settings
  aspect: { id: '9:16', width: 1080, height: 1920 },
  zoom: 1.35,
  blur: 20,
  speed: 1,
  mirror: false,

  // The KEPT pieces of the source — source-ordered, non-overlapping in
  // both domains. { id, start, end, outStart }: start/end are the source
  // in/out points (trim handles pull them back out over cut footage —
  // nothing is ever destroyed), outStart is the piece's position on the
  // output timeline.
  segments: [],
  selectedSegmentId: null,

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
  selectedId: null,

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
  },

  // Optional extras
  // Media overlay as a timeline clip (its own row): start/end are SOURCE
  // seconds (like text layers — when it's on screen), crop* are 0-45%
  // trimmed off each edge of the media itself, and it renders ABOVE the
  // video in the preview. A video overlay plays/pauses in sync with the
  // editor while inside its range.
  // { file, isVideo, sizePercent, xPercent, yPercent, cropTop, cropBottom,
  //   cropLeft, cropRight, start, end }
  overlay: null,
  // Sound effect as a timeline clip: start is SOURCE seconds (it rides
  // the footage like text layers do), duration comes from the file.
  sfx: null, // { file, label, url, volumePercent, start, duration }

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
  state.selectedSegmentId = null;
  state.transitions = [];
  emit('segments');
}

export function selectedSegment() {
  return state.segments.find((s) => s.id === state.selectedSegmentId) || null;
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
  if (state.selectedSegmentId === id) {
    state.selectedSegmentId = null;
    emit('selection');
  }
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

export function selectedLayer() {
  return state.layers.find((l) => l.id === state.selectedId) || null;
}

// Layer and segment selection are one shared concept (like any editor's
// single selection): picking one always clears the other, and
// selectLayer(null) deselects everything.
export function selectLayer(id) {
  if (state.selectedId === id && state.selectedSegmentId === null) return;
  state.selectedId = id;
  state.selectedSegmentId = null;
  emit('selection');
}

export function selectSegment(id) {
  if (state.selectedSegmentId === id && state.selectedId === null) return;
  state.selectedSegmentId = id;
  state.selectedId = null;
  emit('selection');
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
  if (state.selectedId === id) {
    state.selectedId = null;
    emit('selection');
  }
  emit('layers');
}

export function captionLayers() {
  return state.layers.filter((l) => l.group === 'caption');
}

export function removeCaptionLayers() {
  if (captionLayers().length === 0) return;
  if (state.layers.find((l) => l.id === state.selectedId && l.group === 'caption')) {
    state.selectedId = null;
    emit('selection');
  }
  state.layers = state.layers.filter((l) => l.group !== 'caption');
  emit('layers');
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

const HISTORY_EVENTS = new Set(['segments', 'layers']);
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
    state.selectedSegmentId = null;
    state.selectedId = null;
    emit('selection');
    emit('segments');
    emit('layers');
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
