// Filmstrip thumbnails for the video track. Frames are grabbed locally off a
// throwaway <video> + canvas (no server, works offline) and cached per URL, so
// a clip's strip is extracted once and reused as it's trimmed/reordered/zoomed.
// Mirrors waveform.js: getFilmstrip() builds the whole-source frame set, and
// drawFilmstrip() tiles the slice a given clip actually plays.

const FRAME_COUNT = 14; // frames sampled across the whole source
const THUMB_H = 48; // extraction height (px); width follows the source aspect
const cache = new Map(); // url -> Promise<{ frames: HTMLCanvasElement[], duration } | null>

// Seeks the video to t, resolving once the frame is ready (with a timeout so a
// coalesced/near-identical seek can't hang the extraction).
function seekTo(video, t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      resolve();
    };
    video.addEventListener('seeked', finish);
    video.currentTime = t;
    setTimeout(finish, 500);
  });
}

export function getFilmstrip(url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.src = url;
    await new Promise((resolve, reject) => {
      v.addEventListener('loadedmetadata', resolve, { once: true });
      v.addEventListener('error', () => reject(new Error('load')), { once: true });
    });
    const duration = v.duration || 0;
    if (!duration || !v.videoWidth) return null;
    const aspect = v.videoWidth / v.videoHeight;
    const tw = Math.max(2, Math.round(THUMB_H * aspect));
    const frames = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const t = Math.min(duration - 0.05, (i / Math.max(1, FRAME_COUNT - 1)) * duration);
      await seekTo(v, t);
      const c = document.createElement('canvas');
      c.width = tw;
      c.height = THUMB_H;
      try {
        c.getContext('2d').drawImage(v, 0, 0, tw, THUMB_H);
      } catch {
        return null; // tainted/undecodable
      }
      frames.push(c);
    }
    return { frames, duration };
  })().catch(() => null);
  cache.set(url, p);
  return p;
}

// Tiles the [offsetSec, offsetSec+lenSec] slice of the source across the canvas,
// each slot showing the frame nearest that position in time. DPR-aware.
export function drawFilmstrip(canvas, data, offsetSec, lenSec) {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (!data || !data.frames.length || cssW <= 0 || cssH <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  const { frames, duration } = data;
  const first = frames[0];
  const slotW = Math.max(1, Math.round(canvas.height * (first.width / first.height)));
  const slots = Math.max(1, Math.ceil(canvas.width / slotW));
  const len = Math.max(1e-6, lenSec);
  for (let i = 0; i < slots; i++) {
    const t = offsetSec + ((i + 0.5) / slots) * len;
    const idx = Math.min(frames.length - 1, Math.max(0, Math.round((t / (duration || 1)) * (frames.length - 1))));
    g.drawImage(frames[idx], i * slotW, 0, slotW, canvas.height);
  }
}
