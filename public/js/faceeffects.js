// Face-effect preview compositing. For each blur/cover effect, interpolate its
// smoothed box path at the current SOURCE time (the same piecewise-linear interp
// the export expression uses) and position a CSS element over the preview. We
// map through the foreground <video>'s live rendered rect, so the effect follows
// the face correctly whatever reframe/aspect/crop the video is under. No live
// re-detection — purely from the sampled path (keeps the preview smooth).
import { state } from './state.js';
import { sampleFaceBoxAt } from './facetrack.js';

// The face-api box center sits low (~mouth); shift effects up by this fraction
// of face height to land on the eyes/nose. Kept in sync with server.js.
const FACE_VBIAS = 0.18;

const nodes = new Map(); // fx.id -> { wrap, kind, img }

function makeNode(fx) {
  const wrap = document.createElement('div');
  wrap.className = `face-fx face-fx-${fx.kind}`;
  let img = null;
  if (fx.kind === 'cover') {
    img = document.createElement('img');
    img.className = 'face-fx-img hidden';
    img.alt = '';
    const span = document.createElement('span');
    span.className = 'face-fx-emoji';
    wrap.append(span, img);
  }
  return { wrap, kind: fx.kind, img };
}

export function renderFaceEffectsPreview(sourceTime) {
  const host = document.getElementById('face-effects');
  if (!host) return;
  const fxs = state.faceEffects || [];

  // Drop nodes whose effect is gone.
  for (const [id, node] of nodes) {
    if (!fxs.find((f) => f.id === id)) {
      node.wrap.remove();
      nodes.delete(id);
    }
  }
  if (!fxs.length) return;

  const video = document.getElementById('preview-fg-video');
  const frame = document.getElementById('preview-frame');
  if (!video || !frame) return;
  const vr = video.getBoundingClientRect();
  const fr = frame.getBoundingClientRect();
  if (!vr.width || !vr.height) return;

  for (const fx of fxs) {
    let node = nodes.get(fx.id);
    if (!node || node.kind !== fx.kind) {
      if (node) node.wrap.remove();
      node = makeNode(fx);
      nodes.set(fx.id, node);
      host.appendChild(node.wrap);
    }
    const inRange = sourceTime >= fx.start - 1e-3 && sourceTime <= fx.end + 1e-3;
    const box = inRange ? sampleFaceBoxAt(fx.samples, sourceTime) : null;
    if (!box) {
      node.wrap.style.display = 'none';
      continue;
    }
    node.wrap.style.display = 'block';
    // Source-normalized center → preview-frame pixels via the live video rect,
    // biased up to the eyes/nose (the face-api box center sits ~mouth level),
    // plus the user's nudge (a fraction of the face box, so it scales with the
    // face as it moves toward/away from camera). FACE_VBIAS matches the server.
    const cx = vr.left - fr.left + (box.x + (fx.offsetX || 0) * box.w) * vr.width;
    const cy = vr.top - fr.top + (box.y + ((fx.offsetY || 0) - FACE_VBIAS) * box.h) * vr.height;
    // Briefly-lost faces hold their last box and fade rather than snapping away.
    node.wrap.style.opacity = box.seen ? '1' : '0.55';

    if (fx.kind === 'blur') {
      // Circle sized to the face WIDTH (matches export) — round, face-sized.
      // Size slider spans ~0.7×–2.5× so it can go tight on small faces.
      const dia = Math.max(8, box.w * (0.7 + (fx.padding || 0) * 1.8) * vr.width);
      node.wrap.style.left = `${cx - dia / 2}px`;
      node.wrap.style.top = `${cy - dia / 2}px`;
      node.wrap.style.width = `${dia}px`;
      node.wrap.style.height = `${dia}px`;
      const px = 2 + (fx.strength || 0.5) * 30;
      node.wrap.style.backdropFilter = `blur(${px}px)`;
      node.wrap.style.webkitBackdropFilter = `blur(${px}px)`;
    } else {
      const size = box.w * vr.width * (fx.scale || 1.4);
      node.wrap.style.left = `${cx - size / 2}px`;
      node.wrap.style.top = `${cy - size / 2}px`;
      node.wrap.style.width = `${size}px`;
      node.wrap.style.height = `${size}px`;
      node.wrap.style.transform = `rotate(${fx.rotation || 0}deg)`;
      const emojiEl = node.wrap.querySelector('.face-fx-emoji');
      const imgEl = node.img;
      const url = fx.imageUrl || null;
      if (url) {
        imgEl.src = url;
        imgEl.classList.remove('hidden');
        emojiEl.textContent = '';
      } else {
        emojiEl.textContent = fx.emoji || '😀';
        emojiEl.style.fontSize = `${size * 0.92}px`;
        imgEl.classList.add('hidden');
      }
    }
  }
}
