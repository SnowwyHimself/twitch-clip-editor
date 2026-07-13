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
  removeTransition,
  sourceDuration,
  outputDuration,
  primaryOutputDuration,
  appendedLayout,
  selectClip,
  selectedAppendedClip,
  removeAppendedClip,
  moveAppendedClip,
  updateAppendedClip,
  sourceToOutput,
  outputToSource,
  MIN_SEGMENT_SECONDS,
  MIN_LAYER_SECONDS,
} from './state.js';
import { seek, seekOutput, getCurrentTime, getCurrentOutputTime } from './preview.js';
import { getPeaks, drawWaveform } from './waveform.js';
import { getFilmstrip, drawFilmstrip } from './filmstrip.js';

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

const MOVE_THRESHOLD_PX = 4; // press-and-hold under this = click/select, over = drag

// Timeline zoom: 1 = whole clip fits the width; >1 widens the tracks (the body
// scrolls) so caption blocks / keyframes are easier to grab. The track column
// is stretched to fitWidth×zoom; pxPerSecond derives from the ruler's own width
// so everything (ruler, clips, keyframes, playhead) stays in sync.
const TL_ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8];
let tlZoom = 1;

function fitTrackWidth() {
  // Visible width available to the track column (body minus the label gutter).
  return Math.max(120, tlBody.clientWidth - 64 - 8);
}

function applyTimelineZoom() {
  if (tlZoom <= 1) {
    tlGrid.style.width = '';
  } else {
    tlGrid.style.width = `${Math.round(64 + 8 + fitTrackWidth() * tlZoom)}px`;
  }
  zoomLabel.textContent = `${Math.round(tlZoom * 100)}%`;
  zoomOutBtn.disabled = tlZoom <= TL_ZOOM_STEPS[0];
  zoomInBtn.disabled = tlZoom >= TL_ZOOM_STEPS[TL_ZOOM_STEPS.length - 1];
  renderAll();
}

function nextZoomStep(dir) {
  const i = TL_ZOOM_STEPS.indexOf(tlZoom);
  return TL_ZOOM_STEPS[Math.min(TL_ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
}

// Zoom to `next`, keeping `anchorOutTime` pinned under the same on-screen
// position (so the timeline grows/shrinks *around* the playhead or the mouse,
// not the left edge). ruler.offsetLeft is the constant label-gutter offset;
// outTimeToX rescales with the new pxPerSecond after applyTimelineZoom relays
// out the grid.
function zoomTo(next, anchorOutTime) {
  if (next === tlZoom) return;
  const anchorContentBefore = ruler.offsetLeft + outTimeToX(anchorOutTime);
  const viewportX = anchorContentBefore - tlBody.scrollLeft;
  tlZoom = next;
  applyTimelineZoom();
  const anchorContentAfter = ruler.offsetLeft + outTimeToX(anchorOutTime);
  tlBody.scrollLeft = anchorContentAfter - viewportX;
}

function stepZoom(dir) {
  zoomTo(nextZoomStep(dir), getCurrentOutputTime());
}

function trackWidth() {
  return ruler.clientWidth || 1;
}

// Pinned scale: source duration normally, stretched only if free-mode
// gaps push the output past it. Constant while trimming/deleting, so the
// track never rescales mid-drag.
function pxPerSecond() {
  const span = Math.max(sourceDuration(), outputDuration());
  return span > 0 ? trackWidth() / span : 0;
}

function outTimeToX(t) {
  return t * pxPerSecond();
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

  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => span / s <= 12) || 600;

  for (let t = 0; t <= span; t += step) {
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

function layoutVideoTrack() {
  const pps = pxPerSecond();
  const srcUrl = state.source && state.source.previewUrl;
  for (const seg of state.segments) {
    const el = segmentEls.get(seg.id);
    if (!el) continue;
    el.style.left = `${seg.outStart * pps}px`;
    el.style.width = `${Math.max(6, (seg.end - seg.start) * pps)}px`;
    // Video-frame thumbnails for this piece's [start,end] slice.
    paintFilmstrip(el, srcUrl, seg.start, seg.end - seg.start);
  }
  for (const item of appendedLayout()) {
    const el = appendedClipEls.get(item.clip.id);
    if (!el) continue;
    el.style.left = `${item.outStart * pps}px`;
    el.style.width = `${Math.max(6, (item.outEnd - item.outStart) * pps)}px`;
    paintFilmstrip(el, item.clip.source.previewUrl, item.clip.start, item.outEnd - item.outStart);
  }
  layoutTransitionBadges();
}

// Appended-clip bar interaction. Click selects it; a horizontal drag reorders it
// among the other appended clips (drop position by its centre). Trim handles
// come with the edge grips added in buildClipBar-style later.
function attachAppendedClipDrag(el, clip) {
  let startX = 0;
  let dragging = false;
  let moved = false;
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    selectClip(clip.id);
    startX = e.clientX;
    dragging = true;
    moved = false;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers */
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (!moved && Math.abs(e.clientX - startX) <= MOVE_THRESHOLD_PX) return;
    moved = true;
    el.classList.add('dragging');
    el.style.transform = `translateX(${e.clientX - startX}px)`;
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    el.style.transform = '';
    if (!moved) return;
    // Reorder by where the bar's centre landed among the appended clips.
    const pps = pxPerSecond();
    const centerOut = (parseFloat(el.style.left) + (e.clientX - startX) + el.offsetWidth / 2) / (pps || 1);
    const order = state.appendedClips.map((c) => c.id).filter((id) => id !== clip.id);
    let idx = 0;
    let cursor = primaryOutputDuration();
    for (const id of order) {
      const c = state.appendedClips.find((x) => x.id === id);
      const len = Math.max(0, (c.end ?? c.duration) - (c.start || 0));
      if (centerOut < cursor + len / 2) break;
      cursor += len;
      idx += 1;
    }
    moveAppendedClip(clip.id, idx);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
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
  videoTrack.querySelectorAll('.tl-transition-badge').forEach((badge) => {
    const seg = state.segments.find((s) => s.id === badge.dataset.after);
    if (seg) badge.style.left = `${(seg.outStart + (seg.end - seg.start)) * pps}px`;
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
  for (const s of state.sounds) {
    const el = soundBarEls.get(s.id);
    if (!el) continue;
    layoutClipBar(el, s);
    paintWaveform(el, s.url, s.offset || 0, s.end - s.start);
  }
}

function layoutOverlayBars() {
  for (const o of state.overlays) {
    const el = overlayBarEls.get(o.id);
    if (el) layoutClipBar(el, o);
  }
}

function layoutAll() {
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
    marker.textContent = '◆';
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
    label.textContent = `🎬 ${item.clip.source.name || 'Clip'}`;
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

  // Transition badges at boundaries that have one.
  for (const tr of state.transitions) {
    const seg = state.segments.find((s) => s.id === tr.afterSegmentId);
    if (!seg) continue;
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'tl-transition-badge';
    badge.dataset.after = seg.id;
    badge.textContent = '✦';
    badge.title = `White flash (${tr.duration.toFixed(1)}s) — click to remove`;
    badge.addEventListener('pointerdown', (e) => e.stopPropagation());
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTransition(tr.id);
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
    selectSegment(seg.id);
    el.setPointerCapture(e.pointerId);

    const pps = pxPerSecond();
    const grabX = e.clientX;
    const outStartAtGrab = seg.outStart;
    const len = seg.end - seg.start;
    const minOut = prev ? prev.outStart + (prev.end - prev.start) : 0;
    const maxOut = next ? next.outStart - len : Math.max(outStartAtGrab, sourceDuration() - len + 10);
    let moving = false;

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
        el.style.left = `${(outStartAtGrab + deltaT) * pps}px`;
        el.classList.add('floating');
      }
    };
    const onUp = (upEvent) => {
      el.releasePointerCapture(upEvent.pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.classList.remove('floating');
      if (moving) {
        if (state.timelineMode === 'snap') normalizeOutStarts();
        emit('segments');
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
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
  label.textContent = labelText;
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
    opts.onSelect();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
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
    const onUp = (upEvent) => {
      target.releasePointerCapture(upEvent.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      emit(opts.emitEvent);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  }

  bar.addEventListener('pointerdown', (e) => startDrag(e, 'move'));
  leftEdge.addEventListener('pointerdown', (e) => startDrag(e, 'left'));
  rightEdge.addEventListener('pointerdown', (e) => startDrag(e, 'right'));
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
    const bar = buildClipBar(s, 'tl-sound-bar', `🔊 ${s.label || 'Sound'}`, {
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
    const bar = buildClipBar(o, 'tl-overlay-bar', `🖼 ${o.isVideo ? 'Video' : 'Image'} overlay`, {
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
  playhead.style.left = `${ruler.offsetLeft + outTimeToX(getCurrentOutputTime())}px`;
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
  // ⌘/Ctrl + scroll zooms the timeline around the cursor (CapCut-style). Plain
  // scroll is left alone so the track still pans/scrolls normally.
  tlBody.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const next = nextZoomStep(e.deltaY < 0 ? 1 : -1);
      zoomTo(next, xToOutTime(e.clientX));
    },
    { passive: false }
  );
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
