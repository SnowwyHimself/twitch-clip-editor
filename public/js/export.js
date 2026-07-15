// Export: turns the editor state into the render request and drives the
// job lifecycle UI (progress bar -> result video + download).
//
// The one non-obvious step is time-domain mapping. The whole editor works
// in SOURCE seconds; ffmpeg's overlay enable expressions run in OUTPUT
// time — after deleted segments are cut out (concat) and speed is applied.
// mapToOutput() collapses a source timestamp across the deleted gaps and
// divides by speed, so a text layer sitting at 0:05-0:08 on the timeline
// shows over exactly the same frames in the rendered file, whatever was
// cut before it.

import { state, on, keptSegments, orderedPieces, appendedLayout, sourceDuration, sourceToOutput, outputDuration } from './state.js';
import { fetchRecentExports } from './api.js';
import { currentProject } from './project.js';
import { enqueueExport, onExportsChanged } from './exportqueue.js';
import { showToast } from './toast.js';

const exportBtn = document.getElementById('export-btn');
const modal = document.getElementById('export-modal');
const closeModalBtn = document.getElementById('export-close-btn');
const optionsPane = document.getElementById('export-options');
const startRenderBtn = document.getElementById('export-start-btn');
const resolutionSelect = document.getElementById('export-resolution');
const qualitySelect = document.getElementById('export-quality');
const loudnessToggle = document.getElementById('export-loudness');
const filenameInput = document.getElementById('export-filename');
const recentsWrap = document.getElementById('export-recents');
const recentsList = document.getElementById('export-recents-list');

// A friendly, filesystem-safe download name from the user's input (or the
// project name / "Clip Editor" fallback). Drops characters that are illegal in
// filenames; the browser itself appends " (1)", " (2)" for duplicates.
function exportFileName() {
  const raw = (filenameInput && filenameInput.value.trim()) || currentProject().name || 'Clip Editor';
  const safe = raw
    .replace(/\.[Mm][Pp]4$/, '') // drop a typed .mp4 so we don't double it
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '') // illegal filename chars
    .trim()
    .slice(0, 80);
  return `${safe || 'Clip Editor'}.mp4`;
}

const EXPORT_OPTS_KEY = 'clipEditor.exportOpts.v1';

// state's sourceToOutput handles pieces, cuts, and free-mode gaps; the
// division by speed converts concat-domain seconds into the final video's
// seconds, which is what ffmpeg's enable/adelay run in (the setpts speed
// change happens before overlays and audio mixing).
function mapToOutput(sourceTime) {
  return sourceToOutput(sourceTime) / state.speed;
}

function buildTextLayersPayload() {
  const payload = [];
  for (const layer of state.layers) {
    if (!layer.text.trim()) continue;
    // Captions toggled off are kept in state but excluded from the render.
    if (state.captionsHidden && layer.group === 'caption') continue;
    const start = mapToOutput(layer.start);
    const end = mapToOutput(layer.end);
    // A layer that fell entirely inside deleted footage maps to a
    // zero-length range — nothing of it survives the cut, so skip it.
    if (end - start < 0.05) continue;
    payload.push({
      text: layer.text,
      style: layer.style,
      fontId: layer.fontId,
      fontSize: layer.fontSize,
      color: layer.color,
      dropShadow: layer.dropShadow,
      strokeWidth: layer.strokeWidth,
      strokeColor: layer.strokeColor,
      uppercase: layer.uppercase,
      opacity: layer.opacity,
      karaoke: layer.karaoke,
      karaokeColor: layer.karaokeColor,
      words: layer.karaoke ? layer.words : undefined,
      shadowDistance: layer.shadowDistance,
      shadowBlur: layer.shadowBlur,
      shadowOpacity: layer.shadowOpacity,
      bgOpacity: layer.bgOpacity,
      bgPadding: layer.bgPadding,
      bgRadius: layer.bgRadius,
      letterSpacing: layer.letterSpacing,
      lineHeight: layer.lineHeight,
      rotation: layer.rotation,
      xPercent: layer.xPercent,
      yPercent: layer.yPercent,
      wrapWidth: layer.wrapWidth,
      animation: layer.animation,
      start,
      end,
    });
  }
  return payload;
}

// opts lets a re-export reuse a saved export's exact settings; when omitted it
// reads the current option controls (the normal Render flow).
function buildFormData(opts) {
  const outHeight = opts && opts.outHeight != null ? opts.outHeight : resolutionSelect.value;
  const crf = opts && opts.crf != null ? opts.crf : qualitySelect.value;
  const loudness = opts && opts.loudness != null ? opts.loudness : !!(loudnessToggle && loudnessToggle.checked);
  const formData = new FormData();
  formData.append('aspectRatio', state.aspect.id);
  formData.append('zoom', state.zoom);
  formData.append('blur', state.blur);
  formData.append('panX', state.panX);
  formData.append('panY', state.panY);
  formData.append('mirror', state.mirror);
  formData.append('speed', state.speed);
  // Main-clip audio: volume 0-200 (or 0 when muted), plus head/tail fades.
  formData.append('audioVolume', state.audio.muted ? 0 : state.audio.volumePercent);
  formData.append('audioFadeIn', state.audio.fadeIn || 0);
  formData.append('audioFadeOut', state.audio.fadeOut || 0);
  // Color grade (brightness/contrast/saturation, each -100..100).
  formData.append('color', JSON.stringify(state.color || {}));
  // Main-clip crop (edge trims as %). Global/whole-video; the server crops the
  // source before the fill composite, mirroring the preview's object-view-box.
  formData.append('crop', JSON.stringify(state.crop || {}));
  // Export options — output height (px) + x264 CRF (lower = higher quality).
  formData.append('outHeight', outHeight);
  formData.append('crf', crf);
  // Loudness normalization to a consistent -14 LUFS (Feature 8); choice remembered.
  formData.append('normalizeLoudness', loudness ? 'true' : 'false');
  // Brand-kit watermark (Feature 7) — the image lives on the server, so only the
  // per-project placement/toggle rides the request.
  if (state.watermark && state.watermark.enabled) {
    formData.append('watermark', JSON.stringify({ enabled: true, ...state.watermark }));
  }
  formData.append('layout', state.layout || 'fill');
  if (state.layout === 'split') formData.append('split', JSON.stringify(state.split));
  formData.append('textLayers', JSON.stringify(buildTextLayersPayload()));

  // Face-tracking auto-reframe: a horizontal face path (x = 0..1 of source
  // width, z = depth zoom) timed in OUTPUT seconds. When present the server
  // renders the clip as a frame-filling window that pans to follow it.
  if (state.faceTrack.enabled && state.faceTrack.samples.length > 0) {
    formData.append(
      'faceTrack',
      JSON.stringify(
        state.faceTrack.samples.map((s) => ({
          t: Number(mapToOutput(s.t).toFixed(3)),
          x: Number(s.x.toFixed(4)),
          z: Number((s.z || 1).toFixed(4)),
        }))
      )
    );
    // Global tracked-shot tightness (constant over the clip).
    formData.append('faceZoom', String(state.faceTrack.zoom || 1));
  }

  // Zoom/position keyframes, timed in OUTPUT seconds (mapped across cuts +
  // speed, same as captions) so the server's zoompan expressions line up with
  // the render's stream clock. Empty when the clip has no animation.
  if (state.keyframes.length > 0) {
    formData.append(
      'keyframes',
      JSON.stringify(
        state.keyframes.map((k) => ({
          t: Number(mapToOutput(k.t).toFixed(3)),
          zoom: k.zoom,
          panX: k.panX,
          panY: k.panY,
        }))
      )
    );
  }

  const kept = keptSegments();
  if (sourceDuration() > 0 && kept.length > 0) {
    // outStart carries the free-mode placement — the server inserts black
    // filler for any output gap between consecutive pieces.
    formData.append(
      'segments',
      JSON.stringify(
        kept.map((s) => ({ start: s.start, end: s.end, outStart: s.outStart, settings: s.settings || null }))
      )
    );
    // Transitions as UNIFIED piece indexes (kept segments then appended clips,
    // matching the server's stitched piece order) so a transition can sit at a
    // cross-source boundary, not just between primary segments (C2).
    const orderedIds = orderedPieces().map((p) => p.id);
    const transitions = state.transitions
      .map((tr) => ({
        afterIndex: orderedIds.indexOf(tr.afterSegmentId),
        duration: tr.duration,
        color: tr.type === 'black-flash' ? 'black' : 'white',
      }))
      .filter((tr) => tr.afterIndex >= 0 && tr.afterIndex < orderedIds.length - 1);
    if (transitions.length > 0) {
      formData.append('transitions', JSON.stringify(transitions));
    }
  }
  // Overlays — one file per overlay (order matches the `overlays` metadata
  // array); each carries crop, position, its on-screen window in FINAL
  // video seconds, and offset (video overlays start `offset` in).
  const overlays = [];
  for (const o of state.overlays) {
    formData.append('overlay', o.file);
    overlays.push({
      isVideo: o.isVideo,
      sizePercent: o.sizePercent,
      xPercent: o.xPercent,
      yPercent: o.yPercent,
      cropTop: o.cropTop,
      cropBottom: o.cropBottom,
      cropLeft: o.cropLeft,
      cropRight: o.cropRight,
      start: Number(mapToOutput(o.start).toFixed(3)),
      end: Number(mapToOutput(o.end).toFixed(3)),
      offset: Number((o.offset || 0).toFixed(3)),
    });
  }
  if (overlays.length > 0) formData.append('overlays', JSON.stringify(overlays));

  // Sounds — one file per sound; each is delayed to its FINAL-video start,
  // trimmed to the [offset, offset+length] region of its file, and volumed.
  const sounds = [];
  for (const s of state.sounds) {
    formData.append('audioTrack', s.file);
    const delay = mapToOutput(s.start);
    const playLen = mapToOutput(s.end) - mapToOutput(s.start);
    sounds.push({
      volume: s.muted ? 0 : s.volumePercent,
      fadeIn: s.fadeIn || 0,
      fadeOut: s.fadeOut || 0,
      duck: !!s.duck,
      delay: Number(delay.toFixed(3)),
      playLen: Number(playLen.toFixed(3)),
      trimStart: Number((s.offset || 0).toFixed(3)),
      trimEnd: Number(((s.offset || 0) + playLen).toFixed(3)),
    });
  }
  if (sounds.length > 0) formData.append('sounds', JSON.stringify(sounds));

  // Speech ranges for ducking = the caption layers (transcript) in FINAL-video
  // seconds. Empty when captions are hidden/absent (nothing ducks then).
  if (!state.captionsHidden && state.sounds.some((s) => s.duck)) {
    const speech = state.layers
      .filter((l) => l.group === 'caption' && l.text && l.text.trim())
      .map((l) => ({ start: Number(mapToOutput(l.start).toFixed(3)), end: Number(mapToOutput(l.end).toFixed(3)) }))
      .filter((r) => r.end - r.start > 0.02);
    if (speech.length > 0) formData.append('speechRanges', JSON.stringify(speech));
  }

  // Appended clips (multi-source) — each stitched after the primary. Their
  // RESOLVED output position (outStart, from appendedLayout — clamp-forward
  // applied) rides along so the server inserts black filler for free-mode gaps,
  // exactly like it does for primary segments. In snap mode these are contiguous,
  // so the server sees no gaps and behaves as before.
  // URL clips ride as metadata (the server re-resolves via the preview cache);
  // file clips ride as 'appendedVideo' files, order-matched to hasFile entries.
  const layout = appendedLayout();
  const outStartById = new Map(layout.map((it) => [it.clip.id, it.outStart]));
  const appended = [];
  for (const clip of state.appendedClips) {
    const s = clip.source;
    const outStart = outStartById.get(clip.id);
    const entry = {
      kind: s.kind,
      start: Number((clip.start || 0).toFixed(3)),
      end: Number((clip.end || 0).toFixed(3)),
      outStart: Number.isFinite(outStart) ? Number(outStart.toFixed(3)) : null,
      settings: clip.settings || null,
    };
    if (s.kind === 'url') {
      entry.url = s.url;
    } else {
      formData.append('appendedVideo', s.file);
      entry.hasFile = true;
    }
    appended.push(entry);
  }
  if (appended.length > 0) formData.append('appendedClips', JSON.stringify(appended));

  let endpoint;
  if (state.source.kind === 'url') {
    endpoint = '/api/process-url';
    formData.append('url', state.source.url);
  } else {
    endpoint = '/api/process-upload';
    formData.append('video', state.source.file);
  }
  return { endpoint, formData };
}

// A full render request captured from the CURRENT state — endpoint + FormData
// (a snapshot: once built, later edits can't change it) plus the metadata a
// recent-exports row and the pill need. `opts` overrides the option controls
// (used by re-export to reuse a saved export's exact settings).
function buildExportSnapshot(opts) {
  const { endpoint, formData } = buildFormData(opts);
  const outHeight = opts && opts.outHeight != null ? opts.outHeight : resolutionSelect.value;
  const crf = opts && opts.crf != null ? opts.crf : qualitySelect.value;
  const loudness = opts && opts.loudness != null ? opts.loudness : !!(loudnessToggle && loudnessToggle.checked);
  return {
    endpoint,
    formData,
    meta: {
      filename: exportFileName(),
      durationSec: Math.round((outputDuration() || 0) * 10) / 10,
      res: String(outHeight),
      crf: String(crf),
      loudness: !!loudness,
    },
  };
}

// Opens the export dialog (pick name/resolution/quality, then Render) and
// refreshes the recent-exports list below the options.
function showOptions() {
  modal.classList.remove('hidden');
  optionsPane.classList.remove('hidden');
  // Prefill the name with the project's name (unless the user already typed one).
  if (filenameInput && !filenameInput.value.trim()) {
    const n = currentProject().name;
    filenameInput.value = n && n !== 'Untitled' ? n : 'Clip Editor';
  }
  renderRecents();
}

function beginExport() {
  if (!state.source) return;
  showOptions();
}

// Render now runs in the BACKGROUND: snapshot the state, hand it to the queue,
// and return to editing. Progress/queue/completion all live in the corner pill
// and toast (see exportqueue.js) — no blocking modal.
function startRender() {
  if (!state.source) return;
  localStorage.setItem(
    EXPORT_OPTS_KEY,
    JSON.stringify({ res: resolutionSelect.value, crf: qualitySelect.value, loudness: !loudnessToggle || loudnessToggle.checked })
  );
  try {
    enqueueExport(buildExportSnapshot());
    modal.classList.add('hidden');
  } catch (err) {
    showToast({ message: `Couldn't start export: ${err && err.message ? err.message : 'unknown error'}` });
  }
}

// Re-render the CURRENT project using a saved export's settings.
function reExport(rec) {
  if (!state.source) {
    showToast({ message: 'Load a clip first to re-export.' });
    return;
  }
  enqueueExport(buildExportSnapshot({ outHeight: rec.res, crf: rec.crf, loudness: rec.loudness !== false }));
  modal.classList.add('hidden');
}

function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}
function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function safeText(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

async function renderRecents() {
  if (!recentsWrap || !recentsList) return;
  const exports = await fetchRecentExports();
  if (!exports.length) {
    recentsWrap.classList.add('hidden');
    return;
  }
  recentsWrap.classList.remove('hidden');
  recentsList.innerHTML = '';
  const canReveal = !!(window.electronAPI && window.electronAPI.showExportInFolder);
  for (const rec of exports) {
    const row = document.createElement('div');
    row.className = 'export-recent-row';
    const meta = [fmtDur(rec.durationSec), fmtWhen(rec.savedAt)].filter(Boolean).join(' · ');
    row.innerHTML = `
      <div class="export-recent-info">
        <span class="export-recent-name">${safeText(rec.filename)}</span>
        <span class="export-recent-meta">${safeText(meta)}</span>
      </div>
      <div class="export-recent-actions"></div>`;
    const actions = row.querySelector('.export-recent-actions');

    if (canReveal) {
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'link-btn';
      show.textContent = 'Show in folder';
      show.disabled = rec.fileExists === false;
      if (show.disabled) show.title = 'The exported file is no longer there';
      show.addEventListener('click', () => window.electronAPI.showExportInFolder(rec.outputUrl));
      actions.appendChild(show);
    } else if (rec.outputUrl) {
      const dl = document.createElement('a');
      dl.className = 'link-btn';
      dl.textContent = 'Download';
      dl.href = rec.outputUrl;
      dl.download = rec.filename;
      actions.appendChild(dl);
    }

    const re = document.createElement('button');
    re.type = 'button';
    re.className = 'link-btn';
    re.textContent = 'Re-export';
    re.title = 'Re-render the current project with these settings';
    re.addEventListener('click', () => reExport(rec));
    actions.appendChild(re);

    recentsList.appendChild(row);
  }
}

export function initExport() {
  exportBtn.addEventListener('click', beginExport);
  startRenderBtn.addEventListener('click', startRender);
  // Restore the last-used export options.
  try {
    const saved = JSON.parse(localStorage.getItem(EXPORT_OPTS_KEY) || '{}');
    if (saved.res) resolutionSelect.value = saved.res;
    if (saved.crf) qualitySelect.value = saved.crf;
    // Loudness defaults ON; only an explicit stored `false` unchecks it.
    if (loudnessToggle) loudnessToggle.checked = saved.loudness !== false;
  } catch {
    /* defaults */
  }
  closeModalBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
  // Keep the recents list fresh whenever the queue records a new export.
  onExportsChanged(() => {
    if (!modal.classList.contains('hidden')) renderRecents();
  });
  on('source', () => {
    exportBtn.disabled = !state.source;
  });
  exportBtn.disabled = true;
}
