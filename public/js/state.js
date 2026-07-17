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
  // { kind: 'url'|'file', url, file, previewUrl, duration, width, height }
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

  // Main-clip crop: how much of each source edge to trim, as a % of that axis
  // (0 = no crop). The kept sub-rectangle then fills the frame exactly like an
  // uncropped source would — preview via CSS object-view-box, export via an
  // ffmpeg `crop` before the fill composite (1:1 parity). Global/whole-video,
  // like zoom/pan (mirrored into every piece's settings).
  crop: { top: 0, bottom: 0, left: 0, right: 0 },

  // Main-clip audio. volumePercent 0-200 (100 = untouched, >100 boosts),
  // muted drops it entirely from the render. fadeIn/fadeOut are seconds of
  // afade at the clip's head/tail. Applied in the render's audio graph and,
  // approximately, in preview (HTML media can't boost past 100%).
  audio: { volumePercent: 100, muted: false, fadeIn: 0, fadeOut: 0 },

  // Color adjustment, each -100..100 (0 = neutral). Grades the footage (not
  // captions/overlays). Preview = CSS filter; export = ffmpeg eq. Contrast and
  // saturation map identically both sides; brightness is approximate in preview
  // (CSS multiplies, eq adds).
  color: { brightness: 0, contrast: 0, saturation: 0 },

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
  faceTrack: { enabled: false, zoom: 1, samples: [] },

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
  // Additional video pieces selected via shift-click (B6 multi-select), as
  // { kind:'segment'|'clip', id }. state.sel is the primary; edits to per-piece
  // video settings apply to all of these together.
  selPieces: [],

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

  // Global brand kit (default font/colour + the watermark asset), loaded once
  // from the server at startup. NOT saved per project — it's the same for all.
  brandKit: null,

  // Per-project watermark toggle + placement. Saved with the project; new
  // projects start from the brand kit's defaults (see applyBrandKitToNewProject).
  watermark: { enabled: false, sizePercent: 18, xPercent: 88, yPercent: 90, opacity: 0.7 },

  // The Captions tab's shared settings, applied to every group:'caption'
  // layer at once (like CapCut/TikTok's caption styling, which styles the
  // whole caption track, not one block at a time).
  captionSettings: {
    // Words per caption block (1 = one word at a time, the dominant viral
    // style). We always transcribe word-level and group by this.
    maxWords: 1,
    // Strip trailing , and . from words (keeps ? and !) for cleaner captions.
    punctuationCleanup: true,
    style: 'outline',
    // D1 styling carried across every caption (see applyCaptionStyle).
    strokeWidth: null,
    strokeColor: '#000000',
    uppercase: false,
    // Karaoke emphasis (D2): the word being spoken takes karaokeColor.
    karaoke: false,
    karaokeColor: '#ffe600',
    fontId: null, // null -> default font, resolved at generation time
    fontSize: 58,
    color: '#ffffff',
    dropShadow: false,
    yPercent: 75,
    // Entrance animation for each caption: 'none' | 'fade' | 'slide' (slide-up)
    // | 'wipe' | 'bounce' | 'shake'. Rendered identically in preview (per-frame
    // opacity/translate/clip) and export (overlay fade-alpha + y/x/alpha
    // t-expressions) so they match.
    animation: 'none',
    // Exit animation as each caption LEAVES: 'none' | 'fade' (fade out) | 'slide'
    // (slide down). Applied over exitDuration seconds before the caption's end,
    // matched preview↔export the same way as the entrance.
    exit: 'none',
    exitDuration: 0.35,
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

  // Face-tracked effects (blur a face / cover a face with an emoji/image). Each
  // pins to a face and follows a smoothed box path over the clip. Rendered
  // identically in preview (CSS/canvas from the samples) and export (ffmpeg
  // crop-blur / overlay driven by the SAME samples as piecewise-linear
  // t-expressions). { id, kind:'blur'|'cover', samples:[{t,x,y,w,h,seen}],
  //   start, end (SOURCE seconds), strength, padding (blur),
  //   emoji|imageUrl|imageId, scale, rotation (cover) }
  faceEffects: [],

  // Additional source clips stitched AFTER the primary clip, in order (Phase 6,
  // sequential multi-source). Each is a trimmed [start,end] range of its OWN
  // source. Kept separate from state.segments (the primary clip's pieces) so
  // every single-source code path stays byte-identical when this is empty.
  // { id, source: {kind,url,previewUrl,file,name,path,width,height,duration}, start, end, duration }
  appendedClips: [],

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

// Output length of the PRIMARY clip's timeline (its kept pieces + free-mode
// gaps). Single-source consumers that must NOT see appended clips use this.
export function primaryOutputDuration() {
  return state.segments.reduce((max, seg) => Math.max(max, seg.outStart + (seg.end - seg.start)), 0);
}

// Total output length, including the appended clips stitched after the primary.
// In free mode an appended clip can sit later than the previous piece's end
// (a black gap), so the true length is the last piece's outEnd — not just the
// summed lengths. appendedLayout's clamp-forward keeps the array's last entry
// the furthest-right, so its outEnd is the max.
export function outputDuration() {
  const layout = appendedLayout();
  const appendedEnd = layout.length ? layout[layout.length - 1].outEnd : 0;
  return Math.max(primaryOutputDuration(), appendedEnd);
}

// --- appended clips (sequential multi-source) --------------------------------------

let appendedCounter = 0;

export function appendedClipLength(clip) {
  return Math.max(0, (clip.end ?? clip.duration ?? 0) - (clip.start || 0));
}

export function appendedTotalDuration() {
  return state.appendedClips.reduce((sum, c) => sum + appendedClipLength(c), 0);
}

// Each appended clip's placement on the OUTPUT timeline.
// - Snap mode: they accumulate contiguously right after the primary (clip
//   order = array order), ignoring any stored outStart.
// - Free mode: each clip sits at its own `outStart`, which can leave a black
//   gap after the previous piece. concat can't overlap, so we clamp FORWARD
//   (never before where the previous piece ends); reordering is done by
//   changing the array order (see placeAppendedClip), not by overlap.
// Returns [{ clip, outStart, outEnd }] in array (= output) order.
export function appendedLayout() {
  const free = state.timelineMode === 'free';
  let cursor = primaryOutputDuration();
  return state.appendedClips.map((clip) => {
    const len = appendedClipLength(clip);
    const outStart = free && Number.isFinite(clip.outStart) ? Math.max(cursor, clip.outStart) : cursor;
    cursor = outStart + len;
    return { clip, outStart, outEnd: outStart + len };
  });
}

// The appended clip playing at an output time (or null when the time is inside
// the primary region or a gap between clips).
export function appendedAtOutput(outT) {
  for (const item of appendedLayout()) {
    if (outT >= item.outStart - 0.001 && outT < item.outEnd) return item;
  }
  return null;
}

export function addAppendedClip(source) {
  const clip = {
    id: `clip-${Date.now()}-${appendedCounter++}`,
    source,
    start: 0,
    end: Number.isFinite(source.duration) ? source.duration : 0,
    duration: Number.isFinite(source.duration) ? source.duration : 0,
    // Free-mode output position: a new clip lands contiguously after the
    // existing pieces (its natural end). Snap mode ignores this.
    outStart: primaryOutputDuration() + appendedTotalDuration(),
    // Inherit the current whole-video framing/blur/grade so a stitched clip
    // matches the rest without a manual step (settings are global — see
    // commitVideoSettings).
    settings: cloneSettings(currentVideoSettings()),
  };
  state.appendedClips.push(clip);
  emit('segments'); // the video track + output duration change
  return clip;
}

export function removeAppendedClip(id) {
  const i = state.appendedClips.findIndex((c) => c.id === id);
  if (i === -1) return;
  state.appendedClips.splice(i, 1);
  // Drop any transition anchored to this clip's boundary (C2).
  state.transitions = state.transitions.filter((tr) => tr.afterSegmentId !== id);
  if (isSelected('clip', id)) clearSelection();
  emit('segments');
}

export function updateAppendedClip(id, patch) {
  const clip = state.appendedClips.find((c) => c.id === id);
  if (!clip) return;
  Object.assign(clip, patch);
  emit('segments');
}

export function moveAppendedClip(id, toIndex) {
  const from = state.appendedClips.findIndex((c) => c.id === id);
  if (from === -1) return;
  const [clip] = state.appendedClips.splice(from, 1);
  const dest = Math.max(0, Math.min(state.appendedClips.length, toIndex));
  state.appendedClips.splice(dest, 0, clip);
  emit('segments');
}

// Free-mode drop: set a clip's ORDER (array index, from where it was dropped
// among the others) and its output position in ONE step. outStart can't precede
// the primary; appendedLayout's clamp-forward then resolves any residual overlap
// with the new previous neighbour. Order + position together give "reorder by
// dragging earlier" and "drag later to open a black gap".
export function placeAppendedClip(id, toIndex, outStart) {
  const from = state.appendedClips.findIndex((c) => c.id === id);
  if (from === -1) return;
  const [clip] = state.appendedClips.splice(from, 1);
  const dest = Math.max(0, Math.min(state.appendedClips.length, toIndex));
  state.appendedClips.splice(dest, 0, clip);
  clip.outStart = Math.max(primaryOutputDuration(), outStart);
  emit('segments');
}

// Fill in any missing free-mode positions (old projects, or clips added before
// a position existed) with their contiguous slot, so free mode always has a
// defined outStart to drag from.
function ensureAppendedFreeStarts() {
  let cursor = primaryOutputDuration();
  for (const clip of state.appendedClips) {
    if (!Number.isFinite(clip.outStart)) clip.outStart = cursor;
    cursor = Math.max(cursor, clip.outStart) + appendedClipLength(clip);
  }
}

// Pack appended clips contiguously after the primary (snap mode's invariant).
function packAppendedContiguous() {
  let cursor = primaryOutputDuration();
  for (const clip of state.appendedClips) {
    clip.outStart = cursor;
    cursor += appendedClipLength(clip);
  }
}

export function selectedAppendedClip() {
  return state.sel && state.sel.kind === 'clip'
    ? state.appendedClips.find((c) => c.id === state.sel.id) || null
    : null;
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
  if (mode === 'snap') {
    // Pack both the primary pieces and the appended clips back to contiguous.
    normalizeOutStarts();
    packAppendedContiguous();
  } else {
    // Free mode starts where things visually are (contiguous, coming from
    // snap); only fill positions that don't exist yet.
    ensureAppendedFreeStarts();
  }
  emit('segments');
}

// --- segments ---------------------------------------------------------------

let segmentCounter = 0;

// Per-piece video settings (B6). Each segment/appended clip carries its own
// reframe (zoom/pan), background blur, and colour grade — layout/split, speed,
// mirror, keyframes and face-tracking remain global for now. state.zoom/panX/
// panY/blur/color act as the EDIT MIRROR of the current edit-target piece (so
// the Video-panel code is unchanged); the preview reads each piece's settings
// live at the playhead, and the export builds each piece with its own.
export function defaultPieceSettings() {
  return {
    zoom: 1,
    panX: 0,
    panY: 0,
    blur: 0,
    color: { brightness: 0, contrast: 0, saturation: 0 },
    crop: { top: 0, bottom: 0, left: 0, right: 0 },
  };
}

// Snapshot the global edit-mirror into a settings object (used to seed a new
// piece so a split/append inherits the look you're currently editing).
function currentVideoSettings() {
  return {
    zoom: state.zoom,
    panX: state.panX,
    panY: state.panY,
    blur: state.blur,
    color: { ...(state.color || { brightness: 0, contrast: 0, saturation: 0 }) },
    crop: { ...(state.crop || { top: 0, bottom: 0, left: 0, right: 0 }) },
  };
}

function cloneSettings(s) {
  const d = defaultPieceSettings();
  if (!s) return d;
  return {
    zoom: Number.isFinite(s.zoom) ? s.zoom : d.zoom,
    panX: Number.isFinite(s.panX) ? s.panX : d.panX,
    panY: Number.isFinite(s.panY) ? s.panY : d.panY,
    blur: Number.isFinite(s.blur) ? s.blur : d.blur,
    color: { ...d.color, ...(s.color || {}) },
    crop: { ...d.crop, ...(s.crop || {}) },
  };
}

// Ensures a piece has a valid settings object (older projects / appended clips
// created before B6 won't have one).
export function pieceSettings(piece) {
  if (!piece) return defaultPieceSettings();
  if (!piece.settings) piece.settings = defaultPieceSettings();
  return piece.settings;
}

function newSegment(start, end, outStart, settings) {
  return {
    id: `seg-${Date.now()}-${segmentCounter++}`,
    start,
    end,
    outStart,
    settings: settings || defaultPieceSettings(),
  };
}

// The video piece (primary segment OR appended clip) at an OUTPUT time, as
// { kind:'segment'|'clip', id, piece }. Null in an output gap. (pieceAtOutput
// above is the segment-only version the playback gap logic relies on.)
export function pieceRefAtOutput(outT) {
  for (const seg of state.segments) {
    const len = seg.end - seg.start;
    if (outT >= seg.outStart - 0.001 && outT < seg.outStart + len + 0.001) {
      return { kind: 'segment', id: seg.id, piece: seg };
    }
  }
  for (const item of appendedLayout()) {
    if (outT >= item.outStart - 0.001 && outT < item.outEnd + 0.001) {
      return { kind: 'clip', id: item.clip.id, piece: item.clip };
    }
  }
  return null;
}

// Settings of the piece at an output time (defaults in a gap / before load).
export function pieceSettingsAtOutput(outT) {
  const hit = pieceRefAtOutput(outT);
  return hit ? pieceSettings(hit.piece) : defaultPieceSettings();
}

export function resetSegments() {
  const duration = sourceDuration();
  state.segments = duration > 0 ? [newSegment(0, duration, 0)] : [];
  state.sel = null;
  state.selPieces = [];
  state.transitions = [];
  state.keyframes = [];
  state.faceTrack = { enabled: false, zoom: 1, samples: [] };
  state.audio = { volumePercent: 100, muted: false, fadeIn: 0, fadeOut: 0 };
  // Reset the per-piece edit mirror to defaults; the fresh segment already holds
  // defaultPieceSettings, so mirror and piece agree until a preset auto-applies.
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.blur = 0;
  state.color = { brightness: 0, contrast: 0, saturation: 0 };
  state.appendedClips = []; // a fresh primary clip starts with no stitched clips
  emit('segments');
  emit('keyframes');
  emit('facetrack');
  emit('settings');
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
  // The right half inherits the left half's per-piece settings (a split keeps
  // one clip's look on both sides until you change one).
  const right = newSegment(time, seg.end, seg.outStart + (time - seg.start), cloneSettings(seg.settings));
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

// All video pieces (primary segments + appended clips) in OUTPUT order, each as
// { kind:'segment'|'clip', id, outStart, outEnd }. The single source of truth
// for boundaries — a transition can sit after any piece whose next piece is
// output-touching (segment→segment, segment→clip, or clip→clip).
export function orderedPieces() {
  const segs = state.segments
    .map((s) => ({ kind: 'segment', id: s.id, outStart: s.outStart, outEnd: s.outStart + (s.end - s.start) }))
    .sort((a, b) => a.outStart - b.outStart);
  const clips = appendedLayout().map((it) => ({
    kind: 'clip',
    id: it.clip.id,
    outStart: it.outStart,
    outEnd: it.outEnd,
  }));
  return [...segs, ...clips];
}

// True if the piece at index i in orderedPieces has an output-touching next
// piece (so a transition is meaningful there — it never spans a black gap).
function boundaryTouches(pieces, i) {
  return i >= 0 && i < pieces.length - 1 && pieces[i + 1].outStart - pieces[i].outEnd <= 0.05;
}

// Attaches a flash at the boundary after this piece (segment OR appended clip;
// it must have a following touching piece). One transition per boundary.
export function addTransitionAfter(pieceId, duration, type = 'white-flash') {
  const pieces = orderedPieces();
  const idx = pieces.findIndex((p) => p.id === pieceId);
  if (!boundaryTouches(pieces, idx)) return null;
  state.transitions = state.transitions.filter((tr) => tr.afterSegmentId !== pieceId);
  const tr = {
    id: `tr-${Date.now()}-${transitionCounter++}`,
    afterSegmentId: pieceId, // a piece id (segment or clip) — name kept for compat
    type: type === 'black-flash' ? 'black-flash' : 'white-flash',
    duration,
  };
  state.transitions.push(tr);
  emit('segments');
  return tr;
}

export function removeTransition(id) {
  const before = state.transitions.length;
  state.transitions = state.transitions.filter((tr) => tr.id !== id);
  if (state.transitions.length !== before) {
    // Deleting the selected transition returns to the Project inspector.
    if (state.sel && state.sel.kind === 'transition' && state.sel.id === id) clearSelection();
    emit('segments');
  }
}

// Edit a transition's type/duration in place (from the Transition inspector).
export function updateTransition(id, patch) {
  const tr = state.transitions.find((t) => t.id === id);
  if (!tr) return;
  if (patch.type != null) tr.type = patch.type === 'black-flash' ? 'black-flash' : 'white-flash';
  if (Number.isFinite(patch.duration)) tr.duration = patch.duration;
  emit('segments');
}

export function transitionAfter(segmentId) {
  return state.transitions.find((tr) => tr.afterSegmentId === segmentId) || null;
}

export function selectTransition(id) {
  select('transition', id);
}

export function selectedTransition() {
  return state.sel && state.sel.kind === 'transition'
    ? state.transitions.find((tr) => tr.id === state.sel.id) || null
    : null;
}

// --- selection -------------------------------------------------------------------
// One selection across all clip kinds (only one thing is ever selected).
// isSelected(kind, id) is the highlight check; the typed selectX/selectedX
// wrappers keep call sites readable.

export function select(kind, id) {
  if (id == null) return clearSelection();
  // A plain (non-shift) selection resets any multi-piece set.
  state.selPieces = kind === 'segment' || kind === 'clip' ? [{ kind, id }] : [];
  if (state.sel && state.sel.kind === kind && state.sel.id === id) {
    emit('selection'); // still refresh (selPieces may have changed)
    return;
  }
  state.sel = { kind, id };
  loadEditTargetIntoGlobals();
  emit('selection');
}

// Shift-click a video piece: toggle it in the multi-selection. The last one
// clicked becomes the primary (what the panel reads); its settings load into
// the edit mirror.
export function togglePieceSelection(kind, id) {
  if (kind !== 'segment' && kind !== 'clip') return select(kind, id);
  const i = state.selPieces.findIndex((p) => p.kind === kind && p.id === id);
  if (i === -1) {
    state.selPieces.push({ kind, id });
    state.sel = { kind, id };
  } else {
    state.selPieces.splice(i, 1);
    // Primary falls back to the last still-selected piece (or clears).
    const last = state.selPieces[state.selPieces.length - 1];
    state.sel = last ? { ...last } : null;
  }
  loadEditTargetIntoGlobals();
  emit('selection');
}

export function clearSelection() {
  if (!state.sel && state.selPieces.length === 0) return;
  state.sel = null;
  state.selPieces = [];
  emit('selection');
}

export function isSelected(kind, id) {
  if ((kind === 'segment' || kind === 'clip') && state.selPieces.some((p) => p.kind === kind && p.id === id)) {
    return true;
  }
  return !!state.sel && state.sel.kind === kind && state.sel.id === id;
}

// --- per-piece video settings (B6) ------------------------------------------

function findPiece(kind, id) {
  return kind === 'segment'
    ? state.segments.find((s) => s.id === id)
    : state.appendedClips.find((c) => c.id === id);
}

// The pieces the Video panel edits: the multi-selection if any, else the single
// selected piece, else the piece under the playhead (so there's always a
// target once a clip is loaded).
export function editTargetPieces(playheadOutTime) {
  const refs = state.selPieces.length
    ? state.selPieces
    : state.sel && (state.sel.kind === 'segment' || state.sel.kind === 'clip')
      ? [state.sel]
      : [];
  let pieces = refs.map((r) => findPiece(r.kind, r.id)).filter(Boolean);
  if (pieces.length === 0) {
    const hit = playheadOutTime != null ? pieceRefAtOutput(playheadOutTime) : null;
    if (hit) pieces = [hit.piece];
    else if (state.segments[0]) pieces = [state.segments[0]];
  }
  return pieces;
}

// The piece whose settings fill the panel (the primary of the edit targets).
export function primaryEditPiece(playheadOutTime) {
  return editTargetPieces(playheadOutTime)[0] || null;
}

// Copy the primary edit-target piece's settings into the global edit mirror
// (state.zoom/panX/panY/blur/color) so the unchanged Video-panel code shows
// them. Called when the selection changes.
export function loadEditTargetIntoGlobals(playheadOutTime) {
  const piece = primaryEditPiece(playheadOutTime);
  if (!piece) return;
  const s = pieceSettings(piece);
  state.zoom = s.zoom;
  state.panX = s.panX;
  state.panY = s.panY;
  state.blur = s.blur;
  state.color = { ...s.color };
  state.crop = { ...(s.crop || { top: 0, bottom: 0, left: 0, right: 0 }) };
}

// Write the current global edit-mirror values onto EVERY piece (all segments +
// appended clips), so zoom/position/blur/colour are applied to the whole video
// at once — a split or a stitched-in clip always matches the framing you set,
// with no per-clip step. Called after a Video-panel slider changes; emits
// 'settings' so preview + timeline refresh.
export function commitVideoSettings() {
  const snapshot = currentVideoSettings();
  for (const seg of state.segments) seg.settings = cloneSettings(snapshot);
  for (const clip of state.appendedClips) clip.settings = cloneSettings(snapshot);
  emit('settings');
}

// Project migration: a piece without its own settings (a project saved before
// B6) inherits the project's old global zoom/pan/blur/color, currently sitting
// in the edit mirror. New-format pieces keep their own settings.
export function migrateLegacyPieceSettings() {
  const legacy = currentVideoSettings();
  for (const seg of state.segments) if (!seg.settings) seg.settings = cloneSettings(legacy);
  for (const clip of state.appendedClips) if (!clip.settings) clip.settings = cloneSettings(legacy);
  loadEditTargetIntoGlobals();
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
export function selectClip(id) {
  select('clip', id);
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

// --- face-tracked effects (blur / cover) -----------------------------------------
let faceEffectCounter = 0;
export function selectedFaceEffect() {
  return state.sel && state.sel.kind === 'faceEffect' ? state.faceEffects.find((f) => f.id === state.sel.id) || null : null;
}
export function selectFaceEffect(id) {
  state.sel = { kind: 'faceEffect', id };
  state.selPieces = [];
  emit('selection');
}
export function addFaceEffect(effect, { select = true } = {}) {
  const dur = sourceDuration();
  const fx = {
    id: `fx-${Date.now()}-${faceEffectCounter++}`,
    kind: effect.kind === 'cover' ? 'cover' : 'blur',
    samples: Array.isArray(effect.samples) ? effect.samples : [],
    start: 0,
    end: dur > 0 ? dur : effect.end || 0,
    // blur defaults
    strength: 0.5, // 0..1
    padding: 0.2, // extra region beyond the detected box, as a fraction
    // nudge the region relative to the face box (fraction of face size);
    // e.g. offsetY < 0 lifts it up to catch the forehead/hair.
    offsetX: 0,
    offsetY: 0,
    // cover defaults
    emoji: effect.emoji || null,
    imageUrl: effect.imageUrl || null,
    imageId: effect.imageId || null,
    scale: 1.4, // relative to face box
    rotation: 0, // degrees
    ...effect,
  };
  state.faceEffects.push(fx);
  emit('faceEffects');
  if (select) {
    state.sel = { kind: 'faceEffect', id: fx.id };
    emit('selection');
  }
  return fx;
}
export function updateFaceEffect(id, patch, { history = true } = {}) {
  const fx = state.faceEffects.find((f) => f.id === id);
  if (!fx) return;
  Object.assign(fx, patch);
  emit(history ? 'faceEffects' : 'faceEffects-live');
}
export function removeFaceEffect(id) {
  const idx = state.faceEffects.findIndex((f) => f.id === id);
  if (idx === -1) return;
  state.faceEffects.splice(idx, 1);
  if (isSelected('faceEffect', id)) clearSelection();
  emit('faceEffects');
}

// --- text layers ------------------------------------------------------------------

let layerCounter = 0;

// Per-layer text-box wrap width, as a fraction of the canvas width. The legacy
// fixed value (900/1080 ≈ 0.833) is the default so existing behaviour is
// unchanged; the resizable text box lets each layer set its own between these
// bounds. Preview (maxWidth) and the server (opentype word-wrap) both multiply
// canvas width by this, so they wrap at identical words.
export const TEXT_WRAP_DEFAULT = 900 / 1080;
export const TEXT_WRAP_MIN = 0.15;
export const TEXT_WRAP_MAX = 1;

export function clampWrapWidth(ratio) {
  const r = Number(ratio);
  if (!Number.isFinite(r)) return TEXT_WRAP_DEFAULT;
  return Math.min(TEXT_WRAP_MAX, Math.max(TEXT_WRAP_MIN, r));
}

export function addTextLayer(partial = {}, { select = true } = {}) {
  const layer = {
    id: `layer-${Date.now()}-${layerCounter++}`,
    text: 'New text',
    style: 'outline', // 'outline' | 'plain' | 'box'
    // Brand kit defaults (font/colour) apply to fresh text; captions pass their
    // own fontId/color in `partial`, which wins via the spread below.
    fontId: (state.brandKit && state.brandKit.defaultFontId) || defaultFontId(),
    fontSize: 64,
    color: (state.brandKit && state.brandKit.defaultTextColor) || '#ffffff',
    dropShadow: false,
    // D1 text options. strokeWidth is % of font size (null = follow the style:
    // outline→OUTLINE_THICKNESS, plain/box→0). uppercase/opacity apply to any
    // style. All default to the pre-D1 look so existing captions are unchanged.
    strokeWidth: null,
    strokeColor: '#000000',
    uppercase: false,
    opacity: 1,
    // D1 remainder — all default to the current look. Fractions are of font size.
    shadowDistance: 0.07, // down-right offset magnitude
    shadowBlur: 0.05,
    shadowOpacity: 0.4,
    bgOpacity: 1, // box/pill fill opacity
    bgPadding: 1, // multiplier of the default box padding
    bgRadius: 1, // multiplier of the default corner radius
    letterSpacing: 0, // em (fraction of font size)
    lineHeight: 1, // multiplier of the default line height
    rotation: 0, // degrees
    xPercent: 50,
    yPercent: 25,
    wrapWidth: TEXT_WRAP_DEFAULT,
    animation: 'none', // entrance: 'none'|'fade'|'slide'|'wipe'|'bounce'|'shake'
    exit: 'none', // exit: 'none'|'fade'|'slide'(down)
    exitDuration: 0.35, // seconds the exit runs before `end`
    start: 0,
    end: 3,
    fullDuration: false, // when true, spans the whole project (see syncFullDurationLayers)
    group: null, // 'caption' for Auto captions layers
    ...partial,
  };
  state.layers.push(layer);
  emit('layers');
  if (select) selectLayer(layer.id);
  return layer;
}

// Layers flagged fullDuration stay pinned to the whole project [0, outputDuration].
// Called whenever the timeline changes (clips added/trimmed/deleted) so they
// track the new length. Emits 'layers' only when something actually moved, so
// it can safely ride the 'segments' event without looping.
export function syncFullDurationLayers() {
  const dur = outputDuration();
  let changed = false;
  for (const l of state.layers) {
    if (!l.fullDuration) continue;
    if (l.start !== 0 || Math.abs((l.end || 0) - dur) > 1e-4) {
      l.start = 0;
      l.end = dur;
      changed = true;
    }
  }
  if (changed) emit('layers');
  return changed;
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

// --- audio ------------------------------------------------------------------------

export const VOLUME_MAX = 200;

export function clampVolumePercent(value, fallback = 100) {
  const v = Number(value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(VOLUME_MAX, Math.max(0, Math.round(v)));
}

// Non-negative fade length in seconds (clamped to keep it sane).
export function clampFadeSeconds(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(30, v);
}

// Patch the main-clip audio (volume/mute/fades) and notify the preview + export.
export function setAudio(patch) {
  Object.assign(state.audio, patch);
  emit('settings');
}

export function clampColorValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(-100, Math.round(n)));
}

// Patch the color grade (brightness/contrast/saturation) and notify.
export function setColor(patch) {
  Object.assign(state.color, patch);
  emit('settings');
}

// --- sounds -----------------------------------------------------------------------
// Sounds/overlays are undoable too, but their File objects can't be JSON-
// serialized into a history snapshot. So the snapshot stores everything EXCEPT
// the file, and this registry keeps the File alive by id; restoreSnapshot
// re-links it. The registry is only ever added to (a deleted-then-undone item
// gets its file back), so it's effectively a per-session file cache.
const mediaFiles = new Map();
function linkMediaFile(item) {
  if (item && item.id && item.file instanceof File) mediaFiles.set(item.id, item.file);
  return item;
}

let soundCounter = 0;

export function addSound(partial = {}, { select: doSelect = true } = {}) {
  const sound = {
    id: `sound-${Date.now()}-${soundCounter++}`,
    file: null,
    label: 'Sound',
    url: null,
    volumePercent: 80,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    duck: false, // auto-lower under speech (caption ranges)
    start: 0,
    end: 1,
    offset: 0,
    duration: 1,
    ...partial,
  };
  state.sounds.push(sound);
  linkMediaFile(sound);
  emit('settings');
  emit('media');
  if (doSelect) selectSound(sound.id);
  return sound;
}

export function updateSound(id, patch, { history = true } = {}) {
  const s = state.sounds.find((x) => x.id === id);
  if (!s) return;
  Object.assign(s, patch);
  linkMediaFile(s);
  emit('settings');
  // System-driven corrections (e.g. filling in duration once metadata loads)
  // pass history:false so they don't become their own undo step.
  if (history) emit('media-adjust');
}

export function removeSound(id) {
  const i = state.sounds.findIndex((s) => s.id === id);
  if (i === -1) return;
  state.sounds.splice(i, 1);
  if (isSelected('sound', id)) clearSelection();
  emit('settings');
  emit('media');
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
  linkMediaFile(right);
  emit('settings');
  emit('media');
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
  linkMediaFile(o);
  emit('settings');
  emit('media');
  if (doSelect) selectOverlay(o.id);
  return o;
}

export function updateOverlay(id, patch) {
  const o = state.overlays.find((x) => x.id === id);
  if (!o) return;
  Object.assign(o, patch);
  linkMediaFile(o);
  emit('settings');
  emit('media-adjust');
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

// Same clamp for the MAIN clip's crop object { top,bottom,left,right }, whose
// keys differ from the overlay crop's. Shared by the Clip crop handles so a
// dragged edge can never collapse the kept region.
const MAIN_CROP_OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
export function clampMainCropValue(crop, key, value) {
  const max = Math.min(100, 100 - CROP_MIN_REMAINING - (crop[MAIN_CROP_OPPOSITE[key]] || 0));
  return Math.max(0, Math.min(max, Math.round(value)));
}

// Update the global main-clip crop and push it onto every piece (whole-video,
// like commitVideoSettings). Called by the crop handles on release/drag.
export function setMainCrop(patch) {
  state.crop = { ...(state.crop || { top: 0, bottom: 0, left: 0, right: 0 }), ...patch };
  commitVideoSettings();
}

export function removeOverlay(id) {
  const i = state.overlays.findIndex((o) => o.id === id);
  if (i === -1) return;
  state.overlays.splice(i, 1);
  if (isSelected('overlay', id)) clearSelection();
  emit('settings');
  emit('media');
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
  linkMediaFile(right);
  emit('settings');
  emit('media');
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
// t; x is the face centre (0..1 of source width). Re-scanning keeps the user's
// chosen tracked-shot zoom.
export function setFaceTrack(samples) {
  const zoom = state.faceTrack.zoom || 1;
  state.faceTrack = { enabled: true, zoom, samples: samples.slice().sort((a, b) => a.t - b.t) };
  emit('facetrack');
}

// Toggle without losing the samples — off cleanly reverts to the plain crop.
export function setFaceTrackEnabled(on) {
  state.faceTrack.enabled = !!on;
  emit('facetrack');
}

// How tight the tracked shot is: 1 = the default fill (widest that keeps the
// frame full), up to FACE_ZOOM_MAX for a closer crop. Constant over the clip
// (ffmpeg crop dimensions can't vary per frame), so it's a single setting.
export const FACE_ZOOM_MAX = 3;
export function setFaceTrackZoom(z) {
  state.faceTrack.zoom = Math.max(1, Math.min(FACE_ZOOM_MAX, parseFloat(z) || 1));
  emit('facetrack');
}
export function faceTrackZoom() {
  return state.faceTrack.zoom || 1;
}

export function clearFaceTrack() {
  state.faceTrack = { enabled: false, zoom: 1, samples: [] };
  emit('facetrack');
}

// Puts back a snapshot taken before a (possibly cancelled) selection, so
// cancelling face-select leaves any prior tracking exactly as it was.
export function restoreFaceTrack(snapshot) {
  state.faceTrack =
    snapshot && Array.isArray(snapshot.samples)
      ? { enabled: !!snapshot.enabled, zoom: snapshot.zoom || 1, samples: snapshot.samples }
      : { enabled: false, zoom: 1, samples: [] };
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
      strokeWidth: s.strokeWidth != null ? s.strokeWidth : null,
      strokeColor: s.strokeColor || '#000000',
      uppercase: !!s.uppercase,
      karaoke: !!s.karaoke,
      karaokeColor: s.karaokeColor || '#ffe600',
      yPercent: s.yPercent,
      animation: s.animation || 'none',
      exit: s.exit || 'none',
      exitDuration: Number.isFinite(s.exitDuration) ? s.exitDuration : 0.35,
    });
  }
  emit('layers');
}

// --- copy / paste style (visual props only — never content/timing/position) ---
// One in-session clipboard, tagged by kind so Paste only applies to the same
// type. Text-layer style, the caption GROUP look, and a clip's video settings.
const TEXT_STYLE_KEYS = [
  'style', 'fontId', 'fontSize', 'color', 'dropShadow', 'strokeWidth', 'strokeColor',
  'uppercase', 'opacity', 'rotation', 'letterSpacing', 'lineHeight',
  'shadowDistance', 'shadowBlur', 'shadowOpacity', 'bgOpacity', 'bgPadding', 'bgRadius',
  'wrapWidth', 'animation', 'exit', 'exitDuration', 'karaoke', 'karaokeColor',
];
const CAPTION_STYLE_KEYS = [
  'style', 'fontId', 'fontSize', 'color', 'dropShadow', 'strokeWidth', 'strokeColor',
  'uppercase', 'yPercent', 'animation', 'exit', 'exitDuration', 'karaoke', 'karaokeColor',
];
const CLIP_STYLE_KEYS = ['zoom', 'panX', 'panY', 'blur', 'speed', 'mirror', 'layout'];

let styleClipboard = null; // { kind: 'text' | 'caption' | 'clip', style: {...} }

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// What kind of style would Copy grab / Paste apply for a given selection? Drives
// the context-menu / overflow-menu enablement.
export function styleKindForSelection() {
  const sel = state.sel;
  if (!sel) return null;
  if (sel.kind === 'segment' || sel.kind === 'clip') return 'clip';
  if (sel.kind === 'layer') {
    const l = state.layers.find((x) => x.id === sel.id);
    return l ? (l.group === 'caption' ? 'caption' : 'text') : null;
  }
  return null;
}

export function canPasteStyle() {
  return !!styleClipboard && styleClipboard.kind === styleKindForSelection();
}

// Copy the current selection's style into the clipboard.
export function copyStyle() {
  const kind = styleKindForSelection();
  if (kind === 'clip') {
    styleClipboard = {
      kind,
      style: { ...pick(state, CLIP_STYLE_KEYS), color: { ...state.color }, split: JSON.parse(JSON.stringify(state.split || {})) },
    };
  } else if (kind === 'caption') {
    styleClipboard = { kind, style: pick(state.captionSettings, CAPTION_STYLE_KEYS) };
  } else if (kind === 'text') {
    const l = selectedLayer();
    if (l) styleClipboard = { kind, style: pick(l, TEXT_STYLE_KEYS) };
  }
  return styleClipboard;
}

// Paste the clipboard onto the current selection (all same-type pieces/layers on
// multi-select). No-op if the clipboard kind doesn't match.
export function pasteStyle() {
  if (!canPasteStyle()) return;
  const { kind, style } = styleClipboard;
  if (kind === 'clip') {
    Object.assign(state, pick(style, CLIP_STYLE_KEYS));
    if (style.color) state.color = { ...style.color };
    if (style.split) state.split = JSON.parse(JSON.stringify(style.split));
    commitVideoSettings(); // writes to every piece + emits 'settings'
  } else if (kind === 'caption') {
    Object.assign(state.captionSettings, style);
    applyCaptionStyle(); // pushes onto every caption layer + emits 'layers'
  } else if (kind === 'text') {
    // Apply to the whole multi-selection if any, else the single selected layer.
    const ids = state.selPieces.length
      ? [] // pieces aren't text; ignore
      : state.sel && state.sel.kind === 'layer'
        ? [state.sel.id]
        : [];
    for (const id of ids) {
      const l = state.layers.find((x) => x.id === id);
      if (l) Object.assign(l, style);
    }
    emit('layers');
  }
}

// --- brand kit ---------------------------------------------------------------
export function setBrandKit(kit) {
  state.brandKit = kit || null;
}

// New projects start from the brand kit's watermark defaults (including whether
// it's on by default). Called whenever a fresh project begins.
export function applyBrandKitToNewProject() {
  const wm = (state.brandKit && state.brandKit.watermark) || {};
  state.watermark = {
    enabled: !!(wm.onByDefault && wm.image),
    sizePercent: Number.isFinite(wm.sizePercent) ? wm.sizePercent : 18,
    xPercent: Number.isFinite(wm.xPercent) ? wm.xPercent : 88,
    yPercent: Number.isFinite(wm.yPercent) ? wm.yPercent : 90,
    opacity: Number.isFinite(wm.opacity) ? wm.opacity : 0.7,
  };
  emit('settings');
}

export function setWatermark(patch) {
  Object.assign(state.watermark, patch);
  emit('settings');
}

// Duplicate a text/caption layer (⌘D, the Duplicate button, the context menu).
// The copy is nudged down slightly and auto-selected.
export function duplicateLayer(id) {
  const layer = state.layers.find((l) => l.id === id);
  if (!layer) return null;
  const copy = { ...layer };
  delete copy.id;
  copy.yPercent = Math.min(100, (copy.yPercent || 50) + 8);
  return addTextLayer(copy);
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

const HISTORY_EVENTS = new Set(['segments', 'layers', 'keyframes', 'media', 'media-adjust', 'faceEffects']);
// Structural edits (splits, deletes, adds) each deserve their own step, so
// they record on the next tick; continuous edits (typing, dragging a slider)
// debounce into one step per pause. Face-effect control tweaks debounce; adds/
// deletes come through the same 'faceEffects' event and still coalesce sanely.
const IMMEDIATE_HISTORY = new Set(['segments', 'media']);
const HISTORY_LIMIT = 100;
const HISTORY_DEBOUNCE_MS = 350;

let history = [];
let historyIndex = -1;
let restoring = false;
let recordTimer = null;

// Sounds/overlays are snapshot with their File stripped (not serializable);
// mediaFiles re-links it on restore.
function stripFile(item) {
  const { file, ...rest } = item;
  return rest;
}
function historySnapshot() {
  return JSON.stringify({
    segments: state.segments,
    timelineMode: state.timelineMode,
    transitions: state.transitions,
    layers: state.layers,
    keyframes: state.keyframes,
    sounds: state.sounds.map(stripFile),
    overlays: state.overlays.map(stripFile),
    faceEffects: state.faceEffects,
  });
}

// Segment operations (split/delete/trim-release/move-release) are
// discrete — each deserves its own undo step, so they record on the next
// tick (coalescing only same-burst emits). Layer changes include per-
// keystroke text edits, so those debounce into one step per pause.
function scheduleHistoryRecord(event) {
  if (restoring) return;
  clearTimeout(recordTimer);
  const delay = IMMEDIATE_HISTORY.has(event) ? 0 : HISTORY_DEBOUNCE_MS;
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
    // Re-link each sound/overlay's File from the registry (stripped from the
    // snapshot). A restored deletion thus comes back fully wired for export.
    const relink = (item) => ({ ...item, file: mediaFiles.get(item.id) || null });
    state.sounds = (data.sounds || []).map(relink);
    state.overlays = (data.overlays || []).map(relink);
    state.faceEffects = data.faceEffects || [];
    state.sel = null;
    emit('selection');
    emit('segments');
    emit('layers');
    emit('keyframes');
    emit('faceEffects');
    emit('settings'); // re-render sounds/overlays
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
