// Auto-reframe: scans the loaded clip with a bundled in-browser face detector
// (face-api.js tinyFaceDetector — no cloud, no per-platform native binary),
// then turns the face's path into smoothed zoom/position KEYFRAMES that keep
// the face framed. It reuses the same keyframe engine hand-placed keyframes
// use, so the live preview and the export's zoompan both animate from it.

import { state, addKeyframe, clearKeyframes, sourceDuration } from './state.js';
import { pausePlayback } from './preview.js';

const FACE_API_SRC = '/vendor/face-api/face-api.min.js';
const MODELS_URI = '/vendor/face-api/models';

// A constant zoom for the reframe. It tightens the shot so the tracked face
// is a reasonable size AND — importantly — gives the export's zoompan room to
// pan (at zoom 1 there's no crop to slide, so pan can't move anything).
const TRACK_ZOOM = 1.35;
const SAMPLE_STEP = 0.25; // detect a face every 250ms of the clip
const KEYFRAME_STEP = 0.6; // emit a keyframe about every 600ms
const SMOOTH_RADIUS = 3; // moving-average radius (in samples) to kill jitter

let faceApiReady = null;

// Lazy-loads the detector (UMD global `faceapi`) + the tiny model only on the
// first track, so normal startup stays light.
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

function seekTo(video, t) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
  });
}

// Scans the clip and lays down auto-reframe keyframes. onProgress(0..1) is
// called as the scan advances. Returns { ok, reason?, keyframes? }.
export async function trackFace({ onProgress } = {}) {
  const video = document.getElementById('preview-fg-video');
  const duration = sourceDuration();
  if (!video || !state.source || duration <= 0) return { ok: false, reason: 'no-clip' };

  let faceapi;
  try {
    faceapi = await loadFaceApi();
  } catch {
    return { ok: false, reason: 'load-failed' };
  }
  // A large input size so even a small corner facecam (tiny in a 1080p frame)
  // is big enough to detect; a lenient score threshold since gaming clips have
  // the subject looking away a lot. (Multiple of 32, as face-api requires.)
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 800, scoreThreshold: 0.25 });

  pausePlayback();
  const resumeTime = video.currentTime;
  const srcW = state.source.width || video.videoWidth;
  const srcH = state.source.height || video.videoHeight;

  // 1) Sample the face center across the clip (holding the last known center
  //    through frames where no face is found — brief look-aways/occlusions).
  const samples = [];
  const steps = Math.max(1, Math.floor(duration / SAMPLE_STEP));
  let last = null;
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(duration - 0.01, i * SAMPLE_STEP);
    await seekTo(video, t);
    let det = null;
    try {
      det = await faceapi.detectSingleFace(video, opts);
    } catch {
      det = null;
    }
    if (det) {
      const b = det.box;
      last = { fx: (b.x + b.width / 2) / srcW, fy: (b.y + b.height / 2) / srcH };
    }
    samples.push({ t, face: last });
    if (onProgress) onProgress((i + 1) / (steps + 1));
  }

  if (!samples.some((s) => s.face)) {
    await seekTo(video, resumeTime);
    return { ok: false, reason: 'no-face' };
  }

  // 2) Smooth the path with a moving average (over the samples that saw a
  //    face) so the reframe glides instead of snapping frame-to-frame.
  const smoothed = samples
    .map((s, i) => {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let j = Math.max(0, i - SMOOTH_RADIUS); j <= Math.min(samples.length - 1, i + SMOOTH_RADIUS); j++) {
        if (samples[j].face) {
          sx += samples[j].face.fx;
          sy += samples[j].face.fy;
          n += 1;
        }
      }
      return n ? { t: s.t, fx: sx / n, fy: sy / n } : null;
    })
    .filter(Boolean);

  // 3) Turn each smoothed center into the zoom/pan that lands the face on the
  //    frame center. Same transform math the preview uses: at zoom Z, panX =
  //    Z*(0.5-fx)*200 centers a face at normalized x fx; vertically the clip
  //    is width-fit, so its height covers fgHfrac of the frame.
  const fgHfrac = (srcH / srcW) * (state.aspect.width / state.aspect.height);
  const clampPan = (v) => Math.max(-100, Math.min(100, Math.round(v)));
  clearKeyframes();
  let lastKfT = -Infinity;
  for (const s of smoothed) {
    const isLast = s === smoothed[smoothed.length - 1];
    if (!isLast && s.t - lastKfT < KEYFRAME_STEP - 1e-6) continue;
    const panX = clampPan(TRACK_ZOOM * (0.5 - s.fx) * 200);
    const panY = clampPan(TRACK_ZOOM * fgHfrac * (0.5 - s.fy) * 200);
    addKeyframe(s.t, { zoom: TRACK_ZOOM, panX, panY });
    lastKfT = s.t;
  }

  await seekTo(video, resumeTime);
  return { ok: true, keyframes: state.keyframes.length };
}
