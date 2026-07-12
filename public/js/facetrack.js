// Face-tracking auto-reframe. You pick the face to follow (a tap/box on the
// preview); this scans the clip with a bundled in-browser detector (face-api.js
// — no cloud, no native binary), locks onto THAT face by always choosing the
// detection nearest the previous position, and produces a horizontal-only pan
// path (plus a gentle depth zoom from how the face's size changes). The render
// (preview + export) turns that path into a frame-filling window that slides
// left/right, clamped to the source edges so it's never black-barred.

import { state, setFaceTrack, sourceDuration } from './state.js';
import { pausePlayback } from './preview.js';

const FACE_API_SRC = '/vendor/face-api/face-api.min.js';
const MODELS_URI = '/vendor/face-api/models';

const SAMPLE_STEP = 0.3; // detect every 300ms of the clip
const SMOOTH_RADIUS = 3; // moving-average radius (samples)
const MAX_DEPTH_ZOOM = 1.4; // cap on the auto depth zoom

let faceApiReady = null;

function loadFaceApi() {
  if (faceApiReady) return faceApiReady;
  faceApiReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = FACE_API_SRC;
    script.onload = async () => {
      try {
        await window.faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URI);
        resolve(window.faceapi);
      } catch (err) {
        reject(err);
      }
    };
    script.onerror = () => reject(new Error('Could not load the face detector.'));
    document.head.appendChild(script);
  });
  return faceApiReady;
}

// Resolves once the frame at t is ready — but never hangs: if 'seeked' doesn't
// fire (e.g. the decoder coalesces a near-identical time) a short timeout wins.
function seekTo(video, t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    const onSeeked = () => finish();
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
    setTimeout(finish, 400);
  });
}

// Detection can't wedge the whole scan either — cap it and treat a slow frame
// as "no faces this sample". NOTE: detectAllFaces() returns face-api's own
// thenable *task* object, not a real Promise — it's awaitable but has no
// .catch(), so we adopt it into a genuine Promise (via the async wrapper)
// before racing/catching. Calling .catch() on the raw task throws
// "detectAllFaces(...).catch is not a function" and aborts the whole scan.
async function detectWithTimeout(faceapi, video, opts) {
  const detect = (async () => {
    try {
      return await faceapi.detectAllFaces(video, opts);
    } catch {
      return [];
    }
  })();
  // Generous cap: catches a truly wedged frame without cutting off a
  // slow-but-working detection on a modest machine.
  const timeout = new Promise((r) => setTimeout(() => r([]), 4000));
  return Promise.race([detect, timeout]);
}

// target = { x, y } normalized (0..1) point on a face the user picked. Scans
// the clip, follows that face, and installs the reframe. Returns { ok, reason? }.
export async function trackSelectedFace(target, { onProgress } = {}) {
  const video = document.getElementById('preview-fg-video');
  const duration = sourceDuration();
  if (!video || !state.source || duration <= 0) return { ok: false, reason: 'no-clip' };

  let faceapi;
  try {
    faceapi = await loadFaceApi();
  } catch {
    return { ok: false, reason: 'load-failed' };
  }
  // Large input size so even a small corner facecam is detectable in 1080p;
  // per-frame timeouts (below) keep the scan from ever wedging on a slow frame.
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 768, scoreThreshold: 0.2 });

  pausePlayback();
  const resumeTime = video.currentTime;
  const srcW = state.source.width || video.videoWidth;
  const srcH = state.source.height || video.videoHeight;

  // Sample the clip, each time picking the detection nearest the last known
  // position of the tracked face (seeded from the user's pick), so we stay
  // locked on the same person even when others are on screen.
  const samples = [];
  const steps = Math.max(1, Math.floor(duration / SAMPLE_STEP));
  let lastX = target.x;
  let lastY = target.y;
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(duration - 0.01, i * SAMPLE_STEP);
    await seekTo(video, t);
    const faces = await detectWithTimeout(faceapi, video, opts);
    if (onProgress) onProgress((i + 1) / (steps + 1));
    let best = null;
    let bestDist = Infinity;
    for (const f of faces) {
      const cx = (f.box.x + f.box.width / 2) / srcW;
      const cy = (f.box.y + f.box.height / 2) / srcH;
      const d = (cx - lastX) ** 2 + (cy - lastY) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { x: cx, y: cy, w: f.box.width / srcW };
      }
    }
    if (best) {
      lastX = best.x;
      lastY = best.y;
      samples.push({ t, x: best.x, w: best.w });
    } else {
      samples.push({ t, x: lastX, w: null }); // hold through a miss
    }
  }

  const seen = samples.filter((s) => s.w != null);
  if (seen.length === 0) {
    await seekTo(video, resumeTime);
    return { ok: false, reason: 'no-face' };
  }

  // Reference face width (median of what we saw) drives the depth zoom: when
  // the face shrinks (subject further away) we zoom in a touch to keep it well
  // sized; bigger-than-reference just stays at 1x.
  const widths = seen.map((s) => s.w).sort((a, b) => a - b);
  const refW = widths[Math.floor(widths.length / 2)] || widths[0];

  // Smooth the horizontal path (and carry a depth zoom) so the reframe glides.
  const out = samples.map((s, i) => {
    let sx = 0;
    let n = 0;
    for (let j = Math.max(0, i - SMOOTH_RADIUS); j <= Math.min(samples.length - 1, i + SMOOTH_RADIUS); j++) {
      sx += samples[j].x;
      n += 1;
    }
    const w = s.w || refW;
    const z = Math.max(1, Math.min(MAX_DEPTH_ZOOM, refW / Math.max(0.01, w)));
    return { t: s.t, x: sx / n, z };
  });

  setFaceTrack(out);
  await seekTo(video, resumeTime);
  return { ok: true, samples: out.length };
}
