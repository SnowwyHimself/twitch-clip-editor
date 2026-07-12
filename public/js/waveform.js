// Waveform peaks for timeline clips. Peaks are extracted locally with the Web
// Audio API (decodeAudioData) — no upload, no cloud, works offline — and
// cached per URL so a clip's shape is computed once and reused as it's moved,
// trimmed, or the timeline is zoomed. Each clip draws only the slice of its
// file it actually plays ([offset, offset+len]).

const BUCKETS = 1200; // peak resolution across the whole file
const cache = new Map(); // url -> Promise<{ peaks: Float32Array, duration } | null>
let ctx = null;

function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = AC ? new AC() : null;
  }
  return ctx;
}

// Resolves to { peaks (0..1 max-abs per bucket), duration } or null if the URL
// can't be decoded (e.g. a video container the browser won't hand us audio for).
export function getPeaks(url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const ac = audioCtx();
    if (!ac) return null;
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    // decodeAudioData is callback-style in older Safari — wrap for both.
    const audio = await new Promise((resolve, reject) => {
      const ret = ac.decodeAudioData(buf, resolve, reject);
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    });
    const ch = audio.getChannelData(0);
    const peaks = new Float32Array(BUCKETS);
    const step = ch.length / BUCKETS;
    for (let i = 0; i < BUCKETS; i++) {
      const start = Math.floor(i * step);
      const end = Math.min(ch.length, Math.floor((i + 1) * step));
      let max = 0;
      for (let j = start; j < end; j++) {
        const a = Math.abs(ch[j]);
        if (a > max) max = a;
      }
      peaks[i] = max;
    }
    return { peaks, duration: audio.duration };
  })().catch(() => null);
  cache.set(url, p);
  return p;
}

// Draws the [offsetSec, offsetSec+lenSec] slice of `data`'s peaks into a canvas,
// mirrored around the vertical centre. Sized in CSS pixels; scaled for DPR.
export function drawWaveform(canvas, data, offsetSec, lenSec, color) {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (!data || cssW <= 0 || cssH <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = color || 'rgba(255,255,255,0.55)';
  const { peaks, duration } = data;
  const mid = canvas.height / 2;
  const startFrac = duration > 0 ? offsetSec / duration : 0;
  const endFrac = duration > 0 ? Math.min(1, (offsetSec + lenSec) / duration) : 1;
  const span = Math.max(1e-6, endFrac - startFrac);
  for (let x = 0; x < canvas.width; x++) {
    const frac = startFrac + span * (x / canvas.width);
    const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor(frac * peaks.length)));
    const amp = peaks[idx] * mid;
    g.fillRect(x, mid - amp, 1, Math.max(1, amp * 2));
  }
}
