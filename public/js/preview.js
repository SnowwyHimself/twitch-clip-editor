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

import { icon } from './icons.js';
import {
  state,
  on,
  emit,
  isSelected,
  selectLayer,
  selectOverlay,
  selectSegment,
  selectedSegment,
  resetSegments,
  resetHistory,
  sourceDuration,
  outputDuration,
  primaryOutputDuration,
  appendedAtOutput,
  sourceToOutput,
  outputToSourceClamped,
  pieceAtOutput,
  keyframeTransformAt,
  addKeyframe,
  clampCropValue,
  clampWrapWidth,
  faceTrackActive,
  faceTrackAt,
  faceTrackZoom,
  pieceSettingsAtOutput,
  pieceRefAtOutput,
  commitVideoSettings,
} from './state.js';

const previewArea = document.getElementById('preview-area');
const previewFrame = document.getElementById('preview-frame');
const bgVideo = document.getElementById('preview-bg-video');
const fgVideo = document.getElementById('preview-fg-video');
const placeholder = document.getElementById('preview-placeholder');
const guideX = document.getElementById('preview-guide-x');
const guideY = document.getElementById('preview-guide-y');
const overlaysContainer = document.getElementById('preview-overlays');
const layersContainer = document.getElementById('text-layers');
const splitTop = document.getElementById('split-top');
const splitBottom = document.getElementById('split-bottom');
const splitTopVideo = splitTop.querySelector('.split-video');
const splitBottomVideo = splitBottom.querySelector('.split-video');
const splitDivider = document.getElementById('split-divider');
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
  montserrat: '"Montserrat SemiBold Preview", sans-serif',
  poppins: '"Poppins ExtraBold Preview", sans-serif',
  manrope: '"Manrope ExtraBold Preview", sans-serif',
  'archivo-black': '"Archivo Black Preview", sans-serif',
  anton: '"Anton Preview", sans-serif',
  'bebas-neue': '"Bebas Neue Preview", sans-serif',
  'fjalla-one': '"Fjalla One Preview", sans-serif',
  kanit: '"Kanit Bold Preview", sans-serif',
  'alfa-slab-one': '"Alfa Slab One Preview", serif',
  'titan-one': '"Titan One Preview", sans-serif',
  'paytone-one': '"Paytone One Preview", sans-serif',
  righteous: '"Righteous Preview", sans-serif',
  bangers: '"Bangers Preview", cursive',
  'luckiest-guy': '"Luckiest Guy Preview", cursive',
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
  // One unified rounded box behind the whole wrapped block, sized to the
  // union of the line rects (widest line sets the width, first/last line the
  // height). Per-line pills used to leave a visible gap between lines of
  // different widths; a single box can't — it's always one solid shape.
  const range = document.createRange();
  range.selectNodeContents(innerEl);
  const rects = mergeSameRowRects(Array.from(range.getClientRects()));
  if (rects.length === 0) return;

  const containerRect = captionEl.getBoundingClientRect();
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }

  const box = document.createElement('div');
  box.style.position = 'absolute';
  box.style.left = `${(left - containerRect.left - paddingXPx).toFixed(2)}px`;
  box.style.top = `${(top - containerRect.top - paddingYPx).toFixed(2)}px`;
  box.style.width = `${(right - left + paddingXPx * 2).toFixed(2)}px`;
  box.style.height = `${(bottom - top + paddingYPx * 2).toFixed(2)}px`;
  box.style.background = boxColor;
  box.style.borderRadius = `${radiusPx.toFixed(2)}px`;
  fillersEl.appendChild(box);
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
  // Left/right wrap-width handles (CapCut-style) — shown only while the layer
  // is selected (via the .selected class), drag them to set this layer's own
  // wrap width so the text wraps sooner/later.
  for (const side of ['w', 'e']) {
    const handle = document.createElement('div');
    handle.className = `caption-handle caption-handle-${side}`;
    root.appendChild(handle);
    attachWrapResize(handle, root, layer.id);
  }
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

  root.classList.toggle('selected', isSelected('layer', layer.id));
  root.classList.toggle('style-box', layer.style === 'box');
  inner.style.fontFamily = PREVIEW_FONT_CSS_FAMILY[layer.fontId] || PREVIEW_FONT_CSS_FAMILY.montserrat;
  inner.innerHTML = captionHtml(layer.text);

  const fontSizePx = layer.fontSize * scale;
  inner.style.fontSize = `${fontSizePx.toFixed(2)}px`;
  inner.style.lineHeight = String(PREVIEW_LINE_HEIGHT_RATIO);
  // Per-layer wrap width (fraction of canvas width). The server's opentype
  // word-wrap wraps at canvasWidth*wrapRatio, so the preview must wrap at
  // frameWidth*wrapRatio for identical line breaks. An absolutely-positioned
  // auto-width block shrink-to-fits BELOW its max-width, wrapping text earlier
  // than the render (and never reaching the canvas edge). Fix it by measuring
  // the text's natural unwrapped width and pinning the box to
  // min(natural, wrapPx): short text still hugs (and can sit flush to an edge),
  // long text wraps exactly at the canvas-derived limit, matching ffmpeg.
  const wrapRatio = clampWrapWidth(layer.wrapWidth);
  const wrapPx = frameWidth * wrapRatio;
  root.style.maxWidth = 'none';
  root.style.width = 'max-content';
  const naturalPx = root.offsetWidth; // reflow at the unwrapped width
  root.style.width = `${Math.min(naturalPx, wrapPx).toFixed(2)}px`;

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
  // Cache the settled center so the per-frame entrance animation can offset
  // from it without re-measuring the box each frame.
  entry.baseCenter = { x: centerX, y: centerY };
  if (layer.group === 'caption' && (layer.animation || 'none') !== 'none') {
    applyCaptionEntrance(layer, entry, fgVideo.currentTime || 0);
  } else {
    root.style.opacity = '';
    setCenterTransform(root, centerX, centerY, frameWidth, frameHeight);
  }
}

// Caption entrance animation, applied per-frame. 'fade' ramps opacity 0->1 over
// the first CAP_ANIM_DURATION seconds after the caption's start; 'slide' also
// eases it up from CAP_SLIDE_FRAC of the canvas height. Matches the export's
// overlay fade-alpha + y t-expression. Before the caption's start (only shown
// when selected for editing) it sits settled at full opacity.
const CAP_ANIM_DURATION = 0.25;
const CAP_SLIDE_FRAC = 0.04;
function applyCaptionEntrance(layer, entry, srcT) {
  const base = entry.baseCenter;
  if (!base) return;
  const { width, height } = frameSize();
  const anim = layer.animation || 'none';
  if (anim === 'none' || srcT < layer.start) {
    entry.root.style.opacity = '';
    setCenterTransform(entry.root, base.x, base.y, width, height);
    return;
  }
  const p = Math.min(1, (srcT - layer.start) / CAP_ANIM_DURATION);
  entry.root.style.opacity = p.toFixed(3);
  const slide = anim === 'slide' ? (1 - p) * height * CAP_SLIDE_FRAC : 0;
  setCenterTransform(entry.root, base.x, base.y + slide, width, height);
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
    const hiddenByToggle = state.captionsHidden && layer.group === 'caption';
    const inRange = !gap && t >= layer.start && t < layer.end;
    const visible = !hiddenByToggle && (inRange || isSelected('layer', layer.id));
    entry.root.classList.toggle('time-hidden', !visible);
    if (visible && layer.group === 'caption' && (layer.animation || 'none') !== 'none') {
      applyCaptionEntrance(layer, entry, t);
    }
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

// Drag a side handle to set THIS layer's wrap width. The box stays centered on
// its position, so a handle at distance d from the center sets a full wrap
// width of 2·d (in canvas-fraction terms). Writes layer.wrapWidth live during
// the drag and re-renders on release (same pattern as attachLayerDrag).
function attachWrapResize(handle, root, layerId) {
  let dragging = false;
  let start = null;

  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); // don't start a layer-position drag
    e.preventDefault();
    selectLayer(layerId);
    const rect = root.getBoundingClientRect();
    start = { centerX: (rect.left + rect.right) / 2, frameWidth: frameSize().width };
    dragging = true;
    // setPointerCapture throws on synthetic test PointerEvents — real ones are
    // fine; capture start-state first so a throw can't wedge the drag.
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const halfWidthPx = Math.abs(e.clientX - start.centerX);
    const ratio = clampWrapWidth((halfWidthPx * 2) / Math.max(1, start.frameWidth));
    const layer = state.layers.find((l) => l.id === layerId);
    if (!layer) return;
    layer.wrapWidth = ratio; // written live; full re-render on release
    updateLayerEl(layer);
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    emit('layers');
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// --- media overlays (image/video, rendered above the video) ------------------
// Each overlay in state.overlays gets its own absolutely-positioned,
// crop-clipped element, draggable to position, shown while the playhead is
// in its range (or while it's selected, for editing). A video overlay
// plays/pauses in sync with the editor.

const overlayEls = new Map(); // id -> { root, media, url, dims, isVideo }

function createOverlayEl(o) {
  const root = document.createElement('div');
  root.className = 'preview-overlay';
  root.dataset.id = o.id;
  const media = document.createElement(o.isVideo ? 'video' : 'img');
  if (o.isVideo) {
    // Muted (overlay audio is never mapped into the render), looped so a
    // short clip fills a longer range, driven manually by tickOverlays —
    // NOT autoplay — so it plays/pauses in lockstep with the editor.
    media.muted = true;
    media.loop = true;
    media.playsInline = true;
  }
  const url = URL.createObjectURL(o.file);
  const entry = { root, media, url, dims: null, isVideo: o.isVideo };
  media.addEventListener(
    o.isVideo ? 'loadedmetadata' : 'load',
    () => {
      entry.dims = o.isVideo
        ? { w: media.videoWidth, h: media.videoHeight }
        : { w: media.naturalWidth, h: media.naturalHeight };
      // Video length feeds the timeline's clip-length clamp and export.
      if (o.isVideo && media.duration) o.duration = media.duration;
      layoutOverlayEl(o);
    },
    { once: true }
  );
  media.src = url;
  root.appendChild(media);
  // Corner resize handles — shown only while the overlay is selected (see the
  // .selected toggle in tickOverlays). Dragging one scales the overlay from
  // its center, so you size it by grabbing a corner instead of the slider.
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('div');
    handle.className = `overlay-handle overlay-handle-${corner}`;
    root.appendChild(handle);
    attachOverlayResize(handle, root, o.id);
  }
  // Edge crop handles — pull an edge inward to crop that side (iOS photo-crop
  // style), writing the same cropTop/Bottom/Left/Right the sliders do. Corners
  // resize, edges crop.
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const handle = document.createElement('div');
    handle.className = `overlay-crop-handle overlay-crop-${edge}`;
    root.appendChild(handle);
    attachOverlayCrop(handle, root, o.id, edge);
  }
  overlaysContainer.appendChild(root);
  attachOverlayDrag(root, o.id);
  overlayEls.set(o.id, entry);
  return entry;
}

// Reconciles the overlay elements with state.overlays (create new, drop
// removed), then lays them out — the same create/update/remove pattern as
// text layers.
function syncOverlayEls() {
  const ids = new Set(state.overlays.map((o) => o.id));
  for (const [id, entry] of overlayEls) {
    if (!ids.has(id)) {
      URL.revokeObjectURL(entry.url);
      entry.root.remove();
      overlayEls.delete(id);
    }
  }
  for (const o of state.overlays) {
    if (!overlayEls.has(o.id)) createOverlayEl(o);
    layoutOverlayEl(o);
  }
  tickOverlays(getCurrentOutputTime());
}

// Sizes/positions one overlay. sizePercent is the MEDIA's display width (as a
// fraction of the frame) and stays constant as you crop — cropping just trims
// a smaller window out of the media (iOS photo-crop behaviour), it never zooms
// or grows it. The box (overflow-hidden) is that trimmed window; the media
// sits full-size inside, shifted so the kept region shows through.
function layoutOverlayEl(o) {
  const entry = overlayEls.get(o.id);
  if (!entry) return;
  const { root, media, dims } = entry;
  const { width: frameWidth, height: frameHeight } = frameSize();
  const cropFracW = Math.max(0.02, 1 - (o.cropLeft + o.cropRight) / 100);
  const cropFracH = Math.max(0.02, 1 - (o.cropTop + o.cropBottom) / 100);
  const mediaW = frameWidth * (o.sizePercent / 100); // constant w.r.t. crop

  let boxW;
  let boxH;
  if (dims) {
    const mediaH = mediaW * (dims.h / dims.w);
    boxW = mediaW * cropFracW;
    boxH = mediaH * cropFracH;
    media.style.width = `${mediaW}px`;
    media.style.height = `${mediaH}px`;
    media.style.left = `${-(o.cropLeft / 100) * mediaW}px`;
    media.style.top = `${-(o.cropTop / 100) * mediaH}px`;
  } else {
    // brief pre-load fallback, corrected once natural dims are known
    boxW = mediaW * cropFracW;
    boxH = mediaW * cropFracH;
    media.style.width = `${mediaW}px`;
    media.style.height = 'auto';
    media.style.left = `${-(o.cropLeft / 100) * mediaW}px`;
    media.style.top = '0';
  }

  root.style.width = `${boxW}px`;
  root.style.height = `${boxH}px`;
  const centerX = resolvePreviewCenter(o.xPercent, boxW, frameWidth);
  const centerY = resolvePreviewCenter(o.yPercent, boxH, frameHeight);
  setCenterTransform(root, centerX, centerY, frameWidth, frameHeight);
}

// Per-frame for every overlay: visibility (in range OR selected) and, for
// video overlays, currentTime + play/pause synced to the editor.
function tickOverlays(outT) {
  for (const o of state.overlays) {
    const entry = overlayEls.get(o.id);
    if (!entry) continue;
    const startOut = sourceToOutput(o.start);
    const endOut = sourceToOutput(o.end);
    const inRange = !gap && outT >= startOut && outT < endOut;
    const selected = isSelected('overlay', o.id);
    entry.root.classList.toggle('overlay-hidden', !(inRange || selected));
    entry.root.classList.toggle('selected', selected); // shows the resize handles

    if (!entry.isVideo) continue;
    if (inRange) {
      const target = (o.offset || 0) + (outT - startOut) / state.speed;
      if (Math.abs(entry.media.currentTime - target) > 0.3) {
        try {
          entry.media.currentTime = target;
        } catch {}
      }
      if (logicalPlaying && entry.media.paused) entry.media.play().catch(() => {});
      if (!logicalPlaying && !entry.media.paused) entry.media.pause();
    } else if (!entry.media.paused) {
      entry.media.pause();
    }
  }
}

function attachOverlayDrag(root, id) {
  let dragging = false;
  let startPointer = null;
  let startCenter = null;

  root.addEventListener('pointerdown', (e) => {
    if (root.classList.contains('overlay-hidden')) return;
    selectOverlay(id);
    dragging = true;
    root.setPointerCapture(e.pointerId);
    root.classList.add('dragging');
    const frameRect = previewFrame.getBoundingClientRect();
    const rect = root.getBoundingClientRect();
    startPointer = { x: e.clientX, y: e.clientY };
    startCenter = {
      x: (rect.left + rect.right) / 2 - frameRect.left,
      y: (rect.top + rect.bottom) / 2 - frameRect.top,
    };
    e.preventDefault();
  });

  root.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const o = state.overlays.find((x) => x.id === id);
    if (!o) return;
    const { width: frameWidth, height: frameHeight } = frameSize();
    const w = root.offsetWidth;
    const h = root.offsetHeight;

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

    setCenterTransform(root, newX, newY, frameWidth, frameHeight);
    o.xPercent = Math.round(resolvePreviewPercent(newX, w, frameWidth));
    o.yPercent = Math.round(resolvePreviewPercent(newY, h, frameHeight));
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('dragging');
    guideX.classList.remove('visible');
    guideY.classList.remove('visible');
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
}

// Corner-handle resize: scales the overlay from its (fixed) center, so
// dragging any corner grows/shrinks the box with its aspect ratio locked
// (height follows from the media's cropped aspect in layoutOverlayEl). The
// visual center is captured on grab and re-planted every move, so resizing
// never nudges the overlay's position.
function attachOverlayResize(handle, root, id) {
  let resizing = false;
  let center = null; // { x, y } in frame-relative px, fixed for the gesture

  handle.addEventListener('pointerdown', (e) => {
    if (root.classList.contains('overlay-hidden')) return;
    e.stopPropagation(); // don't also start a move-drag on the root
    selectOverlay(id);
    resizing = true;
    const frameRect = previewFrame.getBoundingClientRect();
    const rect = root.getBoundingClientRect();
    center = {
      x: (rect.left + rect.right) / 2 - frameRect.left,
      y: (rect.top + rect.bottom) / 2 - frameRect.top,
    };
    root.classList.add('resizing');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {}
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const o = state.overlays.find((x) => x.id === id);
    if (!o) return;
    const { width: frameWidth, height: frameHeight } = frameSize();
    const frameRect = previewFrame.getBoundingClientRect();
    const pointerX = e.clientX - frameRect.left;
    // Center-anchored: half the box width is the pointer's distance from the
    // center, so the grabbed corner tracks the cursor horizontally. sizePercent
    // is the media width, so divide the target box width by the horizontal crop
    // fraction to recover it (a cropped overlay's box is smaller than its media).
    const cropFracW = Math.max(0.02, 1 - (o.cropLeft + o.cropRight) / 100);
    const halfW = Math.abs(pointerX - center.x);
    let sizePercent = Math.round((((halfW * 2) / cropFracW) / frameWidth) * 100);
    sizePercent = Math.min(100, Math.max(5, sizePercent));
    o.sizePercent = sizePercent;
    // Lay out at the new size, then re-plant the captured center and store
    // the position percents that correspond to it at this size.
    layoutOverlayEl(o);
    o.xPercent = Math.round(resolvePreviewPercent(center.x, root.offsetWidth, frameWidth));
    o.yPercent = Math.round(resolvePreviewPercent(center.y, root.offsetHeight, frameHeight));
    setCenterTransform(root, center.x, center.y, frameWidth, frameHeight);
  });

  const end = () => {
    if (!resizing) return;
    resizing = false;
    root.classList.remove('resizing');
    emit('settings'); // records history + refreshes the Overlay panel slider
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// Edge crop handle: dragging an edge inward trims that side of the media,
// mapping pixels dragged to a percentage of the media's own size (captured at
// grab so the reshaping box doesn't feed back), clamped via the same shared
// helper the crop sliders use.
function attachOverlayCrop(handle, root, id, edge) {
  let cropping = false;
  let start = null;

  handle.addEventListener('pointerdown', (e) => {
    if (root.classList.contains('overlay-hidden')) return;
    e.stopPropagation();
    selectOverlay(id);
    const o = state.overlays.find((x) => x.id === id);
    if (!o) return;
    cropping = true;
    const cropFracW = Math.max(0.02, 1 - (o.cropLeft + o.cropRight) / 100);
    const cropFracH = Math.max(0.02, 1 - (o.cropTop + o.cropBottom) / 100);
    start = {
      x: e.clientX,
      y: e.clientY,
      cropTop: o.cropTop,
      cropBottom: o.cropBottom,
      cropLeft: o.cropLeft,
      cropRight: o.cropRight,
      mediaW: root.offsetWidth / cropFracW, // full (uncropped) media px at this scale
      mediaH: root.offsetHeight / cropFracH,
    };
    root.classList.add('cropping');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {}
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!cropping) return;
    const o = state.overlays.find((x) => x.id === id);
    if (!o) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    let key;
    let raw;
    if (edge === 'left') {
      key = 'cropLeft';
      raw = start.cropLeft + (dx / start.mediaW) * 100;
    } else if (edge === 'right') {
      key = 'cropRight';
      raw = start.cropRight + (-dx / start.mediaW) * 100;
    } else if (edge === 'top') {
      key = 'cropTop';
      raw = start.cropTop + (dy / start.mediaH) * 100;
    } else {
      key = 'cropBottom';
      raw = start.cropBottom + (-dy / start.mediaH) * 100;
    }
    o[key] = clampCropValue(o, key, raw);
    layoutOverlayEl(o);
  });

  const end = () => {
    if (!cropping) return;
    cropping = false;
    root.classList.remove('cropping');
    emit('settings'); // records + syncs the crop sliders to match
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
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

// Sequential multi-source: which source URL fg/bg currently hold, and — when
// the playhead is over an appended clip — that clip + its output offset. Both
// stay inert (null / primary URL) with no appended clips, so single-source
// playback is unchanged.
let loadedPreviewUrl = null;
let activeAppended = null; // { clip, outStart } | null

// Swap fg/bg to `url` (if not already loaded) and run `after` once it's ready
// to seek. For the same URL it runs immediately.
function loadPreviewUrlThen(url, after) {
  if (loadedPreviewUrl === url) {
    after();
    return;
  }
  loadedPreviewUrl = url;
  const onReady = () => {
    fgVideo.removeEventListener('loadedmetadata', onReady);
    after();
  };
  fgVideo.addEventListener('loadedmetadata', onReady);
  fgVideo.src = url;
  bgVideo.src = url;
}

// Restores the primary source into fg/bg (used when seeking back out of an
// appended clip). Does not seek — the caller does.
function ensurePrimaryLoaded() {
  activeAppended = null;
  const url = state.source && state.source.previewUrl;
  if (url && loadedPreviewUrl !== url) {
    loadedPreviewUrl = url;
    fgVideo.src = url;
    bgVideo.src = url;
    return false; // needs a moment to load
  }
  return true;
}

function setGapVisual(inGap) {
  previewFrame.classList.toggle('in-gap', inGap);
}

function updatePlayButton() {
  playBtn.innerHTML = icon(logicalPlaying ? 'pause' : 'play');
}

function setLogicalPlaying(playing) {
  logicalPlaying = playing;
  if (playing) {
    if (!gap) {
      fgVideo.play().catch(() => {});
      bgVideo.play().catch(() => {});
      if (splitActive()) {
        splitTopVideo.play().catch(() => {});
        splitBottomVideo.play().catch(() => {});
      }
    }
  } else {
    fgVideo.pause();
    bgVideo.pause();
    splitTopVideo.pause();
    splitBottomVideo.pause();
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

function finishSeek(srcTime) {
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

// Primary-source seek (source time). If we'd swapped fg/bg onto an appended
// clip, bring the primary back first (then seek once it's loaded).
export function seek(srcTime) {
  gap = null;
  setGapVisual(false);
  const primaryUrl = state.source && state.source.previewUrl;
  if (primaryUrl && (activeAppended || loadedPreviewUrl !== primaryUrl)) {
    activeAppended = null;
    loadPreviewUrlThen(primaryUrl, () => {
      finishSeek(srcTime);
      updateAll();
    });
    return;
  }
  finishSeek(srcTime);
}

// Positions fg/bg on an appended clip and seeks to a local time within it.
function seekAppended(item, localT) {
  gap = null;
  setGapVisual(false);
  activeAppended = { clip: item.clip, outStart: item.outStart };
  const outT = item.outStart + (localT - item.clip.start);
  loadPreviewUrlThen(item.clip.source.previewUrl, () => {
    fgVideo.currentTime = localT;
    if (typeof bgVideo.fastSeek === 'function') bgVideo.fastSeek(localT);
    else bgVideo.currentTime = localT;
    if (logicalPlaying && fgVideo.paused) {
      fgVideo.play().catch(() => {});
      bgVideo.play().catch(() => {});
    }
    updateAll();
    updateTimeLabel();
    updateFlash(outT);
    emit('time', { src: localT, out: outT });
  });
}

// Seek by output position — lands inside a primary piece, an appended clip, or
// (primary free mode) a gap that parks the playhead on black.
export function seekOutput(outT) {
  const clamped = Math.max(0, Math.min(outT, outputDuration()));
  const item = state.appendedClips.length ? appendedAtOutput(clamped) : null;
  if (item) {
    seekAppended(item, item.clip.start + (clamped - item.outStart));
    return;
  }
  const piece = pieceAtOutput(clamped);
  if (piece) {
    seek(piece.start + (clamped - piece.outStart));
    return;
  }
  activeAppended = null;
  if (state.source && loadedPreviewUrl !== state.source.previewUrl) {
    loadedPreviewUrl = state.source.previewUrl;
    fgVideo.src = bgVideo.src = state.source.previewUrl;
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
  // While an appended clip is loaded, output time is its offset plus how far
  // into the clip we are (fg holds the appended source, not the primary).
  if (activeAppended) {
    return activeAppended.outStart + ((fgVideo.currentTime || 0) - activeAppended.clip.start);
  }
  if (gap) return gap.outT;
  return sourceToOutput(fgVideo.currentTime || 0);
}

export function togglePlay() {
  setLogicalPlaying(!logicalPlaying);
}

// Stops logical playback so a task (e.g. face tracking) can seek the video
// frame-by-frame without the rAF loop fighting it with boundary seeks.
export function pausePlayback() {
  setLogicalPlaying(false);
}

// --- white flash (dip-to-white transition) preview -----------------------------

// Triangle ramp centered on the boundary: fade to white over the first
// half of the transition, back out over the second — same shape the
// export's two ffmpeg white-fades produce.
function updateFlash(outT) {
  if (!flashEl) return;
  let opacity = 0;
  let color = '#fff';
  for (const tr of state.transitions) {
    const seg = state.segments.find((s) => s.id === tr.afterSegmentId);
    if (!seg) continue;
    const boundary = seg.outStart + (seg.end - seg.start);
    const half = tr.duration / 2;
    if (half <= 0) continue;
    const o = 1 - Math.abs(outT - boundary) / half;
    if (o > opacity) {
      opacity = o;
      color = tr.type === 'black-flash' ? '#000' : '#fff';
    }
  }
  flashEl.style.background = color;
  flashEl.style.opacity = Math.max(0, Math.min(1, opacity)).toFixed(3);
}

// --- sound audition -------------------------------------------------------------
// One <Audio> per sound clip, reconciled with state.sounds. Each plays
// while the output playhead is inside its clip; its offset (how far into
// the file the clip starts) plus the elapsed real time gives the audio
// position — matching the export, which delays and trims but never retimes.

const soundAudios = new Map(); // sound.id -> { audio, url }

function syncSoundAudios() {
  const ids = new Set(state.sounds.map((s) => s.id));
  for (const [id, entry] of soundAudios) {
    if (!ids.has(id)) {
      entry.audio.pause();
      soundAudios.delete(id);
    }
  }
  for (const s of state.sounds) {
    let entry = soundAudios.get(s.id);
    if (!entry || entry.url !== s.url) {
      if (entry) entry.audio.pause();
      entry = { audio: new Audio(s.url), url: s.url };
      soundAudios.set(s.id, entry);
    }
    // Preview can't boost past 100% (HTML media caps volume at 1); the export
    // applies the true 0-200%. Fades are layered on per-frame in tickSounds.
    entry.audio.muted = !!s.muted;
    entry.audio.volume = Math.min(1, Math.max(0, s.volumePercent / 100));
  }
}

// Auto-ducking: a ducked sound drops to DUCK_FACTOR of its volume while speech
// is on screen. Speech ranges are the caption layers (the transcript) — no
// separate VAD. Skipped when captions are hidden (no ranges then, matching
// export). MUST equal the server's DUCK_FACTOR for preview/export parity.
const DUCK_FACTOR = 0.3;
function speechActiveAt(outT) {
  if (state.captionsHidden) return false;
  for (const l of state.layers) {
    if (l.group !== 'caption') continue;
    if (outT >= sourceToOutput(l.start) && outT < sourceToOutput(l.end)) return true;
  }
  return false;
}

// Linear fade envelope (matches ffmpeg afade's default 'tri' curve): ramps
// 0->1 over the first `fadeIn` s and 1->0 over the last `fadeOut` s.
function fadeGain(t, duration, fadeIn, fadeOut) {
  let g = 1;
  if (fadeIn > 0 && t < fadeIn) g = Math.max(0, t / fadeIn);
  if (fadeOut > 0 && duration > 0 && t > duration - fadeOut) {
    g = Math.min(g, Math.max(0, (duration - t) / fadeOut));
  }
  return g;
}

// The main clip's monitor mute (the 🔊 button) is independent of the exported
// mute (state.audio.muted): the element is silenced if EITHER is on, and its
// volume tracks the clip volume (capped at 1 for preview; export boosts) with
// the head/tail fade envelope layered on at the current time.
let monitorMuted = true; // fgVideo starts muted so autoplay works
function clipBaseVolume() {
  return Math.min(1, Math.max(0, state.audio.volumePercent / 100));
}
function syncClipAudio() {
  fgVideo.muted = monitorMuted || state.audio.muted;
  const env = fadeGain(getCurrentOutputTime(), outputDuration(), state.audio.fadeIn || 0, state.audio.fadeOut || 0);
  fgVideo.volume = Math.min(1, Math.max(0, clipBaseVolume() * env));
}

function tickSounds(outT) {
  for (const s of state.sounds) {
    const entry = soundAudios.get(s.id);
    if (!entry) continue;
    const startOut = sourceToOutput(s.start);
    const endOut = sourceToOutput(s.end);
    const inRange = logicalPlaying && !gap && outT >= startOut && outT < endOut;
    if (inRange) {
      const target = (s.offset || 0) + (outT - startOut) / state.speed;
      if (Math.abs(entry.audio.currentTime - target) > 0.3) {
        try {
          entry.audio.currentTime = target;
        } catch {}
      }
      // Layer the fade envelope on the base volume, over the sound's own span,
      // and duck under speech (caption ranges) when enabled.
      const env = fadeGain(outT - startOut, endOut - startOut, s.fadeIn || 0, s.fadeOut || 0);
      const duck = s.duck && speechActiveAt(outT) ? DUCK_FACTOR : 1;
      entry.audio.volume = Math.min(1, Math.max(0, (s.volumePercent / 100) * env * duck));
      if (entry.audio.paused) entry.audio.play().catch(() => {});
    } else if (!entry.audio.paused) {
      entry.audio.pause();
    }
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
  loadedPreviewUrl = srcUrl; // which URL fg/bg currently hold (multi-source)
  activeAppended = null;

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
  // Write status/error text into the title line only, so the empty-state icon,
  // hint, and recent-projects list keep their structure.
  const titleEl = placeholder.querySelector('#preview-empty-title');
  if (titleEl) titleEl.textContent = text;
  else placeholder.textContent = text;
}

// --- global refresh -------------------------------------------------------------

// The clip's live transform: the interpolated keyframe value at the current
// source time when keyframes exist (keyframes stay global), otherwise the
// zoom/pan of the piece currently under the playhead (B6 per-piece settings).
function currentClipTransform() {
  const kf = keyframeTransformAt(fgVideo.currentTime || 0);
  if (kf) return kf;
  const s = pieceSettingsAtOutput(getCurrentOutputTime());
  return { zoom: s.zoom, panX: s.panX, panY: s.panY };
}

// Applies just the foreground zoom/pan transform (called every frame while
// keyframes drive it, and once per settings/scrub otherwise). Pan translates
// the foreground over the (blurred/black) background, in frame pixels: panX/
// panY are % of half the frame. translate is listed before scale so it's
// applied in unmirrored frame space (a negative-x mirror never flips pan).
function applyClipTransform() {
  const { width: frameW, height: frameH } = frameSize();
  // Face-tracking reframe: the clip fills the frame (object-fit cover) and pans
  // LEFT/RIGHT only via object-position, following the tracked face; object-fit
  // cover guarantees it's always fully filled (no black bars). Depth zoom (z)
  // scales in for a tighter shot. This overrides the normal pan-over-blur.
  if (faceTrackActive()) {
    const ft = faceTrackAt(fgVideo.currentTime || 0) || { x: 0.5 };
    const posX = Math.max(0, Math.min(100, ft.x * 100));
    const z = faceTrackZoom();
    fgVideo.style.objectFit = 'cover';
    fgVideo.style.objectPosition = `${posX.toFixed(2)}% 50%`;
    // Tighter tracked shot: scale up around the face point (which object-position
    // has placed at posX% / 50% of the frame), so the crop stays face-centred.
    // Mirrors the export's crop=canvas/zoom window (buildFaceTrackBase).
    fgVideo.style.transformOrigin = `${posX.toFixed(2)}% 50%`;
    const flip = state.mirror ? -1 : 1;
    fgVideo.style.transform = z > 1 ? `scale(${flip * z}, ${z})` : state.mirror ? 'scaleX(-1)' : 'none';
    return;
  }
  fgVideo.style.transformOrigin = '';
  fgVideo.style.objectFit = '';
  fgVideo.style.objectPosition = '';
  const { zoom, panX, panY } = currentClipTransform();
  const tx = (panX / 100) * (frameW / 2);
  const ty = (panY / 100) * (frameH / 2);
  fgVideo.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${(state.mirror ? -1 : 1) * zoom}, ${zoom})`;
}

// --- facecam split layout ---------------------------------------------------

function splitActive() {
  return state.layout === 'split' && !!state.source;
}

// Source-space crop window for one region: the largest window of the region's
// aspect, divided by zoom, centred at (cx,cy), clamped to the source. This
// exact formula is mirrored in the ffmpeg export so preview and render match.
function splitCropWindow(srcW, srcH, regionAspect, region) {
  const baseW = Math.min(srcW, srcH * regionAspect);
  const cropW = baseW / Math.max(1, region.zoom || 1);
  const cropH = cropW / regionAspect;
  const winX = Math.max(0, Math.min(srcW - cropW, (region.cx || 0.5) * srcW - cropW / 2));
  const winY = Math.max(0, Math.min(srcH - cropH, (region.cy || 0.5) * srcH - cropH / 2));
  return { cropW, cropH, winX, winY };
}

// Lays one region's video into its overflow-hidden box so it shows exactly the
// crop window — same absolute-size-and-offset construction the overlay crop
// uses, which maps 1:1 to ffmpeg crop+scale. Returns the display scale.
function layoutSplitRegion(box, video, srcW, srcH, regionW, regionH, region) {
  box.style.width = `${regionW}px`;
  box.style.height = `${regionH}px`;
  if (!srcW || !srcH || regionH <= 0) return 1;
  const { cropW, winX, winY } = splitCropWindow(srcW, srcH, regionW / regionH, region);
  const scale = regionW / cropW;
  video.style.width = `${(srcW * scale).toFixed(2)}px`;
  video.style.height = `${(srcH * scale).toFixed(2)}px`;
  video.style.left = `${(-winX * scale).toFixed(2)}px`;
  video.style.top = `${(-winY * scale).toFixed(2)}px`;
  return scale;
}

function syncSplit() {
  const active = splitActive();
  splitTop.classList.toggle('hidden', !active);
  splitBottom.classList.toggle('hidden', !active);
  splitDivider.classList.toggle('hidden', !active);
  fgVideo.classList.toggle('split-hidden', active);
  if (!active) {
    if (!splitTopVideo.paused) splitTopVideo.pause();
    if (!splitBottomVideo.paused) splitBottomVideo.pause();
    return;
  }
  if (splitTopVideo.src !== fgVideo.src) splitTopVideo.src = fgVideo.src;
  if (splitBottomVideo.src !== fgVideo.src) splitBottomVideo.src = fgVideo.src;
  const { width: frameW, height: frameH } = frameSize();
  const srcW = (state.source && state.source.width) || fgVideo.videoWidth;
  const srcH = (state.source && state.source.height) || fgVideo.videoHeight;
  const ratio = Math.max(0.15, Math.min(0.85, state.split.ratio));
  const topH = Math.round(frameH * ratio);
  splitTop.style.top = '0px';
  layoutSplitRegion(splitTop, splitTopVideo, srcW, srcH, frameW, topH, state.split.facecam);
  splitBottom.style.top = `${topH}px`;
  layoutSplitRegion(splitBottom, splitBottomVideo, srcW, srcH, frameW, frameH - topH, state.split.gameplay);
  splitDivider.style.top = `${topH}px`;
}

// Grab-and-move panning within a region (adjusts that region's cx/cy) and a
// draggable divider (adjusts the ratio).
function attachSplitRegionDrag(box, which) {
  let dragging = false;
  let start = null;
  box.addEventListener('pointerdown', (e) => {
    if (box.classList.contains('hidden')) return;
    const region = state.split[which];
    const srcW = (state.source && state.source.width) || fgVideo.videoWidth;
    const srcH = (state.source && state.source.height) || fgVideo.videoHeight;
    const { cropW, cropH, winX, winY } = splitCropWindow(srcW, srcH, box.offsetWidth / box.offsetHeight, region);
    dragging = true;
    // Drag the crop WINDOW directly (in source px) and derive cx/cy from it, so
    // panning is linear right up to the source edges with no dead zone — a wide
    // region (facecam) would otherwise accumulate cx in a clamped range and jump.
    start = { x: e.clientX, y: e.clientY, winX, winY, cropW, cropH, scale: box.offsetWidth / cropW, srcW, srcH };
    box.classList.add('dragging');
    try {
      box.setPointerCapture?.(e.pointerId);
    } catch {}
    e.stopPropagation();
    e.preventDefault();
  });
  box.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const region = state.split[which];
    const maxX = Math.max(0, start.srcW - start.cropW);
    const maxY = Math.max(0, start.srcH - start.cropH);
    const nwx = Math.max(0, Math.min(maxX, start.winX - (e.clientX - start.x) / start.scale));
    const nwy = Math.max(0, Math.min(maxY, start.winY - (e.clientY - start.y) / start.scale));
    region.cx = (nwx + start.cropW / 2) / start.srcW;
    region.cy = (nwy + start.cropH / 2) / start.srcH;
    syncSplit();
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    box.classList.remove('dragging');
    try {
      box.releasePointerCapture?.(e.pointerId);
    } catch {}
    emit('settings');
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

function attachSplitDivider() {
  let dragging = false;
  splitDivider.addEventListener('pointerdown', (e) => {
    dragging = true;
    splitDivider.setPointerCapture?.(e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  });
  splitDivider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const fr = previewFrame.getBoundingClientRect();
    state.split.ratio = Math.max(0.15, Math.min(0.85, (e.clientY - fr.top) / fr.height));
    syncSplit();
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      splitDivider.releasePointerCapture?.(e.pointerId);
    } catch {}
    emit('settings');
  };
  splitDivider.addEventListener('pointerup', end);
  splitDivider.addEventListener('pointercancel', end);
}

// CSS equivalent of the export's color grade (empty when neutral). Brightness
// is multiplicative here vs additive in ffmpeg eq — close, not exact. Grade is
// per-piece (the piece under the playhead).
function colorFilterCss() {
  const { brightness = 0, contrast = 0, saturation = 0 } = pieceSettingsAtOutput(getCurrentOutputTime()).color || {};
  if (brightness === 0 && contrast === 0 && saturation === 0) return '';
  return `brightness(${(1 + brightness / 100).toFixed(3)}) contrast(${(1 + contrast / 100).toFixed(
    3
  )}) saturate(${(1 + saturation / 100).toFixed(3)})`;
}

function updateAll() {
  applyClipTransform();
  bgVideo.style.transform = state.mirror ? 'scaleX(-1)' : 'none';

  // Color grade on the footage (fg + blurred bg + split regions), matching the
  // export's eq. Contrast/saturation map exactly; brightness is approximate.
  const grade = colorFilterCss();
  fgVideo.style.filter = grade;
  for (const v of [splitTopVideo, splitBottomVideo]) if (v) v.style.filter = grade;

  // The reframe / split fill the frame, so no blur background shows behind.
  const pieceBlur = pieceSettingsAtOutput(getCurrentOutputTime()).blur || 0;
  if (!faceTrackActive() && !splitActive() && pieceBlur > 0) {
    bgVideo.classList.remove('hidden');
    bgVideo.style.filter = `blur(${(pieceBlur * PREVIEW_BLUR_CSS_SCALE).toFixed(1)}px) ${grade}`.trim();
  } else {
    bgVideo.classList.add('hidden');
    bgVideo.style.filter = grade;
  }

  fgVideo.playbackRate = state.speed;
  bgVideo.playbackRate = state.speed;

  syncSplit();
  updateClipOutline();

  syncOverlayEls();
  syncLayerEls();
}

// Outlines the main clip while it's selected — around the actual footage
// content rect (the video's own bounds after object-fit + zoom + pan), NOT the
// whole canvas, so it reads like selecting any other element. Recomputed on
// every transform change since it tracks zoom/pan.
let clipOutline = null;

// The footage's on-screen rect (object-fit contain + zoom + pan), in frame px.
function clipContentRect() {
  const { width: frameW, height: frameH } = frameSize();
  const srcW = (state.source && state.source.width) || fgVideo.videoWidth || frameW;
  const srcH = (state.source && state.source.height) || fgVideo.videoHeight || frameH;
  const { zoom, panX, panY } = currentClipTransform();
  const videoAspect = srcW / srcH;
  const frameAspect = frameW / frameH;
  let contentW;
  let contentH;
  if (videoAspect > frameAspect) {
    contentW = frameW;
    contentH = frameW / videoAspect;
  } else {
    contentH = frameH;
    contentW = frameH * videoAspect;
  }
  const w = contentW * zoom;
  const h = contentH * zoom;
  const cx = frameW / 2 + (panX / 100) * (frameW / 2);
  const cy = frameH / 2 + (panY / 100) * (frameH / 2);
  return { left: cx - w / 2, top: cy - h / 2, w, h };
}

function updateClipOutline() {
  if (!clipOutline) return;
  const selected = !!selectedSegment();
  previewFrame.classList.toggle('clip-selected', selected);
  clipOutline.style.display = selected ? 'block' : 'none';
  if (!selected) return;
  const r = clipContentRect();
  clipOutline.style.left = `${r.left.toFixed(1)}px`;
  clipOutline.style.top = `${r.top.toFixed(1)}px`;
  clipOutline.style.width = `${r.w.toFixed(1)}px`;
  clipOutline.style.height = `${r.h.toFixed(1)}px`;
}

// Face-selection: resolves with the source-normalised { x, y } of the point the
// user taps on the preview (or null on Escape). Used to pick which face to
// track. Runs in the normal (contain) view, so the content rect maps cleanly.
// Tracks the in-flight face selection so it can be cancelled from outside
// (Escape, a second click on the Select button). Null when not selecting.
let faceSelectHandle = null;

export function isFaceSelecting() {
  return !!faceSelectHandle;
}

export function cancelFaceSelect() {
  if (faceSelectHandle) faceSelectHandle();
}

export function beginFaceSelect() {
  return new Promise((resolve) => {
    previewFrame.classList.add('face-selecting');
    // A real (clickable) pill with a ✕ cancel affordance — the old ::after
    // pseudo-element couldn't hold an interactive control.
    const pill = document.createElement('div');
    pill.className = 'face-select-pill';
    const label = document.createElement('span');
    label.textContent = 'Click a face to follow';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'face-select-cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel face selection');
    cancelBtn.innerHTML = icon('x', 12);
    pill.append(label, cancelBtn);
    previewFrame.appendChild(pill);

    const done = (value) => {
      faceSelectHandle = null;
      previewFrame.classList.remove('face-selecting');
      pill.remove();
      previewFrame.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onDown = (e) => {
      e.stopPropagation();
      e.preventDefault();
      // Clicking the pill / its ✕ cancels instead of picking a face.
      if (e.target.closest('.face-select-pill')) {
        done(null);
        return;
      }
      const fr = previewFrame.getBoundingClientRect();
      const rect = clipContentRect();
      const x = Math.max(0, Math.min(1, (e.clientX - fr.left - rect.left) / rect.w));
      const y = Math.max(0, Math.min(1, (e.clientY - fr.top - rect.top) / rect.h));
      done({ x, y });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(null);
    };
    faceSelectHandle = () => done(null);
    // Capture phase so it beats the clip-drag / overlay handlers.
    previewFrame.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
  });
}

// Direct-manipulation reposition of the main clip: pointerdown on the video
// selects the clip (the piece under the playhead) and drags to pan it, in the
// same select-then-drag style overlays use. The pan is written the same way
// the Position sliders do — into a keyframe at the playhead when keyframes
// exist, otherwise the static panX/panY.
function attachClipDrag() {
  let dragging = false;
  let startPointer = null;
  let startPan = null;

  const onDown = (e) => {
    // Let overlay/text elements (higher z-index, their own handlers) win.
    if (e.target !== fgVideo && e.target !== bgVideo) return;
    const t = fgVideo.currentTime || 0;
    const seg = state.segments.find((s) => t >= s.start && t < s.end) || state.segments[0];
    if (seg) selectSegment(seg.id);
    dragging = true;
    startPointer = { x: e.clientX, y: e.clientY };
    startPan = { x: state.panX, y: state.panY };
    fgVideo.setPointerCapture?.(e.pointerId);
    previewFrame.classList.add('clip-dragging');
    e.stopPropagation();
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!dragging) return;
    const { width: frameW, height: frameH } = frameSize();
    const dpanX = ((e.clientX - startPointer.x) / (frameW / 2)) * 100;
    const dpanY = ((e.clientY - startPointer.y) / (frameH / 2)) * 100;
    let panX = Math.max(-100, Math.min(100, Math.round(startPan.x + dpanX)));
    let panY = Math.max(-100, Math.min(100, Math.round(startPan.y + dpanY)));
    // Snap to centered (pan 0) the same way text/overlay drags snap to the
    // frame center, showing the same guide lines. Threshold in frame pixels.
    const snappedX = Math.abs((panX / 100) * (frameW / 2)) < POSITION_SNAP_PX;
    const snappedY = Math.abs((panY / 100) * (frameH / 2)) < POSITION_SNAP_PX;
    if (snappedX) panX = 0;
    if (snappedY) panY = 0;
    guideX.classList.toggle('visible', snappedX);
    guideY.classList.toggle('visible', snappedY);
    state.panX = panX;
    state.panY = panY;
    // When the clip is keyframed, dragging edits the keyframe at the playhead
    // (same as nudging the Position sliders); otherwise it's the static pan,
    // committed onto the piece under the playhead (B6 per-piece).
    if (state.keyframes.length) {
      addKeyframe(fgVideo.currentTime || 0, { zoom: state.zoom, panX: state.panX, panY: state.panY });
      emit('settings');
    } else {
      commitVideoSettings(getCurrentOutputTime());
    }
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      fgVideo.releasePointerCapture?.(e.pointerId);
    } catch {}
    previewFrame.classList.remove('clip-dragging');
    guideX.classList.remove('visible');
    guideY.classList.remove('visible');
  };

  fgVideo.addEventListener('pointerdown', onDown);
  bgVideo.addEventListener('pointerdown', onDown);
  fgVideo.addEventListener('pointermove', onMove);
  fgVideo.addEventListener('pointerup', onUp);
  fgVideo.addEventListener('pointercancel', onUp);
}

export function initPreview() {
  fitPreviewFrame();

  // Selection outline for the main clip's footage rect (see updateClipOutline).
  clipOutline = document.createElement('div');
  clipOutline.className = 'clip-outline';
  clipOutline.style.display = 'none';
  previewFrame.appendChild(clipOutline);

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
    } else if (logicalPlaying && activeAppended && !fgVideo.seeking) {
      // Playing an appended clip: when it ends, advance to the next appended
      // clip, or loop back to the very start of the timeline.
      if (fgVideo.currentTime >= activeAppended.clip.end - EPS) {
        const outEnd = activeAppended.outStart + (activeAppended.clip.end - activeAppended.clip.start);
        seekOutput(outEnd >= outputDuration() - EPS ? 0 : outEnd + EPS);
      }
    } else if (logicalPlaying && !fgVideo.seeking) {
      // Never stack a second seek onto one still in flight — issuing
      // currentTime writes while the decoder is mid-seek is what makes
      // cuts feel janky.
      const action = boundaryAction(fgVideo.currentTime);
      if (action) {
        if (action.loop) {
          // With appended clips, the end of the primary flows into the first
          // stitched clip instead of looping.
          if (state.appendedClips.length) seekOutput(primaryOutputDuration());
          else seekOutput(0);
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
    syncClipAudio(); // re-apply the fade envelope at the current time
    tickSounds(outT);
    tickOverlays(outT);
    // Keep the two split-region videos locked to the foreground playhead.
    if (splitActive()) {
      const t = fgVideo.currentTime || 0;
      for (const v of [splitTopVideo, splitBottomVideo]) {
        if (Math.abs((v.currentTime || 0) - t) > 0.15) {
          try {
            v.currentTime = t;
          } catch {}
        }
        if (logicalPlaying && v.paused && !gap) v.play().catch(() => {});
        if ((!logicalPlaying || gap) && !v.paused) v.pause();
      }
    }
    if (outT !== lastOutTime) {
      lastOutTime = outT;
      // Keyframes / face-tracking animate the transform, so re-apply it as the
      // playhead moves (playing or scrubbing), not just on settings. Crossing
      // into a new piece (per-piece settings) is handled by the 'time' listener.
      if (state.keyframes.length || faceTrackActive()) applyClipTransform();
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
  on('settings', () => {
    syncSoundAudios();
    syncClipAudio();
  });

  // Only the foreground's mute toggles — the background copy plays the
  // same source and unmuting both would phase/echo. Starting muted keeps
  // autoplay working; this click is itself the unmute gesture. This is a
  // preview-monitor mute only; the exported mute lives in state.audio.muted.
  muteBtn.addEventListener('click', () => {
    monitorMuted = !monitorMuted;
    syncClipAudio();
    muteBtn.innerHTML = icon(monitorMuted ? 'volume-x' : 'volume-2');
  });

  // Clicking the video itself selects the main clip (for framing) and lets
  // you drag it to reposition — same select-then-drag interaction overlays
  // use. Clicking the bare frame padding deselects.
  attachClipDrag();
  attachSplitRegionDrag(splitTop, 'facecam');
  attachSplitRegionDrag(splitBottom, 'gameplay');
  attachSplitDivider();
  previewFrame.addEventListener('pointerdown', (e) => {
    if (e.target === previewFrame) selectLayer(null);
  });

  on('settings', () => {
    fitPreviewFrame();
    updateAll();
  });
  on('facetrack', updateAll);
  on('layers', syncLayerEls);
  on('selection', () => {
    syncLayerEls();
    updateClipOutline();
  });
  let lastLookPieceId = null;
  on('time', ({ out } = {}) => {
    updateLayerVisibility();
    // Crossing into a different piece swaps its per-piece zoom/pan/blur/grade,
    // so refresh the whole look (playing or scrubbing). The id guard keeps this
    // to boundary crossings, not every frame.
    const ref = pieceRefAtOutput(out != null ? out : getCurrentOutputTime());
    const id = ref ? ref.id : null;
    if (id !== lastLookPieceId) {
      lastLookPieceId = id;
      updateAll();
    } else if (state.keyframes.length || faceTrackActive()) {
      // Keep the animated transform in step when the playhead moves via a seek.
      applyClipTransform();
    }
  });
  window.addEventListener('resize', () => {
    fitPreviewFrame();
    updateAll();
  });
}
