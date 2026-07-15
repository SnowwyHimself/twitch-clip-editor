// Background export manager: renders run off a snapshot taken at export start,
// so editing during a render is safe. A compact corner pill shows progress
// (percent + a rough ETA + estimated size) and a cancel; starting another export
// while one runs queues it (FIFO, one render at a time). Finished exports record
// into the userData recents list and raise a quiet toast.
import { startExport, fetchJobStatus, cancelExport, recordRecentExport } from './api.js';
import { showToast } from './toast.js';
import { openPhoneModal } from './phone.js';

// active: { item, jobId, meta, requestedAt, renderStartedAt, lastJob }
let active = null;
const queue = []; // pending items: { endpoint, formData, meta }
const changeCbs = [];
let pollTimer = null;

const el = (id) => document.getElementById(id);

// Lets the export panel refresh its "recent exports" list when it changes.
export function onExportsChanged(cb) {
  changeCbs.push(cb);
}
function emitChanged() {
  for (const cb of changeCbs) {
    try {
      cb();
    } catch {
      /* ignore a bad listener */
    }
  }
}

// item = { endpoint, formData, meta:{ filename, durationSec, res, crf, loudness } }
export function enqueueExport(item) {
  queue.push(item);
  renderPill();
  if (!active) startNext();
}

async function startNext() {
  const item = queue.shift();
  if (!item) {
    active = null;
    renderPill();
    return;
  }
  active = { item, jobId: null, meta: item.meta, requestedAt: Date.now(), renderStartedAt: null, lastJob: null };
  renderPill();
  try {
    const { jobId } = await startExport(item.endpoint, item.formData);
    active.jobId = jobId;
    startPoll();
  } catch (err) {
    showToast({ message: `Export failed to start: ${err && err.message ? err.message : 'unknown error'}` });
    active = null;
    renderPill();
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
      return; // transient network hiccup — keep polling
    }
    active.lastJob = job;
    // Mark when real rendering begins (first non-zero progress) so the ETA is
    // measured from render start, not from the download/startup phase.
    if (!active.renderStartedAt && Number.isFinite(job.progress) && job.progress > 0) {
      active.renderStartedAt = Date.now();
    }
    if (job.status === 'done') {
      finishActive(job);
      return;
    }
    if (job.status === 'error') {
      stopPoll();
      showToast({ message: `Export failed: ${job.error || 'unknown error'}` });
      active = null;
      renderPill();
      startNext();
      return;
    }
    if (job.status === 'cancelled') {
      stopPoll();
      active = null;
      renderPill();
      startNext();
      return;
    }
    renderPill(job);
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
  showExportDoneToast(meta.filename, job.outputUrl);
  active = null;
  renderPill();
  startNext();
}

function cancelActive() {
  if (!active || !active.jobId) return;
  cancelExport(active.jobId);
  // The poll will observe 'cancelled' and advance the queue; nothing else to do.
}

// --- completion toast --------------------------------------------------------
function showExportDoneToast(filename, outputUrl) {
  const actions = [];
  if (window.electronAPI && window.electronAPI.showExportInFolder) {
    actions.push({ label: 'Show in folder', onAction: () => window.electronAPI.showExportInFolder(outputUrl) });
  } else {
    // Browser fallback: no OS file manager — offer the download.
    actions.push({
      label: 'Download',
      onAction: () => {
        const a = document.createElement('a');
        a.href = outputUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
    });
  }
  // Send to phone (opens the pairing QR / companion hint).
  actions.push({ label: 'Send to phone', onAction: () => openPhoneModal({ fromExport: true }) });
  showToast({ message: `Exported ${filename}`, actions });
}

// --- corner pill -------------------------------------------------------------
function renderPill(job) {
  const pill = el('export-pill');
  if (!pill) return;
  if (!active && queue.length === 0) {
    pill.classList.add('hidden');
    return;
  }
  pill.classList.remove('hidden');

  const j = job || (active && active.lastJob) || {};
  const downloading = j.status === 'downloading';
  const progress = Number.isFinite(j.progress) ? j.progress : 0;
  const pct = Math.round(progress * 100);

  el('export-pill-label').textContent = active ? `Exporting ${truncate(active.meta.filename, 22)}` : 'Queued';
  el('export-pill-pct').textContent = downloading || !active ? '' : `${pct}%`;
  el('export-pill-fill').style.width = active && !downloading ? `${pct}%` : '0%';
  el('export-pill-fill').classList.toggle('indeterminate', downloading || (active && progress === 0));

  const parts = [];
  if (downloading) {
    parts.push('Downloading…');
  } else if (active && progress === 0) {
    parts.push('Starting…');
  } else if (active && active.renderStartedAt) {
    const elapsed = Date.now() - active.renderStartedAt;
    // Only offer an ETA once there's enough signal to be honest.
    if (progress > 0.05 && elapsed > 1500) {
      parts.push(`~${fmtDuration((elapsed * (1 - progress)) / progress / 1000)} left`);
    }
    if (Number.isFinite(j.outputBytes) && progress > 0.15) {
      parts.push(`~${fmtBytes(j.outputBytes / progress)}`);
    }
  }
  if (queue.length > 0) parts.push(`${queue.length} queued`);
  el('export-pill-sub').textContent = parts.join(' · ');
}

export function initExportQueue() {
  const cancelBtn = el('export-pill-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', cancelActive);
}

// --- small formatters --------------------------------------------------------
function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
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
