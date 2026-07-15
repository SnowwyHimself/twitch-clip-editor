// First-run onboarding: on the very first launch only, the empty state offers a
// bundled sample clip; taking it loads the sample and runs a 3-step coach-mark
// tour (trim → captions → export). Quiet and dismissible — a persisted flag in
// userData (app-state.onboardingSeen) makes sure it never shows twice. Pasting a
// real link/opening a file on first run retires the offer silently (never
// interrupt a user who already knows what they want).
import { fetchAppState, saveAppState } from './api.js';

let pendingFirstRun = false; // true only during a genuine first launch, pre-choice

// The tour. Each step anchors a small tooltip to a live element; if an anchor is
// somehow missing we skip that step rather than point at nothing.
const TOUR_STEPS = [
  {
    anchor: () => document.getElementById('tl-body'),
    title: 'Trim on the timeline',
    body: 'Drag a clip’s edges to trim it, or move the playhead and press <b>S</b> to split.',
    placement: 'top',
  },
  {
    anchor: () => document.getElementById('add-menu-btn'),
    title: 'Auto captions live here',
    body: 'Open <b>+ Add → Auto captions</b> to transcribe your clip on-device with Whisper.',
    placement: 'bottom',
  },
  {
    anchor: () => document.getElementById('export-btn'),
    title: 'Export when it’s ready',
    body: 'This renders your vertical clip — same as the preview, frame for frame.',
    placement: 'bottom',
  },
];

export async function initOnboarding({ loadSample }) {
  const st = await fetchAppState();
  if (st && st.onboardingSeen) return; // already onboarded — nothing to do
  pendingFirstRun = true;

  const btn = document.getElementById('try-sample-btn');
  if (!btn) return;
  btn.classList.remove('hidden');
  btn.addEventListener('click', async () => {
    if (!pendingFirstRun) return;
    pendingFirstRun = false;
    btn.classList.add('hidden');
    await saveAppState({ onboardingSeen: true });
    try {
      await loadSample();
    } catch {
      return; // sample failed to load — just skip the tour, no noise
    }
    // Let the timeline/preview lay out before anchoring tooltips to them.
    setTimeout(runTour, 700);
  });
}

// Fired on the first real source load (paste link / open file). If the offer is
// still pending, retire it silently and mark onboarding done.
export async function onSourceLoaded() {
  if (!pendingFirstRun) return;
  pendingFirstRun = false;
  const btn = document.getElementById('try-sample-btn');
  if (btn) btn.classList.add('hidden');
  await saveAppState({ onboardingSeen: true });
}

function runTour() {
  let i = 0;
  let highlighted = null;
  const mark = document.createElement('div');
  mark.className = 'coach-mark';
  mark.setAttribute('role', 'dialog');
  document.body.appendChild(mark);

  function cleanup() {
    mark.remove();
    if (highlighted) highlighted.classList.remove('coach-highlight');
    window.removeEventListener('resize', reposition, true);
    window.removeEventListener('scroll', reposition, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  }

  function reposition() {
    const target = TOUR_STEPS[i].anchor();
    if (!target) return;
    const placement = TOUR_STEPS[i].placement;
    const r = target.getBoundingClientRect();
    const mw = mark.offsetWidth;
    const mh = mark.offsetHeight;
    const gap = 12;
    let top = placement === 'top' ? r.top - mh - gap : r.bottom + gap;
    let left = r.left + r.width / 2 - mw / 2;
    // Clamp into the viewport with an 8px margin.
    const margin = 8;
    left = Math.max(margin, Math.min(left, window.innerWidth - mw - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - mh - margin));
    mark.style.left = `${Math.round(left)}px`;
    mark.style.top = `${Math.round(top)}px`;
  }

  function render() {
    const step = TOUR_STEPS[i];
    const target = step.anchor();
    if (!target) {
      // Missing anchor: advance, or finish if this was the last.
      if (i < TOUR_STEPS.length - 1) {
        i += 1;
        return render();
      }
      return cleanup();
    }
    if (highlighted) highlighted.classList.remove('coach-highlight');
    highlighted = target;
    target.classList.add('coach-highlight');

    const last = i === TOUR_STEPS.length - 1;
    const dots = TOUR_STEPS.map((_, d) => `<span class="coach-dot${d === i ? ' on' : ''}"></span>`).join('');
    mark.innerHTML = `
      <div class="coach-title">${step.title}</div>
      <div class="coach-body">${step.body}</div>
      <div class="coach-foot">
        <div class="coach-dots">${dots}</div>
        <div class="coach-actions">
          <button type="button" class="link-btn coach-skip">Skip</button>
          <button type="button" class="secondary-btn coach-next">${last ? 'Done' : 'Next'}</button>
        </div>
      </div>`;
    mark.querySelector('.coach-skip').addEventListener('click', cleanup);
    mark.querySelector('.coach-next').addEventListener('click', () => {
      if (last) return cleanup();
      i += 1;
      render();
    });
    // Measure after paint so positioning uses the real size.
    requestAnimationFrame(reposition);
  }

  window.addEventListener('resize', reposition, true);
  window.addEventListener('scroll', reposition, true);
  document.addEventListener('keydown', onKey, true);
  render();
}
