// Live preview: a fast CSS-only approximation of the real ffmpeg render,
// updated instantly on every state change — no server round-trip. Not
// pixel-identical on purpose: exact stroke rendering, emoji compositing,
// and system-font fallback are handled precisely by the real render.
//
// The techniques are inherited from the pre-editor app and unchanged:
// - Zoom: foreground video object-fit:contain + transform:scale(), which
//   letterboxes and grows exactly like the real width-locked crop.
// - Blur background: a second copy of the same video, object-fit:cover
//   (matches ffmpeg's scale+crop "increase" fill), CSS blur() ~ gblur.
//   Hidden at blur=0, matching the real "plain letterboxing" behavior.
// - Mirror/speed: scale(-1) transforms and playbackRate.
// What's new: text is no longer a single caption — every state.layers
// entry gets its own absolutely-positioned element, draggable on BOTH
// axes, shown only while the playhead is inside its time range (or while
// it's selected, so you can style a layer without chasing the playhead).

import {
  state,
  on,
  emit,
  selectLayer,
  resetSegments,
  resetHistory,
  sourceDuration,
  outputDuration,
  sourceToOutput,
  outputToSourceClamped,
  pieceAtOutput,
} from './state.js';

const previewArea = document.getElementById('preview-area');
const previewFrame = document.getElementById('preview-frame');
const bgVideo = document.getElementById('preview-bg-video');
const fgVideo = document.getElementById('preview-fg-video');
const placeholder = document.getElementById('preview-placeholder');
const guideX = document.getElementById('preview-guide-x');
const guideY = document.getElementById('preview-guide-y');
const overlayEl = document.getElementById('preview-overlay');
const layersContainer = document.getElementById('text-layers');
const controls = document.getElementById('preview-controls');
const playBtn = document.getElementById('preview-play-btn');
const seekSlider = document.getElementById('preview-seek');
const timeLabel = document.getElementById('preview-time');
const muteBtn = document.getElementById('preview-mute-btn');
const flashEl = document.getElementById('preview-flash');

const PREVIEW_OUTLINE_THICKNESS = 15; // matches caption.js's OUTLINE_THICKNESS (% of font size)
const PREVIEW_BOX_PADDING_X = 34; // canvas px — matches caption.js BOX_PADDING_X
const PREVIEW_BOX_PADDING_Y = 18;
const PREVIEW_BOX_RADIUS_RATIO = 0.22;
const PREVIEW_LINE_HEIGHT_RATIO = 1.22; // approximates (ascender+descender)/unitsPerEm across the bundled fonts
const PREVIEW_BLUR_CSS_SCALE = 0.5; // 0-100 blur slider -> 0-50px CSS blur radius
const POSITION_SNAP_PX = 8;

// CSS families for the live preview only — the real render resolves the
// actual font files server-side (see caption.js). The *Preview families
// are @font-face'd from the same bundled TTFs.
const PREVIEW_FONT_CSS_FAMILY = {
  'proxima-nova': '"Proxima Nova", sans-serif',
  montserrat: '"Montserrat SemiBold Preview", sans-serif',
  manrope: '"Manrope ExtraBold Preview", sans-serif',
  poppins: '"Poppins ExtraBold Preview", sans-serif',
  'archivo-black': '"Archivo Black Preview", sans-serif',
  'bebas-neue': '"Bebas Neue Preview", sans-serif',
  anton: '"Anton Preview", sans-serif',
  'burbank-condensed': '"Burbank Big Condensed", sans-serif',
  'burbank-condensed-bold': '"Burbank Big Condensed Black", "Burbank Big Condensed", sans-serif',
};

let previewObjectUrl = null;

// --- geometry helpers (ported unchanged from the pre-editor preview) ------

// Elements are positioned with fixed left/top at 50%/50% and moved purely
// via a translate offset — a variable left/top would feed into the
// browser's shrink-to-fit width calculation for an absolutely-positioned
// auto-width box, making word-wrap depend on position. Transforms are
// paint-only and never feed back into layout.
function setCenterTransform(el, centerXPx, centerYPx, frameWidth, frameHeight) {
  const offsetX = centerXPx - frameWidth / 2;
  const offsetY = centerYPx - frameHeight / 2;
  el.style.transform = `translate(calc(-50% + ${offsetX.toFixed(2)}px), calc(-50% + ${offsetY.toFixed(2)}px))`;
}

// 0-100 "center position" percent -> pixel center, clamped so the content
// always stays fully on-frame at any size.
function resolvePreviewCenter(percent, contentSize, containerSize) {
  const minCenter = contentSize / 2;
  const maxCenter = containerSize - contentSize / 2;
  return maxCenter >= minCenter ? minCenter + (percent / 100) * (maxCenter - minCenter) : containerSize / 2;
}

function resolvePreviewPercent(centerPx, contentSize, containerSize) {
  const minCenter = contentSize / 2;
  const maxCenter = containerSize - contentSize / 2;
  if (maxCenter <= minCenter) return 50;
  const percent = ((centerPx - minCenter) / (maxCenter - minCenter)) * 100;
  return Math.min(100, Math.max(0, percent));
}

// Mirrors caption.js's getContrastTextColor exactly (same luma weights).
function getContrastTextColor(hexColor) {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? '#000000' : '#ffffff';
}

// Matches a single emoji char (optionally + FE0F) — used to exempt emoji
// from the outline style's text-stroke, since a black stroke drawn over a
// color emoji looks wrong.
const EMOJI_REGEX = /\p{Extended_Pictographic}️?/gu;

function captionHtml(text) {
  const segments = [];
  let lastIndex = 0;
  for (const match of text.matchAll(EMOJI_REGEX)) {
    if (match.index > lastIndex) segments.push({ emoji: false, value: text.slice(lastIndex, match.index) });
    segments.push({ emoji: true, value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ emoji: false, value: text.slice(lastIndex) });

  return segments
    .map((seg) => {
      const escaped = seg.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return seg.emoji ? `<span style="-webkit-text-stroke:0;">${escaped}</span>` : escaped;
    })
    .join('');
}

// Box style pills: one rounded rect per rendered line, measured off the
// browser's own wrap via Range.getClientRects() (merged per visual row —
// wrapped text can report an extra near-zero rect for the collapsed
// trailing space at the wrap point), touching at internal seams, with a
// flattening patch between (near-)equal-width neighbors — the exact same
// construction caption.js performs for the real SVG render.
function mergeSameRowRects(rects) {
  const merged = [];
  for (const r of rects) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(r.top - last.top) < 1 && Math.abs(r.bottom - last.bottom) < 1) {
      last.left = Math.min(last.left, r.left);
      last.right = Math.max(last.right, r.right);
      last.width = last.right - last.left;
    } else {
      merged.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width });
    }
  }
  return merged;
}

function applyBoxPills(captionEl, innerEl, fillersEl, scale, paddingXPx, paddingYPx, radiusPx, boxColor) {
  fillersEl.innerHTML = '';
  const range = document.createRange();
  range.selectNodeContents(innerEl);
  const rects = mergeSameRowRects(Array.from(range.getClientRects()));
  if (rects.length === 0) return;

  const containerRect = captionEl.getBoundingClientRect();
  const n = rects.length;
  const pillWidths = rects.map((r) => r.width + paddingXPx * 2);

  const tops = [];
  const bottoms = [];
  for (let i = 0; i < n; i++) {
    tops.push(i === 0 ? rects[i].top - paddingYPx : (rects[i - 1].bottom + rects[i].top) / 2);
    bottoms.push(i === n - 1 ? rects[i].bottom + paddingYPx : (rects[i].bottom + rects[i + 1].top) / 2);
  }

  for (let i = 0; i < n; i++) {
    const width = pillWidths[i];
    const centerX = (rects[i].left + rects[i].right) / 2 - containerRect.left;
    const pill = document.createElement('div');
    pill.style.position = 'absolute';
    pill.style.left = `${(centerX - width / 2).toFixed(2)}px`;
    pill.style.top = `${(tops[i] - containerRect.top).toFixed(2)}px`;
    pill.style.width = `${width.toFixed(2)}px`;
    pill.style.height = `${(bottoms[i] - tops[i] + 1).toFixed(2)}px`; // +1: antialiasing-seam margin, same as caption.js ROW_OVERLAP
    pill.style.background = boxColor;
    pill.style.borderRadius = `${radiusPx.toFixed(2)}px`;
    fillersEl.appendChild(pill);
  }

  const tolerance = 3 * scale;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(pillWidths[i] - pillWidths[i + 1]) > tolerance) continue;
    const fillerWidth = Math.min(pillWidths[i], pillWidths[i + 1]);
    const centerX = (rects[i].left + rects[i].right) / 2 - containerRect.left;
    const seamY = bottoms[i] - containerRect.top;
    const filler = document.createElement('div');
    filler.style.position = 'absolute';
    filler.style.left = `${(centerX - fillerWidth / 2).toFixed(2)}px`;
    filler.style.top = `${(seamY - radiusPx).toFixed(2)}px`;
    filler.style.width = `${fillerWidth.toFixed(2)}px`;
    filler.style.height = `${(radiusPx * 2).toFixed(2)}px`;
    filler.style.background = boxColor;
    fillersEl.appendChild(filler);
  }
}

// --- frame sizing ----------------------------------------------------------

function fitPreviewFrame() {
  const maxW = Math.max(160, previewArea.clientWidth - 48);
  const maxH = Math.max(160, previewArea.clientHeight - 90); // leave room for the playback bar
  const { width: ratioW, height: ratioH } = state.aspect;
  let width = maxW;
  let height = (width * ratioH) / ratioW;
  if (height > maxH) {
    height = maxH;
    width = (height * ratioW) / ratioH;
  }
  previewFrame.style.width = `${Math.round(width)}px`;
  previewFrame.style.height = `${Math.round(height)}px`;
  controls.style.width = `${Math.round(width)}px`;
}

function frameSize() {
  const width = previewFrame.clientWidth || 220;
  const height = previewFrame.clientHeight || (width * state.aspect.height) / state.aspect.width;
  return { width, height };
}

// --- text layer elements ----------------------------------------------------

const layerEls = new Map(); // layer.id -> { root, inner, fillers }

function createLayerEl(layer) {
  const root = document.createElement('div');
  root.className = 'preview-caption';
  root.dataset.id = layer.id;
  const fillers = document.createElement('div');
  fillers.className = 'preview-caption-fillers';
  const inner = document.createElement('span');
  inner.className = 'preview-caption-inner';
  root.appendChild(fillers);
  root.appendChild(inner);
  layersContainer.appendChild(root);
  attachLayerDrag(root, layer.id);
  const entry = { root, inner, fillers };
  layerEls.set(layer.id, entry);
  return entry;
}

function syncLayerEls() {
  const ids = new Set(state.layers.map((l) => l.id));
  for (const [id, entry] of layerEls) {
    if (!ids.has(id)) {
      entry.root.remove();
      layerEls.delete(id);
    }
  }
  for (const layer of state.layers) {
    if (!layerEls.has(layer.id)) createLayerEl(layer);
    updateLayerEl(layer);
  }
  updateLayerVisibility();
}

function updateLayerEl(layer) {
  const entry = layerEls.get(layer.id) || createLayerEl(layer);
  const { root, inner, fillers } = entry;
  const { width: frameWidth, height: frameHeight } = frameSize();
  const scale = frameWidth / state.aspect.width;

  root.classList.toggle('selected', layer.id === state.selectedId);
  root.classList.toggle('style-box', layer.style === 'box');
  inner.style.fontFamily = PREVIEW_FONT_CSS_FAMILY[layer.fontId] || PREVIEW_FONT_CSS_FAMILY.montserrat;
  inner.innerHTML = captionHtml(layer.text);

  const fontSizePx = layer.fontSize * scale;
  inner.style.fontSize = `${fontSizePx.toFixed(2)}px`;
  inner.style.lineHeight = String(PREVIEW_LINE_HEIGHT_RATIO);
  // Same fixed wrap width the server uses (900/1080 of canvas width) so
  // the preview wraps at the same words the real render does.
  root.style.maxWidth = `${((frameWidth * 900) / 1080).toFixed(2)}px`;

  const shadowOffsetX = (fontSizePx * 0.05).toFixed(2);
  const shadowOffsetY = (fontSizePx * 0.07).toFixed(2);
  const shadowBlur = (fontSizePx * 0.05).toFixed(2);
  const shadow = `drop-shadow(${shadowOffsetX}px ${shadowOffsetY}px ${shadowBlur}px rgba(0,0,0,0.4))`;

  if (layer.style === 'outline' || layer.style === 'plain') {
    fillers.innerHTML = '';
    fillers.style.filter = 'none';
    const strokePx = layer.style === 'outline' ? fontSizePx * (PREVIEW_OUTLINE_THICKNESS / 100) : 0;
    inner.style.color = layer.color;
    inner.style.webkitTextStroke = `${strokePx.toFixed(2)}px black`;
    inner.style.filter = layer.dropShadow ? shadow : 'none';
  } else {
    const paddingYPx = PREVIEW_BOX_PADDING_Y * scale;
    const paddingXPx = PREVIEW_BOX_PADDING_X * scale;
    const singleLineBoxHeight = fontSizePx * PREVIEW_LINE_HEIGHT_RATIO + paddingYPx * 2;
    const radiusPx = singleLineBoxHeight * PREVIEW_BOX_RADIUS_RATIO;
    inner.style.color = getContrastTextColor(layer.color);
    inner.style.webkitTextStroke = '0';
    inner.style.filter = 'none';
    // One shared filter on the pills container so the connected stack
    // casts a single unified shadow, matching caption.js's <g filter>.
    fillers.style.filter = layer.dropShadow ? shadow : 'none';
    applyBoxPills(root, inner, fillers, scale, paddingXPx, paddingYPx, radiusPx, layer.color);
  }

  const centerX = resolvePreviewCenter(layer.xPercent, root.offsetWidth, frameWidth);
  const centerY = resolvePreviewCenter(layer.yPercent, root.offsetHeight, frameHeight);
  setCenterTransform(root, centerX, centerY, frameWidth, frameHeight);
}

// Shown while the playhead is inside the layer's range, or while selected
// (so styling a layer never requires chasing the playhead first). During
// an output gap (black) nothing has footage, so nothing shows.
// visibility (not display) keeps layout measurable for the pill math.
function updateLayerVisibility() {
  const t = fgVideo.currentTime || 0;
  for (const layer of state.layers) {
    const entry = layerEls.get(layer.id);
    if (!entry) continue;
    const inRange = !gap && t >= layer.start && t < layer.end;
    const visible = inRange || layer.id === state.selectedId;
    entry.root.classList.toggle('time-hidden', !visible);
  }
}

// --- layer dragging ---------------------------------------------------------

function attachLayerDrag(el, layerId) {
  let dragging = false;
  let startPointer = null;
  let startCenter = null;

  el.addEventListener('pointerdown', (e) => {
    selectLayer(layerId);
    dragging = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const frameRect = previewFrame.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    startPointer = { x: e.clientX, y: e.clientY };
    startCenter = {
      x: (rect.left + rect.right) / 2 - frameRect.left,
      y: (rect.top + rect.bottom) / 2 - frameRect.top,
    };
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const { width: frameWidth, height: frameHeight } = frameSize();
    const w = el.offsetWidth;
    const h = el.offsetHeight;

    let newX = startCenter.x + (e.clientX - startPointer.x);
    let newY = startCenter.y + (e.clientY - startPointer.y);
    newX = Math.min(Math.max(newX, Math.min(w / 2, frameWidth - w / 2)), Math.max(w / 2, frameWidth - w / 2));
    newY = Math.min(Math.max(newY, Math.min(h / 2, frameHeight - h / 2)), Math.max(h / 2, frameHeight - h / 2));

    // Snap to dead-center on either axis, like alignment guides everywhere.
    const snappedX = Math.abs(newX - frameWidth / 2) < POSITION_SNAP_PX;
    const snappedY = Math.abs(newY - frameHeight / 2) < POSITION_SNAP_PX;
    if (snappedX) newX = frameWidth / 2;
    if (snappedY) newY = frameHeight / 2;
    guideX.classList.toggle('visible', snappedX);
    guideY.classList.toggle('visible', snappedY);

    setCenterTransform(el, newX, newY, frameWidth, frameHeight);

    const layer = state.layers.find((l) => l.id === layerId);
    if (layer) {
      // Written directly (no emit) during the drag — the full 'layers'
      // re-render runs once on release instead of per pointer event.
      layer.xPercent = Math.round(resolvePreviewPercent(newX, w, frameWidth));
      layer.yPercent = Math.round(resolvePreviewPercent(newY, h, frameHeight));
    }
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    guideX.classList.remove('visible');
    guideY.classList.remove('visible');
    emit('layers');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// --- media overlay (image/video, rendered above the video) -------------------

let overlayObjectUrl = null;
let overlayMediaEl = null; // the <img>/<video> child of overlayEl
let overlayIsVideo = false;
let overlayMediaDims = null; // { w, h } natural dims, once known
let overlayEditing = false; // Overlay tab active -> keep visible for editing

// Kept visible for editing regardless of the playhead — the same way a
// selected text layer stays visible. The panel calls this on tab switches.
export function setOverlayEditing(editing) {
  overlayEditing = editing;
  tickOverlay(getCurrentOutputTime());
}

export function setOverlayFile(file) {
  if (overlayObjectUrl) {
    URL.revokeObjectURL(overlayObjectUrl);
    overlayObjectUrl = null;
  }
  overlayEl.innerHTML = '';
  overlayMediaEl = null;
  overlayMediaDims = null;
  if (!file) {
    state.overlay = null;
    emit('settings');
    return;
  }
  const duration = sourceDuration();
  overlayIsVideo = file.type.startsWith('video/');
  state.overlay = {
    file,
    isVideo: overlayIsVideo,
    sizePercent: 35,
    xPercent: 50,
    yPercent: 50,
    cropTop: 0,
    cropBottom: 0,
    cropLeft: 0,
    cropRight: 0,
    start: 0,
    end: duration > 0 ? duration : 5, // spans the whole clip by default
  };

  const el = document.createElement(overlayIsVideo ? 'video' : 'img');
  if (overlayIsVideo) {
    // Muted (overlay audio is never mapped into the render), looped so a
    // short clip fills a longer range, and driven manually by tickOverlay
    // — NOT autoplay — so it plays/pauses in lockstep with the editor.
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
  }
  el.addEventListener(
    overlayIsVideo ? 'loadedmetadata' : 'load',
    () => {
      overlayMediaDims = overlayIsVideo
        ? { w: el.videoWidth, h: el.videoHeight }
        : { w: el.naturalWidth, h: el.naturalHeight };
      updateOverlay();
    },
    { once: true }
  );
  el.src = URL.createObjectURL(file);
  overlayObjectUrl = el.src;
  overlayEl.appendChild(el);
  overlayMediaEl = el;
  overlayEditing = true; // just added from the Overlay tab
  emit('settings');
}

// Sizes/positions the overlay box and applies the crop by scaling the
// media inside an overflow-hidden box so the kept region fills the box —
// the CSS equivalent of the export's ffmpeg crop+scale.
function updateOverlay() {
  const { width: frameWidth, height: frameHeight } = frameSize();
  if (!state.overlay) {
    overlayEl.classList.add('hidden');
    return;
  }
  overlayEl.classList.remove('hidden');
  const o = state.overlay;
  const boxW = frameWidth * (o.sizePercent / 100);
  const cropFracW = Math.max(0.1, 1 - (o.cropLeft + o.cropRight) / 100);
  const cropFracH = Math.max(0.1, 1 - (o.cropTop + o.cropBottom) / 100);

  let boxH;
  if (overlayMediaDims && overlayMediaEl) {
    const croppedAspect = (overlayMediaDims.w * cropFracW) / (overlayMediaDims.h * cropFracH);
    boxH = boxW / croppedAspect;
    // Scale the media up so its kept region exactly fills the box, and
    // translate so that region's top-left aligns to the box's corner.
    const mediaW = boxW / cropFracW;
    const mediaH = boxH / cropFracH;
    overlayMediaEl.style.width = `${mediaW}px`;
    overlayMediaEl.style.height = `${mediaH}px`;
    overlayMediaEl.style.left = `${-(o.cropLeft / 100) * mediaW}px`;
    overlayMediaEl.style.top = `${-(o.cropTop / 100) * mediaH}px`;
  } else {
    boxH = boxW; // brief pre-load fallback, corrected once dims are known
    if (overlayMediaEl) {
      overlayMediaEl.style.width = '100%';
      overlayMediaEl.style.height = 'auto';
      overlayMediaEl.style.left = '0';
      overlayMediaEl.style.top = '0';
    }
  }

  overlayEl.style.width = `${boxW}px`;
  overlayEl.style.height = `${boxH}px`;
  const centerX = resolvePreviewCenter(o.xPercent, boxW, frameWidth);
  const centerY = resolvePreviewCenter(o.yPercent, boxH, frameHeight);
  setCenterTransform(overlayEl, centerX, centerY, frameWidth, frameHeight);
}

// Range-based visibility + play/pause sync (analogous to tickSfx). A video
// overlay shows the correct frame while the playhead is inside its clip,
// plays only while the editor is playing, and pauses the instant the
// editor pauses. Kept visible while editing so it can be positioned/cropped.
function tickOverlay(outT) {
  if (!state.overlay) return;
  const startOut = sourceToOutput(state.overlay.start);
  const endOut = sourceToOutput(state.overlay.end);
  const inRange = !gap && outT >= startOut && outT < endOut;
  overlayEl.classList.toggle('overlay-hidden', !(inRange || overlayEditing));

  if (!overlayIsVideo || !overlayMediaEl) return;
  if (inRange) {
    const rel = (outT - startOut) / state.speed;
    const dur = overlayMediaEl.duration || 0;
    const target = dur > 0 ? rel % dur : rel;
    if (Math.abs(overlayMediaEl.currentTime - target) > 0.3) {
      try {
        overlayMediaEl.currentTime = target;
      } catch {}
    }
    if (logicalPlaying && overlayMediaEl.paused) overlayMediaEl.play().catch(() => {});
    if (!logicalPlaying && !overlayMediaEl.paused) overlayMediaEl.pause();
  } else if (!overlayMediaEl.paused) {
    overlayMediaEl.pause();
  }
}

function attachOverlayDrag() {
  let dragging = false;
  let startPointer = null;
  let startCenter = null;

  overlayEl.addEventListener('pointerdown', (e) => {
    if (overlayEl.classList.contains('hidden') || overlayEl.classList.contains('overlay-hidden')) return;
    dragging = true;
    overlayEl.setPointerCapture(e.pointerId);
    overlayEl.classList.add('dragging');
    const frameRect = previewFrame.getBoundingClientRect();
    const rect = overlayEl.getBoundingClientRect();
    startPointer = { x: e.clientX, y: e.clientY };
    startCenter = {
      x: (rect.left + rect.right) / 2 - frameRect.left,
      y: (rect.top + rect.bottom) / 2 - frameRect.top,
    };
    e.preventDefault();
  });

  overlayEl.addEventListener('pointermove', (e) => {
    if (!dragging || !state.overlay) return;
    const { width: frameWidth, height: frameHeight } = frameSize();
    const w = overlayEl.offsetWidth;
    const h = overlayEl.offsetHeight;

    let newX = startCenter.x + (e.clientX - startPointer.x);
    let newY = startCenter.y + (e.clientY - startPointer.y);
    newX = Math.min(Math.max(newX, Math.min(w / 2, frameWidth - w / 2)), Math.max(w / 2, frameWidth - w / 2));
    newY = Math.min(Math.max(newY, Math.min(h / 2, frameHeight - h / 2)), Math.max(h / 2, frameHeight - h / 2));

    const snappedX = Math.abs(newX - frameWidth / 2) < POSITION_SNAP_PX;
    const snappedY = Math.abs(newY - frameHeight / 2) < POSITION_SNAP_PX;
    if (snappedX) newX = frameWidth / 2;
    if (snappedY) newY = frameHeight / 2;
    guideX.classList.toggle('visible', snappedX);
    guideY.classList.toggle('visible', snappedY);

    setCenterTransform(overlayEl, newX, newY, frameWidth, frameHeight);
    state.overlay.xPercent = Math.round(resolvePreviewPercent(newX, w, frameWidth));
    state.overlay.yPercent = Math.round(resolvePreviewPercent(newY, h, frameHeight));
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    overlayEl.classList.remove('dragging');
    guideX.classList.remove('visible');
    guideY.classList.remove('visible');
  };
  overlayEl.addEventListener('pointerup', end);
  overlayEl.addEventListener('pointercancel', end);
}

// --- playback ----------------------------------------------------------------

function formatTime(seconds) {
  const total = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// The playback bar reads in OUTPUT time — the edit as it will export,
// cuts collapsed away — matching the timeline's axis, so "0:02 / 0:03"
// means two seconds into the final video, not into the raw source.
function updateTimeLabel() {
  timeLabel.textContent = `${formatTime(getCurrentOutputTime())} / ${formatTime(outputDuration())}`;
}

function syncSeekSliderRange() {
  seekSlider.max = outputDuration() || 0;
}

// --- playback engine ----------------------------------------------------------
//
// Playback follows the OUTPUT timeline. Within a piece the <video> plays
// normally; at a piece boundary (checked every animation frame, with a
// small lookahead so the seek lands just BEFORE the boundary frame
// renders) there are three cases:
//   - next piece continues the same footage (fresh split) -> play through
//   - next piece is different footage, touching in output -> hard cut (seek)
//   - next piece starts later in output (free mode) -> GAP: the videos
//     pause and hide (black frame), a synthetic clock walks the playhead
//     across the gap, then playback resumes at the next piece.
// `logicalPlaying` is the user's intent (the ⏸/▶ state); the video
// elements' own paused state differs from it inside gaps.

const BOUNDARY_LOOKAHEAD_S = 0.045;
const EPS = 0.01;

let logicalPlaying = false;
let gap = null; // { outT, resumeAt (outStart of the piece after the gap) } | null

function setGapVisual(inGap) {
  previewFrame.classList.toggle('in-gap', inGap);
}

function updatePlayButton() {
  playBtn.textContent = logicalPlaying ? '⏸' : '▶';
}

function setLogicalPlaying(playing) {
  logicalPlaying = playing;
  if (playing) {
    if (!gap) {
      fgVideo.play().catch(() => {});
      bgVideo.play().catch(() => {});
    }
  } else {
    fgVideo.pause();
    bgVideo.pause();
  }
  updatePlayButton();
}

// The piece after a given output position, or null.
function nextPieceAfterOutput(outT) {
  let best = null;
  for (const seg of state.segments) {
    if (seg.outStart > outT - EPS && (!best || seg.outStart < best.outStart)) best = seg;
  }
  return best;
}

function enterGap(outT) {
  const next = nextPieceAfterOutput(outT);
  gap = { outT, resumeAt: next ? next.outStart : null };
  fgVideo.pause();
  bgVideo.pause();
  setGapVisual(true);
}

function exitGapTo(piece) {
  gap = null;
  setGapVisual(false);
  fgVideo.currentTime = piece.start;
  if (typeof bgVideo.fastSeek === 'function') bgVideo.fastSeek(piece.start);
  else bgVideo.currentTime = piece.start;
  if (logicalPlaying) {
    fgVideo.play().catch(() => {});
    bgVideo.play().catch(() => {});
  }
}

// Where should playback go from this SOURCE position, given the output
// layout? Returns { seekSrc } | { gapAt } | null (keep playing).
function boundaryAction(srcT) {
  const segs = state.segments;
  if (segs.length === 0) return null;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (srcT < seg.start - EPS) {
      // In cut footage before this piece — jump straight to it.
      return { seekSrc: seg.start };
    }
    if (srcT < seg.end - BOUNDARY_LOOKAHEAD_S) return null; // comfortably inside
    if (srcT < seg.end + EPS) {
      const next = segs[i + 1];
      const outEnd = seg.outStart + (seg.end - seg.start);
      if (!next) return { loop: true };
      if (next.outStart - outEnd > EPS) return { gapAt: outEnd }; // output gap -> black
      if (Math.abs(next.start - seg.end) < EPS) return null; // same footage continues
      return { seekSrc: next.start }; // hard cut
    }
  }
  return { loop: true };
}

export function seek(srcTime) {
  gap = null;
  setGapVisual(false);
  fgVideo.currentTime = srcTime;
  if (typeof bgVideo.fastSeek === 'function') bgVideo.fastSeek(srcTime);
  else bgVideo.currentTime = srcTime;
  if (logicalPlaying && fgVideo.paused) {
    fgVideo.play().catch(() => {});
    bgVideo.play().catch(() => {});
  }
  updateTimeLabel();
  updateFlash(sourceToOutput(srcTime));
  emit('time', { src: srcTime, out: sourceToOutput(srcTime) });
}

// Seek by output position — lands inside a piece normally; in free mode
// it can land in a gap, which parks the playhead on black.
export function seekOutput(outT) {
  const clamped = Math.max(0, Math.min(outT, outputDuration()));
  const piece = pieceAtOutput(clamped);
  if (piece) {
    seek(piece.start + (clamped - piece.outStart));
    return;
  }
  fgVideo.pause();
  bgVideo.pause();
  enterGap(clamped);
  // Park the underlying video at the nearest footage so a later
  // play-from-here has a sane starting frame.
  fgVideo.currentTime = outputToSourceClamped(clamped);
  updateTimeLabel();
  updateFlash(clamped);
  emit('time', { src: fgVideo.currentTime, out: clamped });
}

export function getCurrentTime() {
  return fgVideo.currentTime || 0;
}

export function getCurrentOutputTime() {
  if (gap) return gap.outT;
  return sourceToOutput(fgVideo.currentTime || 0);
}

export function togglePlay() {
  setLogicalPlaying(!logicalPlaying);
}

// --- white flash (dip-to-white transition) preview -----------------------------

// Triangle ramp centered on the boundary: fade to white over the first
// half of the transition, back out over the second — same shape the
// export's two ffmpeg white-fades produce.
function updateFlash(outT) {
  if (!flashEl) return;
  let opacity = 0;
  for (const tr of state.transitions) {
    const seg = state.segments.find((s) => s.id === tr.afterSegmentId);
    if (!seg) continue;
    const boundary = seg.outStart + (seg.end - seg.start);
    const half = tr.duration / 2;
    if (half <= 0) continue;
    opacity = Math.max(opacity, 1 - Math.abs(outT - boundary) / half);
  }
  flashEl.style.opacity = Math.max(0, Math.min(1, opacity)).toFixed(3);
}

// --- sound effect audition -------------------------------------------------------

let sfxAudio = null;
let sfxAudioUrl = null;

function syncSfxAudio() {
  if (!state.sfx || !state.sfx.url) {
    if (sfxAudio) sfxAudio.pause();
    sfxAudio = null;
    sfxAudioUrl = null;
    return;
  }
  if (sfxAudioUrl !== state.sfx.url) {
    if (sfxAudio) sfxAudio.pause();
    sfxAudio = new Audio(state.sfx.url);
    sfxAudioUrl = state.sfx.url;
  }
  sfxAudio.volume = Math.min(1, Math.max(0, state.sfx.volumePercent / 100));
}

// Plays the effect when the output playhead crosses its clip — offset in
// REAL seconds is (output delta) / speed, since the output axis is
// pre-speed concat time but the effect itself plays at natural rate
// (matching the export, which delays but never retimes it).
function tickSfx(outT) {
  if (!sfxAudio || !state.sfx) return;
  const startOut = sourceToOutput(state.sfx.start);
  const rel = (outT - startOut) / state.speed;
  const inRange = logicalPlaying && rel >= 0 && rel < (state.sfx.duration || 0);
  if (inRange && sfxAudio.paused) {
    sfxAudio.currentTime = rel;
    sfxAudio.play().catch(() => {});
  } else if (!inRange && !sfxAudio.paused) {
    sfxAudio.pause();
  }
}

// --- source loading -----------------------------------------------------------

export function attachSource(srcUrl, sourceMeta, { isObjectUrl }) {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
  if (isObjectUrl) previewObjectUrl = srcUrl;

  state.source = { ...sourceMeta, previewUrl: srcUrl, duration: null, width: null, height: null };
  fgVideo.src = srcUrl;
  bgVideo.src = srcUrl;

  fgVideo.addEventListener(
    'loadedmetadata',
    () => {
      state.source.duration = fgVideo.duration || 0;
      state.source.width = fgVideo.videoWidth;
      state.source.height = fgVideo.videoHeight;
      previewFrame.classList.remove('no-source');
      controls.classList.remove('hidden');
      gap = null;
      setGapVisual(false);
      resetSegments();
      resetHistory();
      syncSeekSliderRange();
      seekSlider.value = 0;
      updateTimeLabel();
      emit('source');
      setLogicalPlaying(true);
      updateAll();
    },
    { once: true }
  );
}

export function setPlaceholder(text) {
  placeholder.textContent = text;
}

// --- global refresh -------------------------------------------------------------

function updateAll() {
  fgVideo.style.transform = `scale(${(state.mirror ? -1 : 1) * state.zoom}, ${state.zoom})`;
  bgVideo.style.transform = state.mirror ? 'scaleX(-1)' : 'none';

  if (state.blur > 0) {
    bgVideo.classList.remove('hidden');
    bgVideo.style.filter = `blur(${(state.blur * PREVIEW_BLUR_CSS_SCALE).toFixed(1)}px)`;
  } else {
    bgVideo.classList.add('hidden');
  }

  fgVideo.playbackRate = state.speed;
  bgVideo.playbackRate = state.speed;

  updateOverlay();
  syncLayerEls();
}

export function initPreview() {
  fitPreviewFrame();
  attachOverlayDrag();

  playBtn.addEventListener('click', togglePlay);

  // One rAF loop drives everything playback-position-related: piece
  // boundary handling (cuts, gaps, transitions, loop), the synthetic gap
  // clock, the SFX audition, and the slider/label/playhead/layer updates
  // — 'timeupdate' at ~4Hz made all of these visibly choppy.
  let lastOutTime = -1;
  let lastFrameStamp = performance.now();
  function playbackTick(stamp) {
    requestAnimationFrame(playbackTick);
    const dt = Math.min(0.1, (stamp - lastFrameStamp) / 1000);
    lastFrameStamp = stamp;

    if (gap) {
      if (logicalPlaying) {
        // The gap clock advances in output (pre-speed concat) seconds, so
        // it has to run speed× real time — same rate the video covers
        // output time at playbackRate = speed.
        gap.outT += dt * state.speed;
        if (gap.resumeAt === null) {
          if (gap.outT >= outputDuration() - EPS) seekOutput(0); // trailing gap ends -> loop
        } else if (gap.outT >= gap.resumeAt - EPS) {
          const piece = pieceAtOutput(gap.resumeAt + EPS);
          if (piece) exitGapTo(piece);
          else seekOutput(0);
        }
      }
    } else if (logicalPlaying && !fgVideo.seeking) {
      // Never stack a second seek onto one still in flight — issuing
      // currentTime writes while the decoder is mid-seek is what makes
      // cuts feel janky.
      const action = boundaryAction(fgVideo.currentTime);
      if (action) {
        if (action.loop) {
          seekOutput(0);
        } else if (action.gapAt !== undefined) {
          enterGap(action.gapAt);
        } else if (action.seekSrc !== undefined) {
          fgVideo.currentTime = action.seekSrc;
          // The background copy is blurred to oblivion — a fast keyframe
          // seek is imperceptible there and cheaper than a precise one.
          if (typeof bgVideo.fastSeek === 'function') bgVideo.fastSeek(action.seekSrc);
          else bgVideo.currentTime = action.seekSrc;
        }
      }
    }

    const outT = getCurrentOutputTime();
    updateFlash(outT);
    tickSfx(outT);
    tickOverlay(outT);
    if (outT !== lastOutTime) {
      lastOutTime = outT;
      seekSlider.value = outT;
      updateTimeLabel();
      updateLayerVisibility();
      emit('time', { src: fgVideo.currentTime || 0, out: outT });
    }
  }
  requestAnimationFrame(playbackTick);

  // Slider values are output time (see updateTimeLabel).
  seekSlider.addEventListener('input', () => {
    seekOutput(parseFloat(seekSlider.value));
  });

  // Cutting/trimming changes the output duration the playback bar spans —
  // and can strand the playhead inside a freshly-made gap or past the new
  // end; the next tick's boundaryAction handles that.
  on('segments', () => {
    syncSeekSliderRange();
    updateTimeLabel();
  });
  on('settings', syncSfxAudio);

  // Only the foreground's mute toggles — the background copy plays the
  // same source and unmuting both would phase/echo. Starting muted keeps
  // autoplay working; this click is itself the unmute gesture.
  muteBtn.addEventListener('click', () => {
    fgVideo.muted = !fgVideo.muted;
    muteBtn.textContent = fgVideo.muted ? '🔇' : '🔊';
  });

  // Clicking empty preview space deselects, dropping the panel back to
  // video settings — same interaction CapCut uses.
  previewFrame.addEventListener('pointerdown', (e) => {
    if (e.target === previewFrame || e.target === fgVideo || e.target === bgVideo) {
      selectLayer(null);
    }
  });

  on('settings', () => {
    fitPreviewFrame();
    updateAll();
  });
  on('layers', syncLayerEls);
  on('selection', syncLayerEls);
  on('time', updateLayerVisibility);
  window.addEventListener('resize', () => {
    fitPreviewFrame();
    updateAll();
  });
}
