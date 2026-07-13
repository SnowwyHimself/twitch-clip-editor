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

import { state, on, keptSegments, sourceDuration, sourceToOutput } from './state.js';
import { startExport, fetchJobStatus } from './api.js';

const exportBtn = document.getElementById('export-btn');
const modal = document.getElementById('export-modal');
const modalStatus = document.getElementById('export-status');
const modalBarFill = document.getElementById('export-bar-fill');
const modalResult = document.getElementById('export-result');
const resultVideo = document.getElementById('result-video');
const downloadLink = document.getElementById('download-link');
const closeModalBtn = document.getElementById('export-close-btn');

let pollHandle = null;

const STATUS_LABELS = {
  queued: 'Queued...',
  downloading: 'Downloading clip...',
  processing: 'Rendering...',
  done: 'Done!',
};

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

function buildFormData() {
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
      JSON.stringify(kept.map((s) => ({ start: s.start, end: s.end, outStart: s.outStart })))
    );
    // Transitions as piece indexes (order matches the segments payload).
    const transitions = state.transitions
      .map((tr) => ({
        afterIndex: kept.findIndex((s) => s.id === tr.afterSegmentId),
        duration: tr.duration,
      }))
      .filter((tr) => tr.afterIndex >= 0 && tr.afterIndex < kept.length - 1);
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
      delay: Number(delay.toFixed(3)),
      playLen: Number(playLen.toFixed(3)),
      trimStart: Number((s.offset || 0).toFixed(3)),
      trimEnd: Number(((s.offset || 0) + playLen).toFixed(3)),
    });
  }
  if (sounds.length > 0) formData.append('sounds', JSON.stringify(sounds));

  // Appended clips (sequential multi-source) — each stitched after the primary.
  // URL clips ride as metadata (the server re-resolves via the preview cache);
  // file clips ride as 'appendedVideo' files, order-matched to hasFile entries.
  const appended = [];
  for (const clip of state.appendedClips) {
    const s = clip.source;
    const entry = { kind: s.kind, start: Number((clip.start || 0).toFixed(3)), end: Number((clip.end || 0).toFixed(3)) };
    if (s.kind === 'url') {
      entry.url = s.url;
      if (s.section) entry.section = s.section;
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
    if (state.source.section) {
      formData.append('sectionStart', state.source.section.start);
      formData.append('sectionEnd', state.source.section.end);
    }
  } else {
    endpoint = '/api/process-upload';
    formData.append('video', state.source.file);
  }
  return { endpoint, formData };
}

function showModal() {
  modal.classList.remove('hidden');
  modalResult.classList.add('hidden');
  modalBarFill.style.width = '0%';
  modalBarFill.classList.remove('error');
  modalStatus.classList.remove('error');
}

function stopPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

function setExporting(isExporting) {
  exportBtn.disabled = isExporting;
  exportBtn.textContent = isExporting ? 'Exporting...' : 'Export';
}

function showError(message) {
  modalStatus.textContent = message || 'Something went wrong.';
  modalStatus.classList.add('error');
  modalBarFill.classList.add('error');
  setExporting(false);
}

function pollStatus(jobId) {
  pollHandle = setInterval(async () => {
    try {
      const job = await fetchJobStatus(jobId);
      if (job.status === 'error') {
        stopPolling();
        showError(job.error);
        return;
      }
      modalStatus.textContent = STATUS_LABELS[job.status] || 'Working...';
      if (Number.isFinite(job.progress)) {
        modalBarFill.style.width = `${Math.round(job.progress * 100)}%`;
      }
      if (job.status === 'done') {
        stopPolling();
        setExporting(false);
        modalBarFill.style.width = '100%';
        modalResult.classList.remove('hidden');
        resultVideo.src = job.outputUrl;
        downloadLink.href = job.outputUrl;
      }
    } catch (err) {
      stopPolling();
      showError(err.message);
    }
  }, 700);
}

async function beginExport() {
  if (!state.source) return;
  stopPolling();
  showModal();
  setExporting(true);
  modalStatus.textContent = 'Starting...';
  try {
    const { endpoint, formData } = buildFormData();
    const { jobId } = await startExport(endpoint, formData);
    pollStatus(jobId);
  } catch (err) {
    showError(err.message);
  }
}

export function initExport() {
  exportBtn.addEventListener('click', beginExport);
  closeModalBtn.addEventListener('click', () => {
    stopPolling();
    setExporting(false);
    resultVideo.pause();
    modal.classList.add('hidden');
  });
  on('source', () => {
    exportBtn.disabled = !state.source;
  });
  exportBtn.disabled = true;
}
