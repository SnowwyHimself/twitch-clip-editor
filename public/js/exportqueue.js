// Export manager: renders run off a snapshot taken at export start (so the
// request can't change under the render). The UI is the export WINDOW itself —
// this module drives it through callbacks (setExportUI): progress while
// rendering, then the finished result. A second export started while one runs
// still queues (FIFO, one at a time); in the single-window flow that's rare, but
// the engine stays correct if it happens.
import { startExport, fetchJobStatus, cancelExport, recordRecentExport } from './api.js';

let active = null; // { item, jobId, meta, renderStartedAt, lastJob }
const queue = [];
const changeCbs = [];
let pollTimer = null;
let ui = {}; // { onStart, onProgress, onDone, onError, onCancelled }

export function setExportUI(handlers) {
  ui = handlers || {};
}
function call(name, arg) {
  try {
    if (ui[name]) ui[name](arg);
  } catch {
    /* a bad UI handler must not break the render loop */
  }
}

export function onExportsChanged(cb) {
  changeCbs.push(cb);
}
function emitChanged() {
  for (const cb of changeCbs) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
}

// item = { endpoint, formData, meta:{ filename, durationSec, res, crf, loudness } }
export function enqueueExport(item) {
  queue.push(item);
  if (!active) startNext();
  else call('onProgress', progressPayload());
}

async function startNext() {
  const item = queue.shift();
  if (!item) {
    active = null;
    return;
  }
  active = { item, jobId: null, meta: item.meta, renderStartedAt: null, lastJob: null };
  call('onStart', { meta: active.meta, queued: queue.length });
  call('onProgress', progressPayload());
  try {
    const { jobId } = await startExport(item.endpoint, item.formData);
    active.jobId = jobId;
    startPoll();
  } catch (err) {
    active = null;
    call('onError', { message: `Couldn't start export: ${err && err.message ? err.message : 'unknown error'}` });
    startNext();
  }
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(async () => {
    if (!active || !active.jobId) return;
    let job;
    try {
      job = await fetchJobStatus(active.jobId);
    } catch {
      return; // transient — keep polling
    }
    active.lastJob = job;
    if (!active.renderStartedAt && Number.isFinite(job.progress) && job.progress > 0) {
      active.renderStartedAt = Date.now();
    }
    if (job.status === 'done') {
      finishActive(job);
      return;
    }
    if (job.status === 'error') {
      stopPoll();
      const msg = job.error || 'unknown error';
      active = null;
      call('onError', { message: `Export failed: ${msg}` });
      startNext();
      return;
    }
    if (job.status === 'cancelled') {
      stopPoll();
      active = null;
      call('onCancelled');
      startNext();
      return;
    }
    call('onProgress', progressPayload(job));
  }, 700);
}

async function finishActive(job) {
  stopPoll();
  const meta = active.meta;
  await recordRecentExport({
    filename: meta.filename,
    durationSec: meta.durationSec,
    outputUrl: job.outputUrl,
    res: meta.res,
    crf: meta.crf,
    loudness: meta.loudness,
    sizeBytes: Number.isFinite(job.outputBytes) ? job.outputBytes : null,
  });
  emitChanged();
  call('onDone', { meta, outputUrl: job.outputUrl, sizeBytes: Number.isFinite(job.outputBytes) ? job.outputBytes : null });
  active = null;
  startNext();
}

// Cancel the current render (or a not-yet-started one). The poll observes
// 'cancelled' and fires onCancelled; a pre-start cancel fires it directly.
export function cancelActiveExport() {
  if (!active) return;
  if (!active.jobId) {
    active = null;
    stopPoll();
    call('onCancelled');
    startNext();
    return;
  }
  cancelExport(active.jobId);
}

export function isExporting() {
  return !!active;
}

// The payload the window's progress view renders: percent, a status line, and an
// honest ETA/size sub-line (only once there's enough signal).
function progressPayload(job) {
  const j = job || (active && active.lastJob) || {};
  const downloading = j.status === 'downloading';
  const progress = Number.isFinite(j.progress) ? j.progress : 0;
  const pct = Math.round(progress * 100);
  let status = 'Rendering…';
  if (downloading) status = 'Downloading clip…';
  else if (active && progress === 0) status = 'Starting…';
  const parts = [];
  if (active && active.renderStartedAt && !downloading) {
    const elapsed = Date.now() - active.renderStartedAt;
    if (progress > 0.05 && elapsed > 1500) parts.push(`~${fmtDuration((elapsed * (1 - progress)) / progress / 1000)} left`);
    if (Number.isFinite(j.outputBytes) && progress > 0.15) parts.push(`~${fmtBytes(j.outputBytes / progress)}`);
  }
  if (queue.length > 0) parts.push(`${queue.length} more queued`);
  return {
    pct,
    status,
    sub: parts.join(' · '),
    indeterminate: downloading || (active && progress === 0),
    filename: active && active.meta.filename,
  };
}

export function initExportQueue() {
  /* nothing to wire — the export window owns the UI (see export.js setExportUI) */
}

// --- small formatters --------------------------------------------------------
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  return `${Math.round(mb)} MB`;
}
export { fmtBytes, fmtDuration };
