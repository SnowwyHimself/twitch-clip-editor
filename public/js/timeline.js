// CapCut-style bottom timeline, one dedicated row per element type:
//
//   ruler      — click/drag to scrub
//   Video      — the clip pieces (per-edge trim handles, move, split,
//                delete, transition badges at boundaries)
//   Captions   — all auto-caption blocks share one row
//   Text       — all hand-made text layers share one row
//   Sound      — the sound-effect clip
//
// The axis is OUTPUT time, but the pixel scale is pinned to the LONGER of
// source/output duration — so trimming or deleting never rescales the
// track under the cursor; content just gets shorter and leaves empty
// track on the right. Every piece carries its own outStart:
//   snap mode — pieces always close up (deletes ripple, moves snap back)
//   free mode — pieces sit wherever they're dropped; gaps play as black
// Trims are non-destructive in both modes: a piece's handles can always
// be dragged back out over cut footage, because start/end are just
// pointers into the untouched source.
//
// Drags never rebuild DOM mid-gesture (that would break pointer capture) —
// they mutate state and call layout functions that restyle the existing
// elements in place; the full rebuild runs once on release via the normal
// 'segments'/'layers' events.

import {
  state,
  on,
  emit,
  isSelected,
  removeKeyframe,
  selectLayer,
  selectSegment,
  clearSelection,
  selectSound,
  selectOverlay,
  togglePieceSelection,
  selectedLayer,
  selectedSegment,
  selectedSound,
  selectedOverlay,
  removeLayer,
  removeSegment,
  removeSound,
  removeOverlay,
  splitSegmentAt,
  splitLayerAt,
  splitSoundAt,
  splitOverlayAt,
  normalizeOutStarts,
  addTransitionAfter,
  selectTransition,
  sourceDuration,
  outputDuration,
  primaryOutputDuration,
  appendedLayout,
  orderedPieces,
  selectClip,
  selectedAppendedClip,
  removeAppendedClip,
  moveAppendedClip,
  placeAppendedClip,
  appendedClipLength,
  updateAppendedClip,
  sourceToOutput,
  outputToSource,
  setAudio,
  MIN_SEGMENT_SECONDS,
  MIN_LAYER_SECONDS,
} from './state.js';
import { seek, seekOutput, getCurrentTime, getCurrentOutputTime } from './preview.js';
import { getPeaks, drawWaveform } from './waveform.js';
import { getFilmstrip, drawFilmstrip } from './filmstrip.js';
import { icon } from './icons.js';
import { openStyleMenu } from './panel.js';

// Paints a filmstrip (video-frame thumbnails) behind a video-track bar's label,
// showing the [offsetSec, offsetSec+lenSec] slice it plays. Cached per URL, so
// cheap to re-call on relayout/zoom; skipped silently if frames can't be read.
function paintFilmstrip(el, url, offsetSec, lenSec) {
  if (!url) return;
  let canvas = el.querySelector('canvas.tl-filmstrip');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'tl-filmstrip';
    el.insertBefore(canvas, el.firstChild);
  }
  getFilmstrip(url).then((data) => {
    if (!data) {
      canvas.remove();
      return;
    }
    drawFilmstrip(canvas, data, offsetSec, lenSec);
  });
}

// Paints (or refreshes) a clip's waveform: a canvas behind the bar's label
// showing the [offsetSec, offsetSec+lenSec] slice of its audio. Peaks are
// cached per URL, so this is cheap to call on every relayout/zoom. Silently
// does nothing when the URL can't be decoded (e.g. a video with no audio).
function paintWaveform(el, url, offsetSec, lenSec) {
  if (!url) return;
  let canvas = el.querySelector('canvas.tl-waveform');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'tl-waveform';
    el.insertBefore(canvas, el.firstChild);
  }
  getPeaks(url).then((data) => {
    if (!data) {
      canvas.remove();
      return;
    }
    drawWaveform(canvas, data, offsetSec, lenSec, 'rgba(255,255,255,0.5)');
  });
}

const ruler = document.getElementById('tl-ruler');
const keyframeRow = document.getElementById('tl-keyframe-row');
const keyframeLabel = document.getElementById('tl-kf-label');
const videoTrack = document.getElementById('tl-video-track');
const overlayRow = document.getElementById('tl-overlay-row');
const captionsRow = document.getElementById('tl-captions-row');
const textRow = document.getElementById('tl-text-row');
const soundRow = document.getElementById('tl-sound-row');
const playhead = document.getElementById('tl-playhead');
const emptyMsg = document.getElementById('tl-empty');
const tlBody = document.getElementById('tl-body');

// Selectable elements on the timeline — a pointerdown anywhere that ISN'T one
// of these clears the selection (click-away deselect).
const SELECTABLE_SELECTOR =
  '.tl-segment, .tl-seg-edge, .tl-text-bar, .tl-sound-bar, .tl-overlay-bar, .tl-appended-clip, .tl-kf-marker, .tl-transition-badge';
const splitBtn = document.getElementById('tl-split');
const deleteBtn = document.getElementById('tl-delete');
const tlGrid = document.getElementById('tl-grid');
const zoomInBtn = document.getElementById('tl-zoom-in');
const zoomOutBtn = document.getElementById('tl-zoom-out');
const zoomLabel = document.getElementById('tl-zoom-label');
const zoomSlider = document.getElementById('tl-zoom-slider');
const fitBtn = document.getElementById('tl-zoom-fit');

const MOVE_THRESHOLD_PX = 4; // press-and-hold under this = click/select, over = drag

// Timeline zoom: 1 = whole clip fits the width; >1 widens the tracks (the body
// scrolls) so caption blocks / keyframes are easier to grab. The track column
// is stretched to fitWidth×zoom; pxPerSecond derives from the ruler's own width
// so everything (ruler, clips, keyframes, playhead) stays in sync.
const TL_ZOOM_MIN = 1;
const TL_ZOOM_MAX = 10;
const ZOOM_STEP_FACTOR = 1.6; // per +/- button or key press
let tlZoom = 1;

const prefersReducedMotion =
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function clampZoom(z) {
  return Math.min(TL_ZOOM_MAX, Math.max(TL_ZOOM_MIN, Number.isFinite(z) ? z : 1));
}

function fitTrackWidth() {
  // Visible width available to the track column (body minus the label gutter).
  return Math.max(120, tlBody.clientWidth - 64 - 8);
}

// Applies the current zoom: sizes the grid, syncs the slider/label/buttons, then
// RE-LAYOUT (not a full DOM rebuild) so repeated zoom frames stay cheap. The
// ruler re-renders because its tick density adapts to zoom.
function applyTimelineZoom() {
  if (tlZoom <= 1) {
    tlGrid.style.width = '';
  } else {
    tlGrid.style.width = `${Math.round(64 + 8 + fitTrackWidth() * tlZoom)}px`;
  }
  zoomLabel.textContent = `${Math.round(tlZoom * 100)}%`;
  if (zoomSlider) {
    if (document.activeElement !== zoomSlider) zoomSlider.value = tlZoom.toFixed(2);
    const pct = ((tlZoom - TL_ZOOM_MIN) / (TL_ZOOM_MAX - TL_ZOOM_MIN)) * 100;
    zoomSlider.style.setProperty('--fill', `${pct.toFixed(1)}%`);
  }
  zoomOutBtn.disabled = tlZoom <= TL_ZOOM_MIN + 1e-3;
  zoomInBtn.disabled = tlZoom >= TL_ZOOM_MAX - 1e-3;
  if (fitBtn) fitBtn.disabled = tlZoom <= TL_ZOOM_MIN + 1e-3;
  renderRuler();
  layoutAll();
}

// Zoom to `next`, keeping `anchorOutTime` pinned under the same on-screen
// position (so the timeline grows/shrinks *around* the playhead or the mouse,
// not the left edge). trackOriginX() is the single content-origin; outTimeToX
// rescales with the new pxPerSecond after applyTimelineZoom relays out the grid.
// The final scroll is clamped so the anchor math can never leave a left gap.
function zoomTo(next, anchorOutTime) {
  next = clampZoom(next);
  if (Math.abs(next - tlZoom) < 1e-4) return;
  recomputeOrigin();
  const anchorContentBefore = trackOriginX() + outTimeToX(anchorOutTime);
  const viewportX = anchorContentBefore - tlBody.scrollLeft;
  tlZoom = next;
  applyTimelineZoom(); // relays out + recomputes the origin
  const anchorContentAfter = trackOriginX() + outTimeToX(anchorOutTime);
  const maxScroll = Math.max(0, tlBody.scrollWidth - tlBody.clientWidth);
  tlBody.scrollLeft = Math.min(maxScroll, Math.max(0, anchorContentAfter - viewportX));
}

// Smooth (~120ms) zoom for discrete triggers — +/- buttons, keys, Fit. Wheel
// and slider drags call zoomTo directly since they're already continuous.
let zoomRaf = null;
let zoomFallback = null;
function animateZoomTo(target, anchorOutTime) {
  target = clampZoom(target);
  if (zoomRaf) cancelAnimationFrame(zoomRaf);
  if (zoomFallback) clearTimeout(zoomFallback);
  if (prefersReducedMotion) {
    zoomTo(target, anchorOutTime);
    return;
  }
  const from = tlZoom;
  if (Math.abs(target - from) < 1e-4) return;
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / 120);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    zoomTo(from + (target - from) * eased, anchorOutTime);
    zoomRaf = p < 1 ? requestAnimationFrame(tick) : null;
  };
  zoomRaf = requestAnimationFrame(tick);
  // Safety net: if rAF is throttled (e.g. a backgrounded window), still land
  // exactly on target so zoom never stalls part-way.
  zoomFallback = setTimeout(() => {
    if (zoomRaf) {
      cancelAnimationFrame(zoomRaf);
      zoomRaf = null;
    }
    zoomTo(target, anchorOutTime);
  }, 160);
}

function stepZoom(dir) {
  animateZoomTo(tlZoom * (dir > 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR), getCurrentOutputTime());
}

// Fit the whole project into the viewport (zoom 1) and scroll to the start.
function fitZoom() {
  animateZoomTo(TL_ZOOM_MIN, 0);
  tlBody.scrollLeft = 0;
}

function trackWidth() {
  return ruler.clientWidth || 1;
}

// ── Single source of truth for time↔pixel ────────────────────────────────────
// The whole timeline maps time→x through exactly these. The ruler and every
// track share the SAME grid content column, so one scale (pxPerSecond) and one
// origin (trackOriginX) govern ticks, clip bars, keyframes AND the playhead —
// nothing can drift apart, which is the failure mode behind the "left gap on
// zoom". Track/ruler-cell children use outTimeToX(t) (their cell left IS x=0);
// elements that live in .tl-body directly (the playhead) add trackOriginX().
//
// Pinned scale: source duration normally, stretched only if free-mode gaps push
// the output past it. Constant while trimming/deleting, so the track never
// rescales mid-drag.
function pxPerSecond() {
  const span = Math.max(sourceDuration(), outputDuration());
  return span > 0 ? trackWidth() / span : 0;
}

function outTimeToX(t) {
  return t * pxPerSecond();
}

// x of t=0 in .tl-body scroll-content space. Measured off the REAL track cell
// (not a hand-computed label+gap constant), so padding / positioning changes
// can't desync the playhead from the bars. Cached because updatePlayhead runs
// per animation frame; refreshed by recomputeOrigin() on every relayout/zoom/
// resize — the only times it can actually change (it's scroll-independent).
let trackOriginXCache = 0;
function recomputeOrigin() {
  const b = tlBody.getBoundingClientRect();
  const v = videoTrack.getBoundingClientRect();
  trackOriginXCache = v.left - b.left + tlBody.scrollLeft;
}
function trackOriginX() {
  return trackOriginXCache;
}

function xToOutTime(clientX) {
  const rect = ruler.getBoundingClientRect();
  const pps = pxPerSecond();
  return pps > 0 ? Math.max(0, (clientX - rect.left) / pps) : 0;
}

function formatTick(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}:${String(Math.floor(secs)).padStart(2, '0')}` : `${Math.round(secs * 10) / 10}s`;
}

// --- ruler -----------------------------------------------------------------

function renderRuler() {
  ruler.innerHTML = '';
  const span = Math.max(sourceDuration(), outputDuration());
  if (span <= 0) return;

  // Tick density adapts to the current zoom: pick the smallest "nice" step whose
  // on-screen spacing is at least TARGET_PX, so labels never crowd (zoomed out →
  // 5s/10s/30s steps; zoomed in → 1s/0.5s).
  const pps = pxPerSecond();
  const TARGET_PX = 84;
  const niceSteps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = niceSteps.find((s) => s * pps >= TARGET_PX) || niceSteps[niceSteps.length - 1];

  for (let t = 0; t <= span + 1e-6; t += step) {
    const tick = document.createElement('div');
    tick.className = 'tl-tick';
    tick.style.left = `${outTimeToX(t)}px`;
    tick.textContent = formatTick(t);
    ruler.appendChild(tick);
  }
}

// --- shared in-place layout ---------------------------------------------------

const segmentEls = new Map(); // seg.id -> element
const layerBarEls = new Map(); // layer.id -> element
const soundBarEls = new Map(); // sound.id -> element
const overlayBarEls = new Map(); // overlay.id -> element
const appendedClipEls = new Map(); // appended clip.id -> element

// Positions any start/end clip bar (layer/sound/overlay) in output coords.
function layoutClipBar(el, clip) {
  const dispStart = sourceToOutput(clip.start);
  const dispEnd = sourceToOutput(clip.end);
  el.style.left = `${outTimeToX(dispStart)}px`;
  el.style.width = `${Math.max(6, outTimeToX(dispEnd) - outTimeToX(dispStart))}px`;
  return dispEnd - dispStart;
}

// A small gap between adjacent pieces (px) so each rounded clip reads as its own
// block instead of merging into one bar. Left edges stay at the true time; only
// the width is trimmed, so timing/alignment is essentially unchanged.
const PIECE_GAP_PX = 3;

function layoutVideoTrack() {
  const pps = pxPerSecond();
  const srcUrl = state.source && state.source.previewUrl;
  for (const seg of state.segments) {
    const el = segmentEls.get(seg.id);
    if (!el) continue;
    el.style.left = `${seg.outStart * pps}px`;
    el.style.width = `${Math.max(6, (seg.end - seg.start) * pps - PIECE_GAP_PX)}px`;
    // Video-frame thumbnails for this piece's [start,end] slice.
    paintFilmstrip(el, srcUrl, seg.start, seg.end - seg.start);
  }
  for (const item of appendedLayout()) {
    const el = appendedClipEls.get(item.clip.id);
    if (!el) continue;
    el.style.left = `${item.outStart * pps}px`;
    el.style.width = `${Math.max(6, (item.outEnd - item.outStart) * pps - PIECE_GAP_PX)}px`;
    paintFilmstrip(el, item.clip.source.previewUrl, item.clip.start, item.outEnd - item.outStart);
  }
  layoutTransitionBadges();
}

// Appended-clip bar interaction. Click selects it; a horizontal drag either
// reorders it (snap mode — pieces re-pack contiguously) or drops it at a free
// position (free mode — Snap off — opening black gaps), both by its drop centre.
// Trim handles come with the edge grips added in buildClipBar-style later.
function attachAppendedClipDrag(el, clip) {
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (e.shiftKey) {
      togglePieceSelection('clip', clip.id);
      return;
    }
    // selectClip re-renders the video track (innerHTML=''), DETACHING `el`
    // mid-gesture — the same bug that broke text bars. So the drag can't depend
    // on `el` (or pointer capture on it) surviving: listen on window, keep drag
    // state in closures, and look the freshly-rendered bar up by id each frame.
    selectClip(clip.id);
    const item = appendedLayout().find((it) => it.clip.id === clip.id);
    if (item) {
      const outT = getCurrentOutputTime();
      if (outT < item.outStart || outT >= item.outEnd) seekOutput(item.outStart + 0.001);
    }
    const startX = e.clientX;
    const startLeft = item ? item.outStart * pxPerSecond() : 0; // from state — survives re-render
    let moved = false;
    const liveEl = () => appendedClipEls.get(clip.id);

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) <= MOVE_THRESHOLD_PX) return;
      moved = true;
      const cur = liveEl();
      if (cur) {
        cur.classList.add('dragging');
        cur.style.transform = `translateX(${dx}px)`;
      }
    };
    const onUp = (upEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const cur = liveEl();
      if (cur) {
        cur.classList.remove('dragging');
        cur.style.transform = '';
      }
      if (!moved) return;
      const pps = pxPerSecond();
      const dropOut = (startLeft + (upEvent.clientX - startX)) / (pps || 1);
      const len = appendedClipLength(clip);
      // Insertion index = how many OTHER appended clips have their centre before
      // this clip's dropped centre (their current on-track positions).
      const centerOut = dropOut + len / 2;
      const others = appendedLayout().filter((it) => it.clip.id !== clip.id);
      let idx = 0;
      for (const it of others) {
        if (centerOut > (it.outStart + it.outEnd) / 2) idx += 1;
        else break;
      }
      if (state.timelineMode === 'free') {
        // Free mode: keep the exact drop position (opens black gaps) AND the new
        // order in one commit.
        placeAppendedClip(clip.id, idx, Math.max(0, dropOut));
      } else {
        // Snap mode: order only — pieces re-pack contiguously.
        moveAppendedClip(clip.id, idx);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectClip(clip.id);
    openStyleMenu(e.clientX, e.clientY);
  });
}

// Edge-trim an appended clip: the left grip moves its in-point (start), the
// right grip its out-point (end), within [0, source duration]. Mutated live +
// relaid out without a DOM rebuild (so capture holds), committed on release.
function attachAppendedClipTrim(edge, clip, isLeft) {
  let startX = 0;
  let dragging = false;
  let orig = null;
  edge.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    selectClip(clip.id);
    startX = e.clientX;
    dragging = true;
    orig = { start: clip.start, end: clip.end, duration: clip.duration };
    try {
      edge.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers */
    }
  });
  edge.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const pps = pxPerSecond();
    if (pps <= 0) return;
    const delta = (e.clientX - startX) / pps;
    if (isLeft) {
      clip.start = Math.max(0, Math.min(orig.start + delta, clip.end - MIN_SEGMENT_SECONDS));
    } else {
      clip.end = Math.max(clip.start + MIN_SEGMENT_SECONDS, Math.min(orig.end + delta, orig.duration));
    }
    layoutVideoTrack();
    updatePlayhead();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    emit('segments'); // finalize (history + full re-render)
  };
  edge.addEventListener('pointerup', end);
  edge.addEventListener('pointercancel', end);
}

function layoutTransitionBadges() {
  const pps = pxPerSecond();
  const pieces = orderedPieces();
  videoTrack.querySelectorAll('.tl-transition-badge').forEach((badge) => {
    const piece = pieces.find((p) => p.id === badge.dataset.after);
    if (piece) badge.style.left = `${piece.outEnd * pps}px`;
  });
}

function layoutLayerBars() {
  for (const layer of state.layers) {
    const el = layerBarEls.get(layer.id);
    if (!el) continue;
    // A layer whose footage is entirely cut collapses to a sliver — mark
    // it so the user can see it won't be in the export.
    el.classList.toggle('ghost', layoutClipBar(el, layer) < 0.05);
  }
}

function layoutSoundBars() {
  const pps = pxPerSecond();
  for (const s of state.sounds) {
    const el = soundBarEls.get(s.id);
    if (!el) continue;
    layoutClipBar(el, s);
    paintWaveform(el, s.url, s.offset || 0, s.end - s.start);
    layoutFadeRamps(el, s, pps);
  }
}

// Draws the fade in/out as triangular envelope ramps at each end of a clip bar
// (the standard DAW look), sized to the fade seconds. Clamped so the two ramps
// never exceed the bar. Updates live because the sound row re-lays out on every
// 'settings' emit (the fade sliders fire it).
function layoutFadeRamps(el, clip, pps) {
  const barPx = parseFloat(el.style.width) || 0;
  const room = Math.max(0, barPx - 4);
  const inPx = Math.max(0, Math.min(room, (clip.fadeIn || 0) * pps));
  const outPx = Math.max(0, Math.min(room - inPx, (clip.fadeOut || 0) * pps));
  let fin = el.querySelector('.tl-fade-in');
  let fout = el.querySelector('.tl-fade-out');
  if (!fin) {
    fin = document.createElement('div');
    fin.className = 'tl-fade tl-fade-in';
    el.appendChild(fin);
  }
  if (!fout) {
    fout = document.createElement('div');
    fout.className = 'tl-fade tl-fade-out';
    el.appendChild(fout);
  }
  fin.style.width = `${inPx}px`;
  fin.style.display = inPx > 0.5 ? 'block' : 'none';
  fout.style.width = `${outPx}px`;
  fout.style.display = outPx > 0.5 ? 'block' : 'none';
}

function layoutOverlayBars() {
  for (const o of state.overlays) {
    const el = overlayBarEls.get(o.id);
    if (el) layoutClipBar(el, o);
  }
}

function layoutAll() {
  recomputeOrigin(); // refresh the single origin before anything positions to it
  layoutVideoTrack();
  layoutLayerBars();
  layoutSoundBars();
  layoutOverlayBars();
  layoutKeyframeMarkers();
  updatePlayhead();
}

// Keyframe diamonds sit in their own thin row directly above the video track,
// one per zoom/position keyframe, at the keyframe's time. Same ◆ used on the
// Video tab's keyframe button. Clicking one jumps the playhead to it.
function renderKeyframeRow() {
  const has = sourceDuration() > 0 && state.keyframes.length > 0;
  keyframeRow.classList.toggle('hidden', !has);
  keyframeLabel.classList.toggle('hidden', !has);
  keyframeRow.innerHTML = '';
  if (!has) return;
  for (const kf of state.keyframes) {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'tl-kf-marker';
    marker.dataset.t = kf.t;
    marker.innerHTML = icon('diamond', 12);
    marker.title = `Keyframe @ ${kf.t.toFixed(2)}s — click to jump, drag to move, double-click to delete`;
    attachKeyframeMarkerDrag(marker, kf);
    keyframeRow.appendChild(marker);
  }
  layoutKeyframeMarkers();
}

// Click jumps to the keyframe; a horizontal drag retimes it; double-click
// deletes it. During the drag we mutate the keyframe's time and nudge the
// preview via 'settings' WITHOUT re-rendering the row (which would drop the
// element we're capturing), then commit once on release via 'keyframes' so it
// lands as a single undo step.
function attachKeyframeMarkerDrag(marker, kf) {
  let startX = 0;
  let dragging = false;
  let moved = false;

  marker.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    startX = e.clientX;
    dragging = true;
    moved = false;
    try {
      marker.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers */
    }
  });
  marker.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (!moved && Math.abs(e.clientX - startX) <= MOVE_THRESHOLD_PX) return;
    moved = true;
    const pps = pxPerSecond();
    if (pps <= 0) return;
    const rect = ruler.getBoundingClientRect();
    const t = Math.max(0, Math.min(sourceDuration(), (e.clientX - rect.left) / pps));
    kf.t = t;
    state.keyframes.sort((a, b) => a.t - b.t);
    marker.dataset.t = t;
    marker.style.left = `${(t * pps).toFixed(1)}px`;
    emit('settings'); // live-refresh the preview transform, no row rebuild
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (moved) emit('keyframes'); // finalize: re-render + one history entry
    else seek(kf.t);
  };
  marker.addEventListener('pointerup', end);
  marker.addEventListener('pointercancel', end);
  marker.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    removeKeyframe(kf.id);
  });
}

function layoutKeyframeMarkers() {
  const pps = pxPerSecond();
  keyframeRow.querySelectorAll('.tl-kf-marker').forEach((m) => {
    m.style.left = `${(parseFloat(m.dataset.t) * pps).toFixed(1)}px`;
  });
}

// --- video track -------------------------------------------------------------

// Keeps the on-piece mute button in sync when the setting changes elsewhere
// (the Video tab toggle), without rebuilding the whole track on every 'settings'
// emit (which fires per slider tick).
function syncSegmentMute() {
  const btn = videoTrack.querySelector('.tl-seg-mute');
  if (!btn) return;
  const muted = !!state.audio.muted;
  btn.classList.toggle('on', muted);
  btn.title = muted ? 'Original audio muted — click to unmute' : 'Mute original audio';
  btn.innerHTML = icon(muted ? 'volume-x' : 'volume-2', 12);
}

function renderVideoTrack() {
  const duration = sourceDuration();
  videoTrack.innerHTML = '';
  segmentEls.clear();
  appendedClipEls.clear();
  if (duration <= 0) return;

  state.segments.forEach((seg, i) => {
    const prev = state.segments[i - 1] || null;
    const next = state.segments[i + 1] || null;

    const el = document.createElement('div');
    el.className = 'tl-segment';
    el.classList.toggle('selected', isSelected('segment', seg.id));

    const leftEdge = document.createElement('div');
    leftEdge.className = 'tl-seg-edge tl-seg-edge-left';
    const rightEdge = document.createElement('div');
    rightEdge.className = 'tl-seg-edge tl-seg-edge-right';
    el.appendChild(leftEdge);
    el.appendChild(rightEdge);

    attachSegmentMoveDrag(el, seg, prev, next);
    attachSegmentEdgeDrag(leftEdge, seg, prev, next, true);
    attachSegmentEdgeDrag(rightEdge, seg, prev, next, false);

    // Mute toggle for the source audio, on the piece itself (mirrors the Video
    // tab's "Mute original audio"). Global for now; becomes per-piece with B6.
    // Only on the first piece so a single control governs the shared setting.
    if (i === 0) {
      const muteBtn = document.createElement('button');
      muteBtn.type = 'button';
      muteBtn.className = 'tl-seg-mute' + (state.audio.muted ? ' on' : '');
      muteBtn.title = state.audio.muted ? 'Original audio muted — click to unmute' : 'Mute original audio';
      muteBtn.innerHTML = icon(state.audio.muted ? 'volume-x' : 'volume-2', 12);
      muteBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      muteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setAudio({ muted: !state.audio.muted });
      });
      el.appendChild(muteBtn);
    }

    segmentEls.set(seg.id, el);
    videoTrack.appendChild(el);
  });

  // Appended clips (sequential multi-source) render as their own bars after the
  // primary segments, in output order.
  for (const item of appendedLayout()) {
    const el = document.createElement('div');
    el.className = 'tl-appended-clip';
    el.dataset.clipId = item.clip.id;
    el.classList.toggle('selected', isSelected('clip', item.clip.id));
    const label = document.createElement('span');
    label.className = 'tl-text-label';
    label.innerHTML = icon('clapperboard', 12);
    label.append(document.createTextNode(' ' + (item.clip.source.name || 'Clip')));
    el.appendChild(label);
    const leftEdge = document.createElement('div');
    leftEdge.className = 'tl-text-edge tl-text-edge-left';
    const rightEdge = document.createElement('div');
    rightEdge.className = 'tl-text-edge tl-text-edge-right';
    el.append(leftEdge, rightEdge);
    attachAppendedClipDrag(el, item.clip);
    attachAppendedClipTrim(leftEdge, item.clip, true);
    attachAppendedClipTrim(rightEdge, item.clip, false);
    appendedClipEls.set(item.clip.id, el);
    videoTrack.appendChild(el);
  }

  // Transition slots at every output-touching boundary: a filled ✦ badge where a
  // transition exists (click to select + edit in the inspector), or a subtle "+"
  // slot where none does (click to add one and select it). Adding lives on the
  // cut itself — never a menu — since a transition attaches to a boundary.
  const pieces = orderedPieces();
  for (let i = 0; i < pieces.length - 1; i++) {
    if (pieces[i + 1].outStart - pieces[i].outEnd > 0.05) continue; // touching cuts only
    const piece = pieces[i];
    const tr = state.transitions.find((t) => t.afterSegmentId === piece.id) || null;
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className =
      'tl-transition-badge' +
      (tr ? '' : ' tl-transition-slot') +
      (tr && isSelected('transition', tr.id) ? ' selected' : '');
    badge.dataset.after = piece.id;
    badge.innerHTML = icon(tr ? 'zap' : 'plus', 12);
    badge.title = tr
      ? `${tr.type === 'black-flash' ? 'Dip to black' : 'White flash'} (${tr.duration.toFixed(1)}s) — click to edit`
      : 'Add a transition on this cut';
    badge.addEventListener('pointerdown', (e) => e.stopPropagation());
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tr) {
        selectTransition(tr.id);
      } else {
        const created = addTransitionAfter(piece.id, 0.5, 'white-flash');
        if (created) selectTransition(created.id);
      }
    });
    videoTrack.appendChild(badge);
  }

  layoutVideoTrack();
}

// Press = select; press-and-drag past the threshold = move the piece.
// Free mode commits the new outStart (clamped so neighbors never overlap
// in output time). Snap mode lets the piece float while held, then snaps
// it home on release — CapCut's exact feel.
function attachSegmentMoveDrag(el, seg, prev, next) {
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    // Shift-click toggles this piece in the multi-selection (B6) — no drag.
    if (e.shiftKey) {
      togglePieceSelection('segment', seg.id);
      return;
    }
    // selectSegment re-renders the track (innerHTML=''), detaching `el`. Drive the
    // drag off window + a live-element lookup so it survives the re-render.
    selectSegment(seg.id);
    // Seek into the piece so the preview shows its per-piece look while editing,
    // unless the playhead is already inside it.
    const segLen = seg.end - seg.start;
    const outT = getCurrentOutputTime();
    if (outT < seg.outStart || outT >= seg.outStart + segLen) seekOutput(seg.outStart + 0.001);

    const pps = pxPerSecond();
    const grabX = e.clientX;
    const outStartAtGrab = seg.outStart;
    const len = seg.end - seg.start;
    const minOut = prev ? prev.outStart + (prev.end - prev.start) : 0;
    const maxOut = next ? next.outStart - len : Math.max(outStartAtGrab, sourceDuration() - len + 10);
    let moving = false;
    const liveEl = () => segmentEls.get(seg.id);

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - grabX;
      if (!moving && Math.abs(dx) < MOVE_THRESHOLD_PX) return;
      moving = true;
      const deltaT = pps > 0 ? dx / pps : 0;
      if (state.timelineMode === 'free') {
        seg.outStart = Math.max(minOut, Math.min(outStartAtGrab + deltaT, Math.max(minOut, maxOut)));
        layoutAll();
      } else {
        // Snap mode: float visually while held, home position unchanged.
        const cur = liveEl();
        if (cur) {
          cur.style.left = `${(outStartAtGrab + deltaT) * pps}px`;
          cur.classList.add('floating');
        }
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const cur = liveEl();
      if (cur) cur.classList.remove('floating');
      if (moving) {
        if (state.timelineMode === 'snap') normalizeOutStarts();
        emit('segments');
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectSegment(seg.id);
    openStyleMenu(e.clientX, e.clientY);
  });
}

// Per-piece trim handles, in SOURCE time. Bounds reach over cut footage —
// the left edge back to the previous piece's source end (or 0), the right
// edge forward to the next piece's source start (or the clip end) — which
// is what makes trims non-destructive: deleted/trimmed footage is always
// there to pull back out. Pointer movement converts to a time DELTA
// (pixels / pxPerSecond) rather than an absolute position, since ripple
// re-flow moves the track under the cursor.
function attachSegmentEdgeDrag(edgeEl, seg, prev, next, isLeft) {
  edgeEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    selectSegment(seg.id);
    edgeEl.setPointerCapture(e.pointerId);

    const srcMin = prev ? prev.end : 0;
    const srcMax = next ? next.start : sourceDuration();
    const startAtGrab = seg.start;
    const endAtGrab = seg.end;
    const outEndAtGrab = seg.outStart + (seg.end - seg.start);
    const grabX = e.clientX;
    const pps = pxPerSecond();

    const onMove = (moveEvent) => {
      const deltaT = pps > 0 ? (moveEvent.clientX - grabX) / pps : 0;
      if (isLeft) {
        seg.start = Math.max(srcMin, Math.min(startAtGrab + deltaT, seg.end - MIN_SEGMENT_SECONDS));
        if (state.timelineMode === 'free') {
          // Anchor the piece's output END, so the left edge visibly moves
          // while the rest of the piece stays put (standard non-ripple trim).
          const minOut = prev ? prev.outStart + (prev.end - prev.start) : 0;
          seg.outStart = Math.max(minOut, outEndAtGrab - (seg.end - seg.start));
          seg.start = seg.end - (outEndAtGrab - seg.outStart);
        }
      } else {
        let maxEnd = srcMax;
        if (state.timelineMode === 'free' && next) {
          // Can't grow into the next piece's output space.
          maxEnd = Math.min(maxEnd, seg.start + (next.outStart - seg.outStart));
        }
        seg.end = Math.min(maxEnd, Math.max(endAtGrab + deltaT, seg.start + MIN_SEGMENT_SECONDS));
      }
      if (state.timelineMode === 'snap') normalizeOutStarts();
      layoutAll();
      // Scrub to the dragged edge so the exact cut frame is visible.
      seek(isLeft ? seg.start : Math.max(seg.start, seg.end - 0.02));
    };
    const onUp = (upEvent) => {
      edgeEl.releasePointerCapture(upEvent.pointerId);
      edgeEl.removeEventListener('pointermove', onMove);
      edgeEl.removeEventListener('pointerup', onUp);
      emit('segments');
    };
    edgeEl.addEventListener('pointermove', onMove);
    edgeEl.addEventListener('pointerup', onUp);
  });
}

// --- toolbar actions -----------------------------------------------------------

// Split acts on whatever's selected — a text layer, a sound, or an overlay
// clip — splitting it at the playhead into two independent clips. With a
// video segment selected (or nothing), it splits the video piece under the
// playhead, as before.
function splitAtPlayhead() {
  const t = getCurrentTime();
  const layer = selectedLayer();
  if (layer) {
    const piece = splitLayerAt(layer.id, t);
    if (piece) selectLayer(piece.id);
    return;
  }
  const sound = selectedSound();
  if (sound) {
    const piece = splitSoundAt(sound.id, t);
    if (piece) selectSound(piece.id);
    return;
  }
  const overlay = selectedOverlay();
  if (overlay) {
    const piece = splitOverlayAt(overlay.id, t);
    if (piece) selectOverlay(piece.id);
    return;
  }
  const piece = splitSegmentAt(t);
  if (piece) selectSegment(piece.id);
}

// Delete acts on whatever's selected — clip of any kind, or a video piece.
function deleteSelection() {
  const seg = selectedSegment();
  if (seg) return removeSegment(seg.id);
  const layer = selectedLayer();
  if (layer) return removeLayer(layer.id);
  const sound = selectedSound();
  if (sound) return removeSound(sound.id);
  const overlay = selectedOverlay();
  if (overlay) return removeOverlay(overlay.id);
  const clip = selectedAppendedClip();
  if (clip) return removeAppendedClip(clip.id);
}

function refreshToolbar() {
  const seg = selectedSegment();
  const canDeleteSegment = seg && state.segments.length > 1;
  const otherSelected = !!(selectedLayer() || selectedSound() || selectedOverlay() || selectedAppendedClip());
  deleteBtn.disabled = !(canDeleteSegment || otherSelected);
}

// --- text / caption / sound rows --------------------------------------------------

function setRowVisible(rowEl, visible) {
  rowEl.classList.toggle('hidden', !visible);
  const label = rowEl.previousElementSibling;
  if (label && label.classList.contains('tl-label')) label.classList.toggle('hidden', !visible);
}

// Generic clip bar shared by layers, sounds, and overlays: a label, two
// resize edges, move/resize drag, and selection. opts:
//   selected()  -> whether this clip is selected (for the highlight class)
//   onSelect()  -> select it
//   emitEvent   -> 'layers' | 'settings', fired once on release
//   relayout()  -> re-position this clip's row in place during a drag
//   content     -> sound / video overlay: front-trim advances the clip's
//                  `offset` (media stays aligned) and length is capped to
//                  the remaining media, since you can't play past the file.
function buildClipBar(clip, className, labelText, opts) {
  const bar = document.createElement('div');
  bar.className = className;
  if (opts.selected()) bar.classList.add('selected');

  const label = document.createElement('span');
  label.className = 'tl-text-label';
  // Optional leading icon (SVG via innerHTML) + the text as a safe text node.
  if (opts.icon) label.innerHTML = icon(opts.icon, 12);
  label.append(document.createTextNode((opts.icon ? ' ' : '') + labelText));
  bar.appendChild(label);

  const leftEdge = document.createElement('div');
  leftEdge.className = 'tl-text-edge tl-text-edge-left';
  const rightEdge = document.createElement('div');
  rightEdge.className = 'tl-text-edge tl-text-edge-right';
  bar.appendChild(leftEdge);
  bar.appendChild(rightEdge);

  attachClipBarDrag(bar, leftEdge, rightEdge, clip, opts);
  return bar;
}

// Clip bars are dragged in OUTPUT coordinates (what's on screen) and the
// result converted back to source time — so a bar dragged up against a cut
// lands exactly at the cut's edge footage.
function attachClipBarDrag(bar, leftEdge, rightEdge, clip, opts) {
  function startDrag(e, mode) {
    e.stopPropagation();
    e.preventDefault();
    // onSelect() emits 'selection' synchronously, which re-renders this row
    // (innerHTML = '') and DETACHES `bar`/the edges mid-gesture. So the drag must
    // not depend on those elements surviving or on pointer capture on them (the
    // old code captured + listened on the now-dead node, which is why text/sound/
    // overlay bars became undraggable). Instead we listen on `window` and mutate
    // the stable `clip` object; opts.relayout() repositions the freshly-rendered
    // bar under the cursor.
    opts.onSelect();
    const outDur = outputDuration();
    const grabOut = xToOutTime(e.clientX);
    const dispStartAtGrab = sourceToOutput(clip.start);
    const dispEndAtGrab = sourceToOutput(clip.end);
    const startAtGrab = clip.start;
    const offsetAtGrab = clip.offset || 0;
    const maxLen = opts.content && clip.duration ? clip.duration - offsetAtGrab : Infinity;

    const clampToFootage = (outT) => {
      const src = outputToSource(Math.min(outDur, Math.max(0, outT)));
      return src !== null ? src : null;
    };

    const onMove = (moveEvent) => {
      const t = xToOutTime(moveEvent.clientX);
      if (mode === 'move') {
        const span = dispEndAtGrab - dispStartAtGrab;
        const ns = Math.max(0, Math.min(dispStartAtGrab + (t - grabOut), outDur - span));
        const s = clampToFootage(ns);
        const en = clampToFootage(ns + span);
        if (s !== null) clip.start = s;
        if (en !== null) clip.end = Math.max(en, clip.start + MIN_LAYER_SECONDS / 2);
      } else if (mode === 'left') {
        const newDisp = Math.max(0, Math.min(t, sourceToOutput(clip.end) - MIN_LAYER_SECONDS));
        const s = clampToFootage(newDisp);
        if (s !== null) {
          const newStart = Math.min(s, clip.end - MIN_LAYER_SECONDS);
          if (opts.content) clip.offset = Math.max(0, offsetAtGrab + (newStart - startAtGrab));
          clip.start = newStart;
        }
      } else {
        const newDisp = Math.min(outDur, Math.max(t, sourceToOutput(clip.start) + MIN_LAYER_SECONDS));
        const en = clampToFootage(newDisp);
        if (en !== null) {
          let newEnd = Math.max(en, clip.start + MIN_LAYER_SECONDS);
          if (Number.isFinite(maxLen)) newEnd = Math.min(newEnd, clip.start + maxLen);
          clip.end = newEnd;
        }
      }
      opts.relayout();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      emit(opts.emitEvent);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  bar.addEventListener('pointerdown', (e) => startDrag(e, 'move'));
  leftEdge.addEventListener('pointerdown', (e) => startDrag(e, 'left'));
  rightEdge.addEventListener('pointerdown', (e) => startDrag(e, 'right'));
  // Right-click: select this clip, then Copy/Paste style + Duplicate (Feature 6).
  bar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    opts.onSelect();
    openStyleMenu(e.clientX, e.clientY);
  });
}

function renderLayerRows() {
  captionsRow.innerHTML = '';
  textRow.innerHTML = '';
  layerBarEls.clear();
  const hasSource = sourceDuration() > 0;

  let captionCount = 0;
  let textCount = 0;
  if (hasSource) {
    for (const layer of state.layers) {
      const bar = buildClipBar(layer, 'tl-text-bar', layer.text.replace(/\s+/g, ' ').trim() || 'Text', {
        selected: () => isSelected('layer', layer.id),
        onSelect: () => selectLayer(layer.id),
        emitEvent: 'layers',
        relayout: layoutLayerBars,
        content: false,
      });
      if (layer.group === 'caption') bar.classList.add('caption');
      layerBarEls.set(layer.id, bar);
      (layer.group === 'caption' ? captionsRow : textRow).appendChild(bar);
      if (layer.group === 'caption') captionCount += 1;
      else textCount += 1;
    }
  }
  setRowVisible(captionsRow, captionCount > 0);
  setRowVisible(textRow, textCount > 0);
  layoutLayerBars();
}

function renderSoundRow() {
  soundRow.innerHTML = '';
  soundBarEls.clear();
  const show = sourceDuration() > 0 && state.sounds.length > 0;
  setRowVisible(soundRow, show);
  if (!show) return;
  for (const s of state.sounds) {
    const bar = buildClipBar(s, 'tl-sound-bar', `${s.label || 'Sound'}`, {
      icon: 'music',
      selected: () => isSelected('sound', s.id),
      onSelect: () => selectSound(s.id),
      emitEvent: 'settings',
      relayout: layoutSoundBars,
      content: true,
    });
    soundBarEls.set(s.id, bar);
    soundRow.appendChild(bar);
  }
  layoutSoundBars();
}

// --- overlay row ------------------------------------------------------------------

function renderOverlayRow() {
  overlayRow.innerHTML = '';
  overlayBarEls.clear();
  const show = sourceDuration() > 0 && state.overlays.length > 0;
  setRowVisible(overlayRow, show);
  if (!show) return;
  for (const o of state.overlays) {
    const bar = buildClipBar(o, 'tl-overlay-bar', `${o.isVideo ? 'Video' : 'Image'} overlay`, {
      icon: 'image',
      selected: () => isSelected('overlay', o.id),
      onSelect: () => selectOverlay(o.id),
      emitEvent: 'settings',
      relayout: layoutOverlayBars,
      content: o.isVideo,
    });
    overlayBarEls.set(o.id, bar);
    overlayRow.appendChild(bar);
  }
  layoutOverlayBars();
}

// --- playhead / scrubbing ---------------------------------------------------------

function updatePlayhead() {
  playhead.style.left = `${trackOriginX() + outTimeToX(getCurrentOutputTime())}px`;
  playhead.classList.toggle('hidden', sourceDuration() <= 0);
}

// Scrubbing lives on the ruler (and the playhead itself) — the tracks'
// own gestures are select/move/trim.
function attachScrub() {
  for (const surface of [ruler, playhead]) {
    surface.addEventListener('pointerdown', (e) => {
      if (sourceDuration() <= 0) return;
      surface.setPointerCapture(e.pointerId);
      seekOutput(xToOutTime(e.clientX));

      const onMove = (moveEvent) => seekOutput(xToOutTime(moveEvent.clientX));
      const onUp = (upEvent) => {
        surface.releasePointerCapture(upEvent.pointerId);
        surface.removeEventListener('pointermove', onMove);
        surface.removeEventListener('pointerup', onUp);
      };
      surface.addEventListener('pointermove', onMove);
      surface.addEventListener('pointerup', onUp);
    });
  }
}

// --- init ----------------------------------------------------------------------

function renderAll() {
  const hasSource = sourceDuration() > 0;
  emptyMsg.classList.toggle('hidden', hasSource);
  setRowVisible(videoTrack, hasSource);
  renderRuler();
  renderKeyframeRow();
  renderVideoTrack();
  renderOverlayRow();
  renderLayerRows();
  renderSoundRow();
  refreshToolbar();
  updatePlayhead();
}

export function initTimeline() {
  attachScrub();
  splitBtn.addEventListener('click', splitAtPlayhead);
  deleteBtn.addEventListener('click', deleteSelection);
  zoomInBtn.addEventListener('click', () => stepZoom(1));
  zoomOutBtn.addEventListener('click', () => stepZoom(-1));
  fitBtn.addEventListener('click', fitZoom);
  // Slider drives zoom continuously around the playhead; double-click fits.
  zoomSlider.addEventListener('input', () => zoomTo(parseFloat(zoomSlider.value), getCurrentOutputTime()));
  zoomSlider.addEventListener('dblclick', fitZoom);
  // ⌘/Ctrl + scroll — and trackpad pinch, which the browser reports as a
  // ctrlKey wheel — zoom smoothly around the cursor. Plain scroll pans normally.
  tlBody.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.002); // continuous, cursor-anchored
      zoomTo(tlZoom * factor, xToOutTime(e.clientX));
    },
    { passive: false }
  );
  // +/- (and =) zoom around the playhead, unless the user is typing.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      stepZoom(1);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      stepZoom(-1);
    }
  });
  applyTimelineZoom();

  // Click-away deselect: pressing anywhere on the timeline that isn't a
  // selectable element (a clip/keyframe/badge) clears the current selection.
  tlBody.addEventListener('pointerdown', (e) => {
    if (!e.target.closest(SELECTABLE_SELECTOR)) clearSelection();
  });

  on('source', renderAll);
  on('segments', renderAll);
  on('layers', renderAll);
  on('keyframes', renderKeyframeRow);
  on('settings', () => {
    renderSoundRow();
    renderOverlayRow();
    syncSegmentMute();
  });
  on('selection', () => {
    renderVideoTrack();
    renderLayerRows();
    renderSoundRow();
    renderOverlayRow();
    refreshToolbar();
  });
  on('time', updatePlayhead);
  window.addEventListener('resize', applyTimelineZoom);
}
