const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { renderCaptionPng, resolveFontPath, getFontOptions } = require('./caption');
const { transcribeSource, checkWhisperSetup } = require('./transcribe');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Inside a packaged Electron app, ROOT can point into a read-only app
// bundle (an asar archive), so job data can't live there. Electron's main
// process sets CLIP_EDITOR_DATA_DIR to a real writable folder (its
// userData directory) before requiring this file; plain `node server.js`
// leaves it unset and everything stays relative to this file, as before.
const DATA_ROOT = process.env.CLIP_EDITOR_DATA_DIR || ROOT;
const UPLOADS_DIR = path.join(DATA_ROOT, 'uploads');
const DOWNLOADS_DIR = path.join(DATA_ROOT, 'downloads');
const OUTPUTS_DIR = path.join(DATA_ROOT, 'outputs');
const CAPTIONS_DIR = path.join(DATA_ROOT, 'captions');
// Clips fetched purely to populate the live preview for the Clip URL tab —
// keyed by a hash of the URL (see previewCacheKey) so previewing the same
// URL twice, or clicking Generate right after previewing it, reuses the
// already-downloaded file instead of running yt-dlp again.
const PREVIEW_CACHE_DIR = path.join(DATA_ROOT, 'preview-cache');
// Whisper ggml model file(s) for auto-captions live here (fetched once by
// scripts/fetch-whisper-model.sh); transcribe-cache holds the short-lived
// extracted-wav + whisper-JSON intermediates per transcription run.
const MODELS_DIR = path.join(DATA_ROOT, 'models');
const TRANSCRIBE_DIR = path.join(DATA_ROOT, 'transcribe-cache');

for (const dir of [UPLOADS_DIR, DOWNLOADS_DIR, OUTPUTS_DIR, CAPTIONS_DIR, PREVIEW_CACHE_DIR, MODELS_DIR, TRANSCRIBE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ffmpeg/yt-dlp need to be real executable files on disk to spawn — inside
// a packaged app they ship as extraResources (Contents/Resources/bin/ on
// mac, resources/bin/ on Windows), never inside the asar archive itself.
// Electron's main process sets CLIP_EDITOR_RESOURCES to process.resourcesPath
// before requiring this file; when unset (plain `node server.js`), this
// falls back to PATH. Windows binaries carry a .exe extension; mac/linux
// ones don't.
function resolveBinary(name) {
  const resourcesDir = process.env.CLIP_EDITOR_RESOURCES;
  const binaryName = process.platform === 'win32' ? `${name}.exe` : name;
  if (resourcesDir) {
    const candidate = path.join(resourcesDir, 'bin', binaryName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
}

const FFMPEG_BIN = resolveBinary('ffmpeg');
const YTDLP_BIN = resolveBinary('yt-dlp');

// Every ratio's pixel dimensions follow the same convention every major
// editor uses: width:height literally matches the ratio's own numbers, so
// 4:3 and 16:9 render landscape, never flipped into a portrait crop.
const ASPECT_RATIOS = {
  '9:16': { label: 'TikTok / Reels / Shorts (9:16)', width: 1080, height: 1920 },
  '1:1': { label: 'Square (1:1)', width: 1080, height: 1080 },
  '4:5': { label: 'Instagram Portrait (4:5)', width: 1080, height: 1350 },
  '4:3': { label: 'Classic (4:3)', width: 1440, height: 1080 },
  '16:9': { label: 'Widescreen (16:9)', width: 1920, height: 1080 },
};
const DEFAULT_ASPECT_RATIO = '9:16';

function normalizeAspectRatio(value) {
  return ASPECT_RATIOS[value] ? value : DEFAULT_ASPECT_RATIO;
}

function getAspectRatioOptions() {
  return Object.entries(ASPECT_RATIOS).map(([id, entry]) => ({
    id,
    label: entry.label,
    width: entry.width,
    height: entry.height,
    isDefault: id === DEFAULT_ASPECT_RATIO,
  }));
}

const MIN_ZOOM = 1.0;
const MAX_ZOOM = 2.0;
const MIN_BLUR = 0;
const MAX_BLUR = 100;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2.0;
const MIN_FONT_SIZE = 32;
const MAX_FONT_SIZE = 120;
const DEFAULT_FONT_SIZE = 64;

// jobId -> { status, outputUrl, error }
const jobs = new Map();

function createJob() {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'queued' });
  return jobId;
}

function setJob(jobId, patch) {
  jobs.set(jobId, { ...jobs.get(jobId), ...patch });
}

function clampZoom(value) {
  const zoom = parseFloat(value);
  if (Number.isNaN(zoom)) return 1.35;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function clampBlur(value) {
  const blur = parseFloat(value);
  if (Number.isNaN(blur)) return 0;
  return Math.min(MAX_BLUR, Math.max(MIN_BLUR, blur));
}

// Main-clip pan, -100..100 (% of half the canvas; 0 = centered).
function clampPan(value) {
  const pan = parseFloat(value);
  if (Number.isNaN(pan)) return 0;
  return Math.min(100, Math.max(-100, pan));
}

function clampSpeed(value) {
  const speed = parseFloat(value);
  if (Number.isNaN(speed)) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function clampCaptionStyle(value) {
  return value === 'box' || value === 'plain' ? value : 'outline';
}

function normalizeMirror(value) {
  return value === true || value === 'true';
}

// `segments` arrives as the KEPT pieces from the frontend's timeline — a
// JSON string when it came through multer's multipart form parsing, or
// already a real array on the JSON-body route. Each is
// { start, end, outStart }: source in/out points plus the piece's
// position on the OUTPUT timeline (free-form mode can leave gaps between
// pieces, which render as black — see buildSegmentFilter). Returns null
// when there's nothing usable — meaning "no trim at all," so runFfmpeg
// skips every trim/concat step entirely. Source ranges are never clamped
// against the real duration here — ffmpeg itself simply stops at EOF if a
// range asks for more than exists.
function buildSegments(body) {
  let raw = body.segments;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const cleaned = raw
    .map((s) => ({
      start: parseFloat(s && s.start),
      end: parseFloat(s && s.end),
      outStart: Number.isFinite(parseFloat(s && s.outStart)) ? parseFloat(s.outStart) : null,
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start)
    .sort((a, b) => (a.outStart !== null ? a.outStart : a.start) - (b.outStart !== null ? b.outStart : b.start));

  // Fill in / repair outStart so downstream code can rely on it: missing
  // values pack cumulatively (the classic snap layout), and overlapping
  // placements clamp forward rather than producing negative gaps.
  let cursor = 0;
  for (const s of cleaned) {
    if (s.outStart === null || s.outStart < cursor - 0.001) s.outStart = cursor;
    cursor = s.outStart + (s.end - s.start);
  }

  return cleaned.length > 0 ? cleaned : null;
}

// Transitions between consecutive pieces: { afterIndex, duration } —
// afterIndex refers to the (outStart-ordered) segments array above.
// Currently the only type is the white flash (dip to white).
function buildTransitions(body) {
  let raw = body.transitions;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => ({
      afterIndex: parseInt(t && t.afterIndex, 10),
      duration: Math.min(2, Math.max(0.1, parseFloat(t && t.duration) || 0.5)),
    }))
    .filter((t) => Number.isInteger(t.afterIndex) && t.afterIndex >= 0);
}

function normalizeDropShadow(value) {
  return value === true || value === 'true';
}

// Unknown/missing font ids fall back to the default bundled font — handled
// inside caption.js's resolveFontEntry, not here, so this only needs to
// guard against non-string garbage reaching it.
function normalizeFontId(value) {
  return typeof value === 'string' && value ? value : undefined;
}

function clampFontSize(value) {
  const size = parseFloat(value);
  if (Number.isNaN(size)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

// Caption horizontal/vertical position, as a 0-100 "where does the
// caption's own center sit between the two edges" percentage — 50 is
// centered. Kept generic (not zoom/seam-aware) since horizontal position
// has no "auto" concept to preserve, and manual vertical position
// intentionally doesn't track the seam once a user sets it (see
// normalizeAutoPosition below).
// Default matches the frontend's vertical position slider default (25%,
// roughly TikTok's usual caption placement) — used only when a manual
// positionY is expected but wasn't actually provided.
function clampPositionPercent(value, fallback = 25) {
  const pct = parseFloat(value);
  if (Number.isNaN(pct)) return fallback;
  return Math.min(100, Math.max(0, pct));
}

// Converts a 0-100 "center position" percentage into a top-left pixel
// coordinate, clamped so the full contentSize always stays within
// [0, canvasSize] regardless of how large/small the caption or how far
// toward an edge it's positioned — this is what keeps captions on-screen
// at any font size or position setting instead of the boundary shrinking
// or content clipping off the canvas.
function resolvePositionCoordinate(percent, contentSize, canvasSize) {
  const minCenter = contentSize / 2;
  const maxCenter = canvasSize - contentSize / 2;
  const center = maxCenter >= minCenter ? minCenter + (percent / 100) * (maxCenter - minCenter) : canvasSize / 2;
  return Math.round(center - contentSize / 2);
}

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      reject(new Error(`Failed to start ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderr.trim().split('\n').slice(-15).join('\n');
        reject(new Error(`${cmd} exited with code ${code}\n${tail}`));
      }
    });
  });
}

// Reads the source video's width/height and whether it has an audio stream
// by parsing ffmpeg's own stderr (no ffprobe dependency needed). Running
// ffmpeg with -i and no output always exits non-zero, but still prints
// stream info first.
function probeSource(inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, ['-i', inputPath]);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', () => {
      const videoMatch = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      if (!videoMatch) {
        reject(new Error('Could not determine source video dimensions'));
        return;
      }
      const hasAudio = /Stream #\d+:\d+.*?: Audio:/.test(stderr);
      // Container duration — used to compute an expected output length for
      // the render progress percentage. null (rare, e.g. a stream with no
      // duration metadata) just means no percentage, not a failure.
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const duration = durationMatch
        ? parseInt(durationMatch[1], 10) * 3600 + parseInt(durationMatch[2], 10) * 60 + parseFloat(durationMatch[3])
        : null;
      resolve({ width: parseInt(videoMatch[1], 10), height: parseInt(videoMatch[2], 10), hasAudio, duration });
    });
  });
}

// Builds the ffmpeg filter_complex graph for the zoom + blurred-background
// vertical conversion. fgWidth is rounded to an even number since it feeds
// into a scale filter ahead of a crop, and odd intermediate dimensions can
// trip up libx264's yuv420p chroma subsampling. At blur=0 there's no
// blurred-background layer at all — the leftover space is plain black
// letterboxing instead of a sigma=0 (still-visible) blur pass.
//
// When captionOverlay is present, the zoom+blur composite is labeled [comp]
// instead of the final [outv], and one more overlay stage burns the caption
// PNG on top at the precomputed x/y position.
//
// The bg layer's force_original_aspect_ratio=increase step computes a
// fractional intermediate size (e.g. 1920*1.7778=3413.33) that has to round
// to an integer, and ffmpeg compensates by writing a corrective non-1:1 SAR
// into the output instead of just declaring square pixels. That's harmless
// for lenient decoders but stricter ones (Safari's AVFoundation in
// particular) can fail to load a file over that — so every path funnels
// into [precap] and gets an explicit setsar=1 before the real [outv].
//
// When mirror is true, an hflip stage runs on the raw source first, and
// both the foreground and background branches read from that flipped
// output instead of [0:v] — so the whole frame flips together before any
// zoom/blur/crop happens. The caption overlay (added afterward, if
// present) is never part of that hflip, so it always reads correctly
// regardless of mirror state.
//
// When speed isn't 1, a setpts stage runs first (before mirror), so the
// whole pipeline — mirror, zoom/blur/crop, caption position — operates on
// the already time-adjusted video.
//
// Unlike [0:v] (a raw input, which ffmpeg lets any number of filters read
// independently), the output of a filter can only be consumed once unless
// explicitly duplicated with split. buildSourcePrefix collapses speed+mirror
// into a single chain and only reaches for split when there are two
// downstream consumers (the blur>0 path's bg and fg chains) — the blur<=0
// path only has one consumer and never needs it, and if neither speed nor
// mirror is active, no prefix is added at all (plain [0:v] straight
// through, matching the original unmodified behavior exactly).
// sourceLabel defaults to the raw input ([0:v]) but is overridden to
// [segv] when buildSegmentFilter (below) has already concatenated
// multiple kept segments — either way this is the single point every
// downstream chain reads its starting video from.
function buildSourcePrefix(sourceLabel, speed, mirror, consumerCount) {
  const steps = [];
  if (speed !== 1) {
    steps.push(`setpts=(1/${speed})*PTS`);
  }
  if (mirror) {
    steps.push('hflip');
  }

  // [0:v] is the one label ffmpeg treats specially: a raw demuxed stream,
  // safe for any number of filters to read independently. Every other
  // label here (e.g. [segv], the segment-concat step's output) is a
  // regular filter-graph output pad, which — like any filter output — can
  // only be consumed once unless explicitly duplicated with split. So
  // when there are two downstream consumers (the blur>0 path's bg/fg
  // chains) and speed/mirror don't already produce a split, a filter
  // output source still needs one of its own.
  const isRawInput = sourceLabel === '[0:v]';

  if (steps.length === 0) {
    if (consumerCount !== 2) return { stage: '', labels: [sourceLabel] };
    if (isRawInput) return { stage: '', labels: [sourceLabel, sourceLabel] };
    return { stage: `${sourceLabel}split=2[src1][src2];`, labels: ['[src1]', '[src2]'] };
  }

  const chain = steps.join(',');
  if (consumerCount === 2) {
    return { stage: `${sourceLabel}${chain},split=2[src1][src2];`, labels: ['[src1]', '[src2]'] };
  }
  return { stage: `${sourceLabel}${chain}[src];`, labels: ['[src]'] };
}

// overlayStages: an ordered list of things composited on top of the base
// zoom/blur frame — the media overlay (if any) first, then every text layer
// in order, so text always stays above the media overlay, matching how
// CapCut stacks by default. Each stage is { pre, inputLabel, x, y, enable }:
// `pre` is an optional preparatory chain (the media overlay's
// scale-to-percent step — its x/y use ffmpeg's own overlay_w/overlay_h
// runtime expressions so the server never needs to know that file's aspect
// ratio ahead of time, while text-layer x/y are precomputed pixels since
// the server rendered the PNG and knows its exact size), and `enable` an
// optional ffmpeg timeline expression (between(t,start,end)) that shows a
// text layer only during its own time range. `t` there is OUTPUT time —
// after segment trims and speed changes — which is exactly the domain the
// frontend maps layer times into before submitting (see export payload
// notes in public/js/export.js).
function buildFilterComplex(canvasW, canvasH, zoom, blur, panX, panY, overlayStages, mirror, speed, sourceLabel) {
  const fgWidth = Math.round((canvasW * zoom) / 2) * 2;
  const fgChain = `scale=${fgWidth}:-2,crop=${canvasW}:ih:(iw-${canvasW})/2:0`;

  // pan moves the sharp foreground over the background, in canvas pixels
  // (panX/panY are % of half the canvas; 0 = centered). Both blur>0 and
  // blur=0 now composite via overlay on a full-canvas background (blurred,
  // or a black frame DERIVED FROM THE SOURCE via drawbox — never a `color`
  // filter source, whose fps/timebase mismatch makes concat/overlay
  // misbehave) so panning works identically at any blur.
  const panXpx = Math.round((panX / 100) * (canvasW / 2));
  const panYpx = Math.round((panY / 100) * (canvasH / 2));
  const panXExpr = panXpx !== 0 ? `+(${panXpx})` : '';
  const panYExpr = panYpx !== 0 ? `+(${panYpx})` : '';

  const { stage, labels } = buildSourcePrefix(sourceLabel, speed, mirror, 2);
  const [bgSource, fgSource] = labels;
  const bgFill = blur > 0 ? `gblur=sigma=${blur}` : `drawbox=color=black:t=fill`;
  const bg = `${bgSource}scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH},${bgFill}[bg]`;
  const fg = `${fgSource}${fgChain}[fg]`;
  const overlay = `[bg][fg]overlay=(W-w)/2${panXExpr}:(H-h)/2${panYExpr}[c0]`;
  let graph = `${stage}${bg};${fg};${overlay}`;

  let current = '[c0]';
  overlayStages.forEach((stage, i) => {
    const next = `[c${i + 1}]`;
    if (stage.pre) graph += `;${stage.pre}`;
    const enable = stage.enable ? `:enable='${stage.enable}'` : '';
    graph += `;${current}${stage.inputLabel}overlay=${stage.x}:${stage.y}${enable}${next}`;
    current = next;
  });

  graph += `;${current}setsar=1[outv]`;

  return graph;
}

// Cutting out a middle piece (rather than just trimming the two ends)
// can't be done with input-side -ss/-t (that only ever keeps one
// contiguous range) — instead each kept [start,end] range is trimmed from
// the raw input independently, timestamps reset to 0 (setpts=PTS-STARTPTS
// — otherwise concat would leave gaps matching the ORIGINAL gaps between
// pieces), then concat stitches them together. Three extras ride the same
// chain:
//   - Output gaps (a piece's outStart later than the previous piece's
//     end — free-form timeline mode) become BLACK filler pieces. These
//     are derived from the source itself (trim + drawbox blackout + muted
//     audio) rather than color/anullsrc filter sources: synthetic sources
//     carry a different frame rate/timebase than the demuxed stream, and
//     concat-ing the mix made the encoder mass-duplicate frames chasing
//     the timestamp mismatch (verified: "More than 1000 frames
//     duplicated" and a render ~60x slower than realtime). Reusing real
//     frames guarantees identical link parameters. One limit: a single
//     gap can't be longer than the whole source clip.
//   - White-flash transitions become a white fade-out on the last
//     duration/2 of the piece before the boundary and a white fade-in on
//     the first duration/2 of the piece after — the classic dip-to-white
//     construction.
//   - Every video piece gets setsar=1 and every audio piece a fixed
//     44.1kHz stereo fltp aformat: concat requires identical link
//     parameters, and the synthetic fillers wouldn't otherwise match an
//     arbitrary source's SAR/sample-rate.
// concat's v=1:a=1 form expects the pieces interleaved as
// [v0][a0][v1][a1]... — one video+audio pair per piece.
function buildSegmentFilter(segments, hasAudio, transitions) {
  const AFMT = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';
  let chain = '';
  const pairLabels = [];
  let n = 0;
  let cursor = 0;

  const addBlackFiller = (gapSeconds) => {
    const d = gapSeconds.toFixed(3);
    chain += `[0:v]trim=start=0:end=${d},setpts=PTS-STARTPTS,drawbox=color=black:t=fill,setsar=1[v${n}];`;
    if (hasAudio) {
      chain += `[0:a]atrim=start=0:end=${d},asetpts=PTS-STARTPTS,volume=0,${AFMT}[a${n}];`;
      pairLabels.push(`[v${n}][a${n}]`);
    } else {
      pairLabels.push(`[v${n}]`);
    }
    n += 1;
  };

  segments.forEach((seg, i) => {
    const gap = seg.outStart - cursor;
    if (gap > 0.01) addBlackFiller(gap);

    const len = seg.end - seg.start;
    const fades = [];
    const trAfter = transitions.find((t) => t.afterIndex === i);
    if (trAfter && i < segments.length - 1) {
      const half = Math.min(trAfter.duration / 2, len / 2);
      fades.push(`fade=t=out:st=${(len - half).toFixed(3)}:d=${half.toFixed(3)}:color=white`);
    }
    const trBefore = transitions.find((t) => t.afterIndex === i - 1);
    if (trBefore) {
      const half = Math.min(trBefore.duration / 2, len / 2);
      fades.push(`fade=t=in:st=0:d=${half.toFixed(3)}:color=white`);
    }
    const fadeChain = fades.length > 0 ? `,${fades.join(',')}` : '';

    chain += `[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS,setsar=1${fadeChain}[v${n}];`;
    if (hasAudio) {
      chain += `[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS,${AFMT}[a${n}];`;
      pairLabels.push(`[v${n}][a${n}]`);
    } else {
      pairLabels.push(`[v${n}]`);
    }
    n += 1;
    cursor = seg.outStart + len;
  });

  const outLabels = hasAudio ? '[segv][sega]' : '[segv]';
  chain += `${pairLabels.join('')}concat=n=${n}:v=1:a=${hasAudio ? 1 : 0}${outLabels};`;
  return { chain, videoLabel: '[segv]', audioLabel: hasAudio ? '[sega]' : null };
}

async function runFfmpeg(inputPath, outputPath, canvasW, canvasH, zoom, blur, panX, panY, captionOverlays, mediaOverlays, audioOverlays, mirror, speed, hasAudio, segments, transitions, mediaInfo, onProgress) {
  // No trim info at all (null — no preview was ever loaded, so nothing
  // was sent) behaves exactly like this feature never existed: no -ss/-t,
  // straight [0:v]/[0:a]. A single kept range starting at output 0 (the
  // common case — just trimming the two ends) still uses fast,
  // frame-accurate input-side -ss/-t. Everything else — middle cuts,
  // free-form gaps (a lone piece placed after black counts), transitions
  // — goes through the trim/filler/concat filter chain below.
  const noTrim = !segments || segments.length === 0;
  const singleRange =
    !noTrim && segments.length === 1 && segments[0].outStart <= 0.01 && (!transitions || transitions.length === 0);
  // -progress pipe:1 streams machine-readable key=value progress lines to
  // stdout (stderr keeps the normal log for error reporting) — parsed by
  // runFfmpegWithProgress so the job status can expose a real percentage.
  const args = ['-y', '-progress', 'pipe:1', '-nostats'];
  if (singleRange) {
    if (segments[0].start > 0) args.push('-ss', segments[0].start.toFixed(3));
    args.push('-t', (segments[0].end - segments[0].start).toFixed(3));
  }
  args.push('-i', inputPath);

  // Input order: main video is always 0; the media overlay (if any) comes
  // next so it renders underneath the text layers, which are always added
  // after it so they stay the topmost layers — matching how every
  // overlay/text combination in CapCut and similar editors stacks by
  // default.
  const overlayStages = [];
  let nextInputIndex = 1;
  // Each overlay is its own input + composite stage, stacked in order (so a
  // later overlay sits on top). A video overlay is input-seeked by `offset`
  // (so a split video overlay's right half continues where it left off) and
  // crop-then-scaled; every overlay is shown only during its own window.
  for (const ov of mediaOverlays) {
    if (ov.isVideo && ov.offset > 0.01) args.push('-ss', ov.offset.toFixed(3));
    args.push('-i', ov.path);
    const overlayWidthPx = Math.round(canvasW * (ov.sizePercent / 100));
    const cl = ov.cropLeft / 100;
    const cr = ov.cropRight / 100;
    const ct = ov.cropTop / 100;
    const cb = ov.cropBottom / 100;
    const cropChain =
      cl + cr + ct + cb > 0.001
        ? `crop=iw*${(1 - cl - cr).toFixed(4)}:ih*${(1 - ct - cb).toFixed(4)}:iw*${cl.toFixed(4)}:ih*${ct.toFixed(4)},`
        : '';
    const enable =
      Number.isFinite(ov.start) && Number.isFinite(ov.end) && ov.end > ov.start
        ? `between(t,${ov.start.toFixed(3)},${ov.end.toFixed(3)})`
        : null;
    const label = `[ovlm${nextInputIndex}]`;
    overlayStages.push({
      pre: `[${nextInputIndex}:v]${cropChain}scale=${overlayWidthPx}:-2${label}`,
      inputLabel: label,
      x: `x=(main_w-overlay_w)*${(ov.xPercent / 100).toFixed(4)}`,
      y: `y=(main_h-overlay_h)*${(ov.yPercent / 100).toFixed(4)}`,
      enable,
    });
    nextInputIndex += 1;
  }
  for (const cap of captionOverlays) {
    args.push('-i', cap.pngPath);
    overlayStages.push({
      inputLabel: `[${nextInputIndex}:v]`,
      x: cap.x,
      y: cap.y,
      enable: cap.enable,
    });
    nextInputIndex += 1;
  }
  // Sound clips are audio-only, so their input order relative to the
  // video-side inputs above doesn't matter — they never appear in the video
  // filter graph, only in the audio-mixing stage below.
  const audioInputs = [];
  for (const au of audioOverlays) {
    args.push('-i', au.path);
    audioInputs.push({ idx: nextInputIndex, ...au });
    nextInputIndex += 1;
  }

  let segmentPrefix = '';
  let sourceVideoLabel = '[0:v]';
  let sourceAudioLabel = hasAudio ? '[0:a]' : null;
  if (!noTrim && !singleRange) {
    const built = buildSegmentFilter(segments, hasAudio, transitions || []);
    segmentPrefix = built.chain;
    sourceVideoLabel = built.videoLabel;
    sourceAudioLabel = built.audioLabel;
  }

  let filterComplex =
    segmentPrefix +
    buildFilterComplex(canvasW, canvasH, zoom, blur, panX, panY, overlayStages, mirror, speed, sourceVideoLabel);

  // atempo only accepts 0.5-2.0 per instance, which matches the slider's
  // own range exactly, so a single atempo call always suffices — no need
  // to chain multiple instances for extreme speed values.
  // '0:a?' (optional-stream map) only makes sense for a literal input
  // stream reference, not a filter output label — the concat path always
  // resolves sourceAudioLabel to either a real [sega] filter label or
  // null (source had no audio at all), so it's mapped directly rather
  // than through the '?' suffix.
  let audioMap = noTrim || singleRange ? '0:a?' : sourceAudioLabel;
  if (speed !== 1 && hasAudio) {
    filterComplex += `;${sourceAudioLabel}atempo=${speed}[outa]`;
    audioMap = '[outa]';
  }

  // Each sound clip is trimmed to its [trimStart,trimEnd] region of the
  // file, delayed to its timeline position (adelay, in final-video seconds
  // — the frontend already mapped across cuts and speed), and volumed, then
  // all sounds are amix'd together with the main audio. normalize=0 keeps
  // levels from dropping as more sounds are added. '0:a?' (the plain CLI
  // map) isn't valid inside a filter chain, so it's swapped for the real
  // [0:a] the moment mixing is needed.
  if (audioInputs.length > 0) {
    const sfxLabels = [];
    audioInputs.forEach((au, i) => {
      const volume = (au.volume / 100).toFixed(3);
      const trimChain =
        Number.isFinite(au.trimStart) && Number.isFinite(au.trimEnd) && au.trimEnd > au.trimStart
          ? `atrim=start=${au.trimStart.toFixed(3)}:end=${au.trimEnd.toFixed(3)},asetpts=PTS-STARTPTS,`
          : '';
      const delayMs = Math.round((au.delay || 0) * 1000);
      const delayChain = delayMs > 0 ? `adelay=${delayMs}:all=1,` : '';
      const label = `[sfx${i}]`;
      filterComplex += `;[${au.idx}:a]${trimChain}${delayChain}volume=${volume}${label}`;
      sfxLabels.push(label);
    });
    if (hasAudio) {
      const mainAudioLabel = audioMap === '0:a?' ? sourceAudioLabel : audioMap;
      filterComplex += `;${mainAudioLabel}${sfxLabels.join('')}amix=inputs=${sfxLabels.length + 1}:duration=first:dropout_transition=0:normalize=0[mixedaudio]`;
      audioMap = '[mixedaudio]';
    } else if (sfxLabels.length === 1) {
      // No source audio — the single sound becomes the whole track.
      audioMap = sfxLabels[0];
    } else {
      filterComplex += `;${sfxLabels.join('')}amix=inputs=${sfxLabels.length}:duration=first:dropout_transition=0:normalize=0[mixedaudio]`;
      audioMap = '[mixedaudio]';
    }
  }

  const outputArgs = ['-filter_complex', filterComplex, '-map', '[outv]'];
  if (audioMap) outputArgs.push('-map', audioMap);
  args.push(
    ...outputArgs,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '19',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart', // moves the moov atom to the front so <video> playback doesn't fail/stall before the file is fully downloaded
    outputPath,
  );
  await runFfmpegWithProgress(args, onProgress);
}

// Same contract as runCommand, but reads ffmpeg's -progress key=value
// stream off stdout and reports out_time to the caller. out_time_ms is —
// despite the name — in MICROseconds (a long-standing ffmpeg quirk), hence
// the 1e6 divisor.
function runFfmpegWithProgress(args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args);
    let stderr = '';
    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let newlineIdx;
      while ((newlineIdx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, newlineIdx).trim();
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        if (onProgress && line.startsWith('out_time_ms=')) {
          const micros = parseInt(line.slice('out_time_ms='.length), 10);
          if (Number.isFinite(micros) && micros >= 0) onProgress(micros / 1e6);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderr.trim().split('\n').slice(-15).join('\n');
        reject(new Error(`ffmpeg exited with code ${code}\n${tail}`));
      }
    });
  });
}

// Renders each text layer to its own temp PNG (cropped tightly to its own
// content, see caption.js) and computes its overlay x/y from the layer's
// 0-100 center-position percentages — both axes now, since editor text
// layers (unlike the old single caption) are freely draggable anywhere.
// Layers with a start/end time range get an ffmpeg enable expression so
// they only appear during their own slice of the output timeline; layers
// without one span the whole video.
function buildCaptionOverlays(jobId, textLayers, canvasW, canvasH) {
  return textLayers.map((layer, i) => {
    const { buffer, width, height } = renderCaptionPng({
      text: layer.text,
      style: layer.style,
      fontId: layer.fontId,
      dropShadow: layer.dropShadow,
      fontSize: layer.fontSize,
      color: layer.color,
      canvasWidth: canvasW,
    });
    const x = resolvePositionCoordinate(layer.xPercent, width, canvasW);
    const y = resolvePositionCoordinate(layer.yPercent, height, canvasH);
    const pngPath = path.join(CAPTIONS_DIR, `${jobId}-${i}.png`);
    fs.writeFileSync(pngPath, buffer);
    const hasRange = Number.isFinite(layer.start) && Number.isFinite(layer.end) && layer.end > layer.start;
    return {
      pngPath,
      x,
      y,
      enable: hasRange ? `between(t,${layer.start.toFixed(3)},${layer.end.toFixed(3)})` : null,
    };
  });
}

// Overlay edge crop, 0-45% off each side — clamped so the two opposite
// edges can never remove more than 90% of an axis (mirrors the frontend's
// slider clamp).
function clampCropPercent(value) {
  const pct = parseFloat(value);
  if (!Number.isFinite(pct)) return 0;
  return Math.min(45, Math.max(0, pct));
}

// Each overlay file (in the multipart 'overlay' field, order-matched to the
// JSON `overlays` metadata array) becomes an overlay descriptor:
// size/position from the sliders + drag, crop* trimming the media edges,
// start/end (FINAL-video seconds, already mapped across cuts+speed) bounding
// when it's on screen, offset (video overlays start `offset` in), isVideo.
function buildMediaOverlays(body, overlayFiles) {
  if (!overlayFiles || overlayFiles.length === 0) return [];
  let meta = [];
  try {
    meta = JSON.parse(body.overlays || '[]');
  } catch {
    meta = [];
  }
  return overlayFiles.map((file, i) => {
    const m = meta[i] || {};
    const start = parseFloat(m.start);
    const end = parseFloat(m.end);
    return {
      path: file.path,
      isVideo: !!m.isVideo,
      sizePercent: clampPositionPercent(m.sizePercent, 35),
      xPercent: clampPositionPercent(m.xPercent, 50),
      yPercent: clampPositionPercent(m.yPercent, 50),
      cropTop: clampCropPercent(m.cropTop),
      cropBottom: clampCropPercent(m.cropBottom),
      cropLeft: clampCropPercent(m.cropLeft),
      cropRight: clampCropPercent(m.cropRight),
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(end) ? end : null,
      offset: Number.isFinite(parseFloat(m.offset)) ? parseFloat(m.offset) : 0,
    };
  });
}

// Each sound file (multipart 'audioTrack' field, order-matched to the JSON
// `sounds` array) becomes a descriptor: volume, delay (FINAL-video seconds
// where it starts), and trimStart/trimEnd (the region of the file to play).
function buildAudioOverlays(body, audioFiles) {
  if (!audioFiles || audioFiles.length === 0) return [];
  let meta = [];
  try {
    meta = JSON.parse(body.sounds || '[]');
  } catch {
    meta = [];
  }
  return audioFiles.map((file, i) => {
    const m = meta[i] || {};
    const delay = parseFloat(m.delay);
    const trimStart = parseFloat(m.trimStart);
    const trimEnd = parseFloat(m.trimEnd);
    return {
      path: file.path,
      volume: clampPositionPercent(m.volume, 80),
      delay: Number.isFinite(delay) && delay > 0 ? delay : 0,
      trimStart: Number.isFinite(trimStart) ? trimStart : 0,
      trimEnd: Number.isFinite(trimEnd) ? trimEnd : null,
    };
  });
}

function findFileWithPrefix(dir, prefix) {
  const match = fs.readdirSync(dir).find((name) => name.startsWith(`${prefix}.`));
  return match ? path.join(dir, match) : null;
}

// section ({ start, end } in seconds, or null) narrows a VOD download to
// just that time range instead of pulling a whole multi-hour broadcast —
// yt-dlp's --download-sections does the range fetch, and
// --force-keyframes-at-cuts re-encodes at the boundaries so the cut is
// frame-accurate rather than snapping to the nearest (possibly seconds-
// away) keyframe.
function ytDlpArgs(url, section, outputTemplate) {
  const args = ['-o', outputTemplate, '--no-playlist'];
  if (section) {
    args.push('--download-sections', `*${section.start}-${section.end}`, '--force-keyframes-at-cuts');
  }
  args.push(url);
  return args;
}

async function downloadWithYtDlp(url, section, jobId) {
  const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);
  await runCommand(YTDLP_BIN, ytDlpArgs(url, section, outputTemplate));
  const filePath = findFileWithPrefix(DOWNLOADS_DIR, jobId);
  if (!filePath) {
    throw new Error('yt-dlp reported success but no downloaded file was found');
  }
  return filePath;
}

// The section is part of the cache key — the same VOD URL with two
// different timestamp ranges is two different downloads.
function previewCacheKey(url, section) {
  const keySource = section ? `${url}|${section.start}-${section.end}` : url;
  return crypto.createHash('sha1').update(keySource).digest('hex');
}

// Downloads a clip purely for the live preview, reusing a prior download of
// the exact same URL if one's already cached (see PREVIEW_CACHE_DIR above).
async function fetchPreviewSource(url, section) {
  const cacheKey = previewCacheKey(url, section);
  let filePath = findFileWithPrefix(PREVIEW_CACHE_DIR, cacheKey);
  if (!filePath) {
    const outputTemplate = path.join(PREVIEW_CACHE_DIR, `${cacheKey}.%(ext)s`);
    await runCommand(YTDLP_BIN, ytDlpArgs(url, section, outputTemplate));
    filePath = findFileWithPrefix(PREVIEW_CACHE_DIR, cacheKey);
    if (!filePath) {
      throw new Error('yt-dlp reported success but no downloaded file was found');
    }
  }
  return filePath;
}

// Optional VOD timestamp range riding along with a URL — both bounds in
// seconds (the frontend converts hh:mm:ss input to seconds before
// sending). Only a fully-specified, positive-length range counts;
// anything else means "whole clip", never a half-open guess.
function buildSection(body) {
  const start = parseFloat(body.sectionStart);
  const end = parseFloat(body.sectionEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  return { start, end };
}

async function processJob(jobId, inputPath, aspectRatio, zoom, blur, panX, panY, textLayers, mirror, speed, segments, transitions, mediaOverlays, audioOverlays) {
  let captionOverlays = [];
  try {
    setJob(jobId, { status: 'processing', progress: 0 });
    const outputPath = path.join(OUTPUTS_DIR, `${jobId}.mp4`);
    const { width: canvasW, height: canvasH } = ASPECT_RATIOS[aspectRatio];

    // Always probed now: hasAudio has to be genuinely known (not just
    // assumed) whenever the segment-concat path might run or a sound
    // effect needs mixing — guessing wrong is a hard ffmpeg error — the
    // source dimensions size the black gap fillers, and duration feeds
    // the export progress percentage.
    const mediaInfo = await probeSource(inputPath);

    captionOverlays = buildCaptionOverlays(jobId, textLayers, canvasW, canvasH);

    // Expected output length: the full output span — pieces plus any
    // free-form black gaps (max of outStart+len, not just the kept sum) —
    // stretched by speed. Capped at 0.99 until the process actually exits
    // cleanly, so the bar never shows "done" for a render that then fails
    // at the muxing stage.
    const outputSpan =
      segments && segments.length > 0
        ? segments.reduce((max, s) => Math.max(max, s.outStart + (s.end - s.start)), 0)
        : mediaInfo.duration || 0;
    const expectedDuration = outputSpan / speed;
    const onProgress = (outTime) => {
      if (expectedDuration > 0) {
        setJob(jobId, { progress: Math.min(0.99, outTime / expectedDuration) });
      }
    };

    await runFfmpeg(inputPath, outputPath, canvasW, canvasH, zoom, blur, panX, panY, captionOverlays, mediaOverlays, audioOverlays, mirror, speed, mediaInfo.hasAudio, segments, transitions, mediaInfo, onProgress);
    setJob(jobId, { status: 'done', progress: 1, outputUrl: `/outputs/${jobId}.mp4` });
  } catch (err) {
    setJob(jobId, { status: 'error', error: err.message });
  } finally {
    // Only the text-layer PNGs are server-generated temp artifacts cleaned
    // up here — overlay/sound uploads are genuine files,
    // left in place same as the main video upload (see the Notes section
    // in README.md).
    for (const cap of captionOverlays) {
      fs.unlink(cap.pngPath, () => {});
    }
  }
}

async function downloadAndProcess(jobId, url, section, aspectRatio, zoom, blur, panX, panY, textLayers, mirror, speed, segments, transitions, mediaOverlays, audioOverlays) {
  try {
    setJob(jobId, { status: 'downloading' });
    // If the user already fetched a live preview for this exact URL (and
    // VOD section, if any), reuse that download instead of running yt-dlp
    // a second time.
    const cachedPath = findFileWithPrefix(PREVIEW_CACHE_DIR, previewCacheKey(url, section));
    const inputPath = cachedPath || (await downloadWithYtDlp(url, section, jobId));
    await processJob(jobId, inputPath, aspectRatio, zoom, blur, panX, panY, textLayers, mirror, speed, segments, transitions, mediaOverlays, audioOverlays);
  } catch (err) {
    setJob(jobId, { status: 'error', error: err.message });
  }
}

// One shared config for every file the Generate form can submit: the main
// video (Upload tab only — the Clip URL tab has no 'video' field at all,
// since its video comes from yt-dlp instead), an optional image/video
// overlay, and optional mp3 sound-effect tracks.
// Filenames include the field name since a single job can now upload more
// than one file at once, unlike the original single-file version of this.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || (file.fieldname === 'video' ? '.mp4' : '');
      cb(null, `${req.jobId}-${file.fieldname}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});
const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'overlay', maxCount: 30 },
  { name: 'audioTrack', maxCount: 30 },
]);

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/outputs', express.static(OUTPUTS_DIR));
// Exposes the same bundled TTFs caption.js renders with, so the browser can
// load them as @font-face for the live client-side caption preview — no
// separate copy, just the one already used server-side.
app.use('/fonts', express.static(path.join(ROOT, 'fonts')));
// Serves clips fetched for the Clip URL tab's live preview (see
// PREVIEW_CACHE_DIR above) so the browser can load them into a <video>.
app.use('/preview-cache', express.static(PREVIEW_CACHE_DIR));
// Bundled overlay/SFX preset files (see /api/sfx-presets above).
app.use('/assets', express.static(path.join(ROOT, 'assets')));

app.post('/api/preview-source', async (req, res) => {
  const { url } = req.body || {};
  const trimmedUrl = typeof url === 'string' ? url.trim() : '';
  if (!isValidHttpUrl(trimmedUrl)) {
    return res.status(400).json({ error: 'Please enter a valid clip URL (starting with http:// or https://)' });
  }
  try {
    const filePath = await fetchPreviewSource(trimmedUrl, buildSection(req.body || {}));
    res.json({ previewUrl: `/preview-cache/${path.basename(filePath)}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// caption.js interpolates this directly into an SVG fill="..." attribute
// with no escaping, so this can't just be a loose sanity check — anything
// that isn't strictly `#rrggbb` is rejected outright (falls back to
// caption.js's own default) rather than risking attribute/markup
// injection from an unvalidated value.
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
function normalizeColor(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value : undefined;
}

// `textLayers` arrives as a JSON string (multipart form field) or a real
// array — each entry is one editor text layer. Every field goes through
// the same clamp/normalize guards the old single caption's fields did;
// start/end (OUTPUT-timeline seconds, already mapped by the frontend) are
// optional — a layer without them spans the whole video. Layers with no
// actual text are dropped here rather than rendering empty PNGs.
function buildTextLayers(body) {
  let raw = body.textLayers;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => ({
      text: typeof (l && l.text) === 'string' ? l.text : '',
      style: clampCaptionStyle(l && l.style),
      fontId: normalizeFontId(l && l.fontId),
      fontSize: clampFontSize(l && l.fontSize),
      color: normalizeColor(l && l.color),
      dropShadow: normalizeDropShadow(l && l.dropShadow),
      xPercent: clampPositionPercent(l && l.xPercent, 50),
      yPercent: clampPositionPercent(l && l.yPercent, 25),
      start: Number.isFinite(parseFloat(l && l.start)) ? parseFloat(l.start) : null,
      end: Number.isFinite(parseFloat(l && l.end)) ? parseFloat(l.end) : null,
    }))
    .filter((l) => l.text.trim());
}

// Both Generate routes now always arrive as multipart/form-data (not JSON)
// — even the Clip URL tab, which has no video file of its own, still needs
// multipart so an optional overlay image/video or sound-effect mp3 can
// ride along in the same request. uploadFields tolerates fields it wasn't
// sent (req.files.overlay etc. just come back undefined) so this is a
// harmless superset for a request that only ever sends a URL.
app.post('/api/process-url', (req, res, next) => { req.jobId = crypto.randomUUID(); next(); }, uploadFields, (req, res) => {
  const { url, zoom, blur, mirror, speed } = req.body || {};
  const trimmedUrl = typeof url === 'string' ? url.trim() : '';
  if (!isValidHttpUrl(trimmedUrl)) {
    return res.status(400).json({ error: 'Please enter a valid clip URL (starting with http:// or https://)' });
  }

  const jobId = req.jobId;
  jobs.set(jobId, { status: 'downloading' });
  res.json({ jobId });
  downloadAndProcess(
    jobId,
    trimmedUrl,
    buildSection(req.body || {}),
    normalizeAspectRatio(req.body.aspectRatio),
    clampZoom(zoom),
    clampBlur(blur),
    clampPan(req.body.panX),
    clampPan(req.body.panY),
    buildTextLayers(req.body || {}),
    normalizeMirror(mirror),
    clampSpeed(speed),
    buildSegments(req.body || {}),
    buildTransitions(req.body || {}),
    buildMediaOverlays(req.body || {}, req.files.overlay),
    buildAudioOverlays(req.body || {}, req.files.audioTrack)
  );
});

app.post(
  '/api/process-upload',
  (req, res, next) => {
    req.jobId = crypto.randomUUID();
    next();
  },
  uploadFields,
  (req, res) => {
    const videoFile = req.files.video && req.files.video[0];
    if (!videoFile) {
      return res.status(400).json({ error: 'A video file is required' });
    }
    const jobId = req.jobId;
    jobs.set(jobId, { status: 'processing' });
    res.json({ jobId });
    processJob(
      jobId,
      videoFile.path,
      normalizeAspectRatio(req.body.aspectRatio),
      clampZoom(req.body.zoom),
      clampBlur(req.body.blur),
      clampPan(req.body.panX),
      clampPan(req.body.panY),
      buildTextLayers(req.body),
      normalizeMirror(req.body.mirror),
      clampSpeed(req.body.speed),
      buildSegments(req.body),
      buildTransitions(req.body),
      buildMediaOverlays(req.body, req.files.overlay),
      buildAudioOverlays(req.body, req.files.audioTrack)
    );
  }
);

// Auto-captions: transcribes either an uploaded video file or a clip URL
// (reusing the preview cache — by the time anyone asks for captions the
// clip is almost always already downloaded). Returned timestamps are in
// SOURCE time — the same domain the editor timeline works in — so the
// frontend can drop them straight onto the text track. Synchronous
// (one await, no job queue): a 60s clip transcribes in seconds with the
// base model, not long enough to justify polling machinery.
app.post('/api/transcribe', (req, res, next) => { req.jobId = crypto.randomUUID(); next(); }, uploadFields, async (req, res) => {
  try {
    let inputPath;
    const videoFile = req.files.video && req.files.video[0];
    if (videoFile) {
      inputPath = videoFile.path;
    } else {
      const trimmedUrl = typeof (req.body || {}).url === 'string' ? req.body.url.trim() : '';
      if (!isValidHttpUrl(trimmedUrl)) {
        return res.status(400).json({ error: 'Provide a video file or a valid clip URL to transcribe' });
      }
      inputPath = await fetchPreviewSource(trimmedUrl, buildSection(req.body || {}));
    }
    const segments = await transcribeSource(inputPath, {
      ffmpegBin: FFMPEG_BIN,
      resourcesDir: process.env.CLIP_EDITOR_RESOURCES,
      modelsDir: MODELS_DIR,
      workDir: TRANSCRIBE_DIR,
      // 'words' = one caption per word (TikTok style), 'blocks' = short
      // multi-word lines. Anything else falls back to blocks.
      mode: (req.body || {}).mode === 'words' ? 'words' : 'blocks',
    });
    res.json({ segments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lets the frontend show/hide the Auto captions button (and point at the
// right missing piece) without triggering a whole failed transcription.
app.get('/api/whisper-status', (req, res) => {
  const setup = checkWhisperSetup({ resourcesDir: process.env.CLIP_EDITOR_RESOURCES, modelsDir: MODELS_DIR });
  res.json({ ready: setup.ready, binaryFound: !!setup.binary, modelFound: !!setup.model });
});

// Bundled preset packs the Overlay/Sound tabs offer alongside "use your
// own file" — just whatever files sit in assets/sfx and assets/overlays,
// so adding a preset for everyone is literally dropping a file in the
// folder. Names are prettied-up filenames; the files themselves are
// served by the express.static('/assets') mount below.
function listPresets(dir, urlPrefix, extensions) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => extensions.test(name))
    .sort()
    .map((name) => ({
      id: name,
      label: name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      url: `${urlPrefix}/${encodeURIComponent(name)}`,
    }));
}

app.get('/api/sfx-presets', (req, res) => {
  res.json({ presets: listPresets(path.join(ROOT, 'assets', 'sfx'), '/assets/sfx', /\.(mp3|wav|ogg|m4a)$/i) });
});

app.get('/api/overlay-presets', (req, res) => {
  res.json({ presets: listPresets(path.join(ROOT, 'assets', 'overlays'), '/assets/overlays', /\.(png|jpe?g|gif|webp|webm|mp4|mov)$/i) });
});

app.get('/api/fonts', (req, res) => {
  res.json({ fonts: getFontOptions() });
});

app.get('/api/aspect-ratios', (req, res) => {
  res.json({ aspectRatios: getAspectRatioOptions() });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Unknown job id' });
  }
  res.json(job);
});

resolveFontPath(); // logs which caption font got resolved, right at boot

app.listen(PORT, () => {
  console.log(`Clip Vertical Editor running at http://localhost:${PORT}`);
});
