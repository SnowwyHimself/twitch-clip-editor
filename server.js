const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const { renderCaptionPng, resolveFontPath, getFontOptions, isValidFontBuffer } = require('./caption');
const {
  transcribeSource,
  checkWhisperSetup,
  CAPTION_TIERS,
  TIER_ORDER,
  DEFAULT_TIER,
  tierAvailability,
  tierModelPath,
} = require('./transcribe');

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
// Saved editor projects — one folder per project holding project.json plus a
// media/ subfolder for any imported sound/overlay files, so a project reopens
// self-contained. The special id 'autosave' is the rolling autosave slot.
const PROJECTS_DIR = path.join(DATA_ROOT, 'projects');
const TEMPLATES_DIR = path.join(DATA_ROOT, 'templates');
// Global brand kit (default font/colour + a reusable watermark image). Lives in
// userData so it's shared across projects and survives app updates.
const BRAND_DIR = path.join(DATA_ROOT, 'brand-kit');

// Personal asset library: sounds/music/overlays/fonts a user imports once and
// reuses across every project. Global, per-user, survives updates (userData).
// A flat library.json index sits at the root; each category holds the files.
const LIBRARY_DIR = path.join(DATA_ROOT, 'library');
const LIBRARY_CATEGORIES = ['sounds', 'music', 'overlays', 'fonts'];
const LIBRARY_INDEX = path.join(LIBRARY_DIR, 'library.json');
// Accepted extensions per category. woff2 is intentionally excluded from fonts:
// the export renderer (resvg-js / opentype.js) loads glyphs from ttf/otf, so a
// woff2 would preview but fail to export — reject it up front with a message.
const LIBRARY_EXT = {
  sounds: /\.(mp3|wav|ogg|m4a|aac|flac)$/i,
  music: /\.(mp3|wav|ogg|m4a|aac|flac)$/i,
  overlays: /\.(png|jpe?g|gif|webp|webm|mp4|mov)$/i,
  fonts: /\.(ttf|otf)$/i,
};

for (const dir of [UPLOADS_DIR, DOWNLOADS_DIR, OUTPUTS_DIR, CAPTIONS_DIR, PREVIEW_CACHE_DIR, MODELS_DIR, TRANSCRIBE_DIR, PROJECTS_DIR, TEMPLATES_DIR, BRAND_DIR, LIBRARY_DIR, ...LIBRARY_CATEGORIES.map((c) => path.join(LIBRARY_DIR, c))]) {
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
// jobId -> the live ffmpeg child, so an export can be cancelled mid-render.
const exportChildren = new Map();

function createJob() {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'queued' });
  return jobId;
}

function setJob(jobId, patch) {
  jobs.set(jobId, { ...jobs.get(jobId), ...patch });
}

// True once the client asked to cancel this job — checked around the render so a
// cancel that lands before ffmpeg spawns still aborts.
const cancelledJobs = new Set();

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

// Only real Twitch clip/VOD hosts may reach yt-dlp. Before this, any http/https
// URL was accepted, so yt-dlp — which supports hundreds of sites and will fetch
// internal/SSRF targets — could be pointed anywhere. Restrict to Twitch.
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'clips.twitch.tv', 'm.twitch.tv']);
function isTwitchClipUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return TWITCH_HOSTS.has(parsed.hostname.toLowerCase());
}
const TWITCH_URL_ERROR = 'Please paste a Twitch clip or VOD link (twitch.tv / clips.twitch.tv).';

// Guarantees a resolved path stays inside baseDir — throws otherwise. Applied
// wherever outside input contributes to a filesystem path (project/media/upload
// leaves, preview-cache keys, etc.) so no ".." or absolute path can escape.
function resolveInside(baseDir, ...parts) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, ...parts);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('path escapes base directory');
  }
  return resolved;
}

// A single path segment safe to use as a filename: no separators, null bytes,
// control chars, or leading dashes (which a CLI could read as a flag); length
// capped. Returns '' if nothing safe remains.
function safeLeaf(name) {
  const base = path
    .basename(String(name == null ? "" : name)) // strips any directory part
    .replace(/[\x00-\x1f\x7f]/g, "") // null byte + control chars
    .replace(/[^a-zA-Z0-9_.-]/g, "") // keep only a safe set (drops / \\ : space etc.)
    .replace(/^[-.]+/, ""); // no leading dash (flag injection) or dot ("..", hidden)
  return base.slice(0, 120);
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
// Zoom/position keyframes for the animated main-clip transform. Times arrive
// already in OUTPUT seconds (the frontend maps source→output across cuts/speed
// before sending), so the server just validates/clamps and sorts them.
function buildKeyframes(body) {
  let raw = body.keyframes;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const cleaned = raw
    .map((k) => ({
      t: parseFloat(k && k.t),
      zoom: clampZoom(k && k.zoom),
      panX: clampPan(k && k.panX),
      panY: clampPan(k && k.panY),
    }))
    .filter((k) => Number.isFinite(k.t) && k.t >= 0)
    .sort((a, b) => a.t - b.t);
  return cleaned;
}

// Face-tracking auto-reframe path: [{ t (output s), x (0..1 face centre), z }].
function buildFaceTrack(body) {
  let raw = body.faceTrack;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const samples = raw
    .map((s) => ({
      t: parseFloat(s && s.t),
      x: Math.max(0, Math.min(1, parseFloat(s && s.x))),
      z: Number.isFinite(parseFloat(s && s.z)) ? Math.max(1, parseFloat(s.z)) : 1,
    }))
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.x) && s.t >= 0)
    .sort((a, b) => a.t - b.t);
  // Global tracked-shot tightness rides along on the array (1..3) so it reaches
  // buildFaceTrackBase without threading a new arg through the whole chain.
  const z = parseFloat(body.faceZoom);
  samples.zoom = Number.isFinite(z) ? Math.max(1, Math.min(3, z)) : 1;
  return samples;
}

// Facecam split config { ratio, facecam:{cx,cy,zoom}, gameplay:{cx,cy,zoom} }.
// Only returned when layout === 'split'.
function buildSplit(body) {
  if (body.layout !== 'split') return null;
  let raw = body.split;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const region = (r) => ({
    cx: Math.max(0, Math.min(1, parseFloat(r && r.cx))) || 0.5,
    cy: Math.max(0, Math.min(1, parseFloat(r && r.cy))) || 0.5,
    zoom: Math.max(1, parseFloat(r && r.zoom) || 1),
  });
  return {
    ratio: Math.max(0.15, Math.min(0.85, parseFloat(raw.ratio) || 0.34)),
    facecam: region(raw.facecam),
    gameplay: region(raw.gameplay),
  };
}

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
      settings: parsePieceSettings(s && s.settings),
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
      color: t && t.color === 'black' ? 'black' : 'white',
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

// Per-layer text-box wrap width, as a fraction of canvas width. Must match the
// frontend clamp (state.js clampWrapWidth) so preview and render wrap the same;
// undefined falls back to the legacy fixed ratio (900/1080).
const TEXT_WRAP_DEFAULT = 900 / 1080;
function clampWrapRatio(value) {
  const r = parseFloat(value);
  if (!Number.isFinite(r)) return TEXT_WRAP_DEFAULT;
  return Math.min(1, Math.max(0.15, r));
}

// Audio volume 0-200% (100 = untouched). Matches the frontend clamp so a
// boosted clip renders at the level the user set.
function clampVolumePercent(value, fallback = 100) {
  const v = parseFloat(value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(200, Math.max(0, v));
}

// Non-negative fade length in seconds, capped so a bad value can't wedge afade.
function clampFadeSeconds(value) {
  const v = parseFloat(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(30, v);
}

// Caption entrance animation params — MUST match preview.js so every entrance
// looks identical in preview and render.
const CAP_ANIM_DURATION = 0.25;
const CAP_SLIDE_FRAC = 0.04;
const CAP_BOUNCE_FRAC = 0.06;
const CAP_SHAKE_FRAC = 0.018;
const CAP_SHAKE_CYCLES = 3;
const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;

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

// Caps concurrent heavy child processes (yt-dlp downloads, ffmpeg renders,
// whisper transcriptions) so a burst of jobs can't spawn unbounded processes and
// exhaust CPU/RAM/disk. Acquire before spawning, release in a finally.
const MAX_HEAVY_PROCS = 3;
let heavyActive = 0;
const heavyQueue = [];
function acquireHeavySlot() {
  if (heavyActive < MAX_HEAVY_PROCS) {
    heavyActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => heavyQueue.push(resolve));
}
function releaseHeavySlot() {
  heavyActive -= 1;
  const next = heavyQueue.shift();
  if (next) {
    heavyActive += 1;
    next();
  }
}

const COMMAND_TIMEOUT_MS = 15 * 60 * 1000; // 15 min: a hung yt-dlp/ffmpeg is killed, not left forever

function runCommand(cmd, args, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL'); // don't leave a stalled network download running
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s and was killed`));
      } else if (code === 0) {
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
      // Frame rate — only needed to drive keyframed zoom/pan (zoompan works in
      // frame indices). Falls back to 30 when the token isn't present.
      const fpsMatch = stderr.match(/(\d+(?:\.\d+)?)\s*fps/);
      const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;
      resolve({ width: parseInt(videoMatch[1], 10), height: parseInt(videoMatch[2], 10), hasAudio, duration, fps });
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
// Builds an ffmpeg expression (in terms of zoompan's output-frame counter
// `on`) that interpolates one keyframe property over time with the same
// smoothstep ease the live preview uses. Keyframe times are OUTPUT seconds
// (the frontend already mapped them across cuts/speed), so time = on/fps.
function buildKeyframeExpr(keyframes, prop, fps) {
  const T = `(on/${fps})`;
  const n = keyframes.length;
  if (n === 1) return `${keyframes[0][prop]}`;
  let expr = `${keyframes[n - 1][prop]}`; // past the last keyframe: hold it
  for (let i = n - 2; i >= 0; i--) {
    const ta = keyframes[i].t;
    const tb = keyframes[i + 1].t;
    const va = keyframes[i][prop];
    const vb = keyframes[i + 1][prop];
    const span = tb - ta || 1e-6;
    const u = `clip((${T}-${ta})/${span},0,1)`;
    const seg = `(${va})+(${vb - va})*((${u})*(${u})*(3-2*(${u})))`;
    expr = `if(lt(${T},${tb}),${seg},${expr})`;
  }
  return expr;
}

// Time-varying zoom+pan for the main clip, applied to the finished (blur-bg +
// fg) composite via zoompan. Pan is % of half-canvas in OUTPUT px; dividing
// by zoom converts to input px (zoompan scales its window up by zoom). x/y are
// clamped to the valid window range so zoom=1 (no room) simply doesn't pan.
function buildKeyframeZoompan(canvasW, canvasH, keyframes, fps) {
  const zExpr = buildKeyframeExpr(keyframes, 'zoom', fps);
  const pxExpr = buildKeyframeExpr(keyframes, 'panX', fps);
  const pyExpr = buildKeyframeExpr(keyframes, 'panY', fps);
  const x = `clip((iw/2)*(1-1/zoom)-((${pxExpr})/100)*(iw/2)/zoom,0,iw-iw/zoom)`;
  const y = `clip((ih/2)*(1-1/zoom)-((${pyExpr})/100)*(ih/2)/zoom,0,ih-ih/zoom)`;
  return `zoompan=z='${zExpr}':x='${x}':y='${y}':d=1:s=${canvasW}x${canvasH}:fps=${fps}`;
}

// Piecewise-linear interpolation of a face-track property over output time
// (crop's x expression is evaluated per frame with variable `t`).
function buildFaceExpr(samples, prop) {
  const T = 't';
  const n = samples.length;
  if (n === 1) return `${samples[0][prop]}`;
  let expr = `${samples[n - 1][prop]}`;
  for (let i = n - 2; i >= 0; i--) {
    const ta = samples[i].t;
    const tb = samples[i + 1].t;
    const va = samples[i][prop];
    const vb = samples[i + 1][prop];
    const span = tb - ta || 1e-6;
    const u = `clip((${T}-${ta})/${span},0,1)`;
    expr = `if(lt(${T},${tb}),(${va})+(${vb - va})*(${u}),${expr})`;
  }
  return expr;
}

// Face-tracking reframe base: scale the source to COVER the canvas, then crop a
// canvas-sized window whose x follows the face (clamped to the source edges, so
// it's always fully filled — no black bars). Horizontal only; y stays centered.
function buildFaceTrackBase(canvasW, canvasH, faceTrack, sourceLabel, speed, mirror) {
  const { stage, labels } = buildSourcePrefix(sourceLabel, speed, mirror, 1);
  const [fgSource] = labels;
  const xExpr = buildFaceExpr(faceTrack, 'x');
  // Tighter shot: crop a canvas/zoom window from the cover-scaled source, then
  // scale it back up to the canvas. zoom=1 crops canvas-sized (unchanged).
  const zoom = Math.max(1, faceTrack.zoom || 1);
  const cw = evenInt(canvasW / zoom);
  const ch = evenInt(canvasH / zoom);
  const cover = `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase`;
  const crop = `crop=${cw}:${ch}:x='clip((iw-${cw})*(${xExpr}),0,iw-${cw})':y='(ih-${ch})/2'`;
  const rescale = zoom > 1 ? `,scale=${canvasW}:${canvasH}` : '';
  return `${stage}${fgSource}${cover},${crop}${rescale}[c0]`;
}

function evenInt(n) {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

// Source-space crop window for one split region — the SAME formula the preview
// uses (see preview.js splitCropWindow) so the render matches pixel-for-pixel.
function splitCropWindowServer(srcW, srcH, regionAspect, region) {
  const baseW = Math.min(srcW, srcH * regionAspect);
  const cropW = baseW / Math.max(1, (region && region.zoom) || 1);
  const cropH = cropW / regionAspect;
  const cx = (region && region.cx) != null ? region.cx : 0.5;
  const cy = (region && region.cy) != null ? region.cy : 0.5;
  const winX = Math.max(0, Math.min(srcW - cropW, cx * srcW - cropW / 2));
  const winY = Math.max(0, Math.min(srcH - cropH, cy * srcH - cropH / 2));
  return { cropW, cropH, winX, winY };
}

// Facecam split base: crop the facecam window to the top region and the
// gameplay window to the bottom region, then vstack them into the full canvas.
function buildSplitBase(canvasW, canvasH, split, srcW, srcH, sourceLabel, speed, mirror) {
  const { stage, labels } = buildSourcePrefix(sourceLabel, speed, mirror, 2);
  const [topSrc, botSrc] = labels;
  const ratio = Math.max(0.15, Math.min(0.85, split.ratio || 0.34));
  const topH = evenInt(canvasH * ratio);
  const botH = canvasH - topH;
  const regionChain = (win, w, h) => {
    const cw = Math.max(2, evenInt(win.cropW));
    const ch = Math.max(2, evenInt(win.cropH));
    const wx = Math.max(0, Math.min(srcW - cw, Math.round(win.winX)));
    const wy = Math.max(0, Math.min(srcH - ch, Math.round(win.winY)));
    return `crop=${cw}:${ch}:${wx}:${wy},scale=${w}:${h}`;
  };
  const topWin = splitCropWindowServer(srcW, srcH, canvasW / topH, split.facecam);
  const botWin = splitCropWindowServer(srcW, srcH, canvasW / botH, split.gameplay);
  let graph = stage;
  graph += `${topSrc}${regionChain(topWin, canvasW, topH)}[sptop]`;
  graph += `;${botSrc}${regionChain(botWin, canvasW, botH)}[spbot]`;
  graph += `;[sptop][spbot]vstack[c0]`;
  return graph;
}

// Stacks the caption/media overlay stages onto a base composite and finalises.
function composeOverlayStages(graph, overlayStages, startLabel) {
  let current = startLabel || '[c0]';
  overlayStages.forEach((stage, i) => {
    const next = `[c${i + 1}]`;
    if (stage.pre) graph += `;${stage.pre}`;
    const enable = stage.enable ? `:enable='${stage.enable}'` : '';
    graph += `;${current}${stage.inputLabel}overlay=${stage.x}:${stage.y}${enable}${next}`;
    current = next;
  });
  return `${graph};${current}setsar=1[outv]`;
}

// Applies the color grade to the composite `label` (grading footage, before
// captions/overlays). Returns the graph + the new label to stack overlays on.
function withColorGrade(graph, label, color) {
  const chain = colorGradeChain(color);
  if (!chain) return { graph, label };
  return { graph: `${graph};${label}${chain}[cgrade]`, label: '[cgrade]' };
}

// Per-piece video settings (B6): { zoom, panX, panY, blur, color }. Missing =
// neutral, so a piece without settings renders exactly as before.
function parsePieceSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const c = r.color && typeof r.color === 'object' ? r.color : {};
  return {
    zoom: Number.isFinite(parseFloat(r.zoom)) ? Math.max(1, parseFloat(r.zoom)) : 1,
    panX: Number.isFinite(parseFloat(r.panX)) ? parseFloat(r.panX) : 0,
    panY: Number.isFinite(parseFloat(r.panY)) ? parseFloat(r.panY) : 0,
    blur: Number.isFinite(parseFloat(r.blur)) ? Math.max(0, parseFloat(r.blur)) : 0,
    color: {
      brightness: parseFloat(c.brightness) || 0,
      contrast: parseFloat(c.contrast) || 0,
      saturation: parseFloat(c.saturation) || 0,
    },
    crop: parseCrop(r.crop),
  };
}

// Main-clip crop { top,bottom,left,right } as % per edge. Clamped so each axis
// keeps a >=2% sliver (matching the client's clampMainCropValue).
function parseCrop(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const v = (x) => Math.max(0, Math.min(98, parseFloat(x) || 0));
  let top = v(c.top);
  let bottom = v(c.bottom);
  let left = v(c.left);
  let right = v(c.right);
  if (top + bottom > 98) { const s = 98 / (top + bottom); top *= s; bottom *= s; }
  if (left + right > 98) { const s = 98 / (left + right); left *= s; right *= s; }
  return { top, bottom, left, right };
}

// ffmpeg `crop` of the kept sub-rectangle, applied to the source BEFORE the fill
// composite (and before hflip) so the kept region fills the canvas exactly like
// the preview's CSS object-view-box. Returns '' when nothing is cropped.
function cropChain(crop) {
  const c = crop && typeof crop === 'object' ? crop : null;
  if (!c) return '';
  const { top = 0, bottom = 0, left = 0, right = 0 } = c;
  if (top + bottom + left + right <= 0.001) return '';
  const w = (1 - (left + right) / 100).toFixed(6);
  const h = (1 - (top + bottom) / 100).toFixed(6);
  const x = (left / 100).toFixed(6);
  const y = (top / 100).toFixed(6);
  return `crop=w=iw*${w}:h=ih*${h}:x=iw*${x}:y=ih*${y}`;
}

// True if any piece's settings differ from the first — i.e. per-piece rendering
// is actually needed (otherwise the cheaper global transform suffices).
function pieceSettingsDiffer(list) {
  if (!Array.isArray(list) || list.length < 2) return false;
  const key = (s) => {
    const cr = s.crop || {};
    return JSON.stringify([
      s.zoom, s.panX, s.panY, s.blur,
      s.color.brightness, s.color.contrast, s.color.saturation,
      cr.top || 0, cr.bottom || 0, cr.left || 0, cr.right || 0,
    ]);
  };
  const first = key(list[0].settings || parsePieceSettings());
  return list.some((p) => key(p.settings || parsePieceSettings()) !== first);
}

// Per-piece transform + grade: applies one piece's zoom/pan/blur/colour to an
// already-trimmed, speed/mirror-neutral segment video (inLabel), producing a
// canvas-sized graded output. Mirrors buildFilterComplex's normal fill path but
// per segment; labels are indexed so many coexist in one graph. Speed and mirror
// stay global (applied once to the concat, downstream).
function buildPieceComposite(canvasW, canvasH, s, inLabel, idx) {
  const set = parsePieceSettings(s);
  const zoom = Math.max(1, set.zoom);
  const fgWidth = Math.round((canvasW * zoom) / 2) * 2;
  const panXpx = Math.round((set.panX / 100) * (canvasW / 2));
  const panYpx = Math.round((set.panY / 100) * (canvasH / 2));
  const panXExpr = panXpx !== 0 ? `+(${panXpx})` : '';
  const panYExpr = panYpx !== 0 ? `+(${panYpx})` : '';
  const bgFill = set.blur > 0 ? `gblur=sigma=${set.blur}` : `drawbox=color=black:t=fill`;
  const grade = colorGradeChain(set.color);
  const bg = `pcbg${idx}`;
  const fg = `pcfg${idx}`;
  const ov = `pcov${idx}`;
  const out = `pc${idx}`;
  // Crop the source region first (this piece's video is still unmirrored here —
  // mirror is applied globally downstream — so the crop matches the preview,
  // which crops before its own mirror transform).
  const cc = cropChain(set.crop);
  let chain = `${inLabel}${cc ? cc + ',' : ''}split=2[${bg}][${fg}];`;
  chain += `[${bg}]scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH},${bgFill}[${bg}o];`;
  chain += `[${fg}]scale=${fgWidth}:-2,crop=${canvasW}:ih:(iw-${canvasW})/2:0[${fg}o];`;
  const overlay = `[${bg}o][${fg}o]overlay=(W-w)/2${panXExpr}:(H-h)/2${panYExpr}`;
  if (grade) chain += `${overlay}[${ov}];[${ov}]${grade}[${out}];`;
  else chain += `${overlay}[${out}];`;
  return { chain, outLabel: `[${out}]` };
}

function buildFilterComplex(canvasW, canvasH, zoom, blur, panX, panY, overlayStages, mirror, speed, sourceLabel, keyframes, fps, faceTrack, split, srcW, srcH, color, crop, preComposited) {
  // Per-piece path: the base is already a canvas-sized, per-piece-transformed,
  // graded video (see buildSegmentFilter). Only apply global speed/mirror, then
  // stack captions/overlays.
  if (preComposited) {
    const { stage, labels } = buildSourcePrefix(sourceLabel, speed, mirror, 1);
    const graph = `${stage}${labels[0]}setsar=1[c0]`;
    return composeOverlayStages(graph, overlayStages, '[c0]');
  }
  // Facecam split layout overrides the fill composite entirely.
  if (split && srcW && srcH) {
    const g = withColorGrade(buildSplitBase(canvasW, canvasH, split, srcW, srcH, sourceLabel, speed, mirror), '[c0]', color);
    return composeOverlayStages(g.graph, overlayStages, g.label);
  }
  // Face-tracking overrides the normal blur-bg composite with a frame-filling
  // reframe that pans to follow the chosen face.
  if (Array.isArray(faceTrack) && faceTrack.length >= 1) {
    const g = withColorGrade(buildFaceTrackBase(canvasW, canvasH, faceTrack, sourceLabel, speed, mirror), '[c0]', color);
    return composeOverlayStages(g.graph, overlayStages, g.label);
  }
  // With keyframes, zoom/pan are animated per-frame by a zoompan applied to
  // the finished composite (below), so the base is built neutral (zoom 1, no
  // pan) and zoompan does the moving. Without keyframes it's the static look.
  const hasKeyframes = Array.isArray(keyframes) && keyframes.length >= 1;
  const baseZoom = hasKeyframes ? 1 : zoom;
  const basePanX = hasKeyframes ? 0 : panX;
  const basePanY = hasKeyframes ? 0 : panY;

  const fgWidth = Math.round((canvasW * baseZoom) / 2) * 2;
  const fgChain = `scale=${fgWidth}:-2,crop=${canvasW}:ih:(iw-${canvasW})/2:0`;

  // pan moves the sharp foreground over the background, in canvas pixels
  // (panX/panY are % of half the canvas; 0 = centered). Both blur>0 and
  // blur=0 now composite via overlay on a full-canvas background (blurred,
  // or a black frame DERIVED FROM THE SOURCE via drawbox — never a `color`
  // filter source, whose fps/timebase mismatch makes concat/overlay
  // misbehave) so panning works identically at any blur.
  const panXpx = Math.round((basePanX / 100) * (canvasW / 2));
  const panYpx = Math.round((basePanY / 100) * (canvasH / 2));
  const panXExpr = panXpx !== 0 ? `+(${panXpx})` : '';
  const panYExpr = panYpx !== 0 ? `+(${panYpx})` : '';

  // Crop the source region FIRST — before speed/mirror/split — so an asymmetric
  // crop lands on the unmirrored image, matching the preview's object-view-box
  // (which crops the source before the mirror transform). '' when uncropped.
  const cc = cropChain(crop);
  let cropPrefix = '';
  let croppedSource = sourceLabel;
  if (cc) {
    cropPrefix = `${sourceLabel}${cc}[crsrc];`;
    croppedSource = '[crsrc]';
  }
  const { stage, labels } = buildSourcePrefix(croppedSource, speed, mirror, 2);
  const [bgSource, fgSource] = labels;
  const bgFill = blur > 0 ? `gblur=sigma=${blur}` : `drawbox=color=black:t=fill`;
  const bg = `${bgSource}scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH},${bgFill}[bg]`;
  const fg = `${fgSource}${fgChain}[fg]`;
  const overlay = `[bg][fg]overlay=(W-w)/2${panXExpr}:(H-h)/2${panYExpr}[c0]`;
  let graph = `${cropPrefix}${stage}${bg};${fg};${overlay}`;

  let current = '[c0]';
  // Animate zoom/pan over the composite (captions/overlays are added AFTER,
  // so they don't get zoomed with the clip).
  if (hasKeyframes) {
    graph += `;[c0]${buildKeyframeZoompan(canvasW, canvasH, keyframes, fps)}[c0z]`;
    current = '[c0z]';
  }
  const g = withColorGrade(graph, current, color);
  return composeOverlayStages(g.graph, overlayStages, g.label);
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
function buildSegmentFilter(segments, hasAudio, transitions, perPiece, canvasW, canvasH) {
  const AFMT = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';
  let chain = '';
  const pairLabels = [];
  let n = 0;
  let cursor = 0;

  const addBlackFiller = (gapSeconds) => {
    const d = gapSeconds.toFixed(3);
    // In per-piece mode the real pieces are canvas-sized (composite), so the
    // filler must be too, or concat's identical-link-params rule fails.
    const sizeToCanvas = perPiece ? `,scale=${canvasW}:${canvasH}` : '';
    // A final trim=end=${d} re-bounds the filler to exactly ${d}s: because [0:v]
    // is also consumed by the real segments, ffmpeg's split otherwise lets the
    // leading trim leak extra frames and inflates the concat by the gap length.
    chain += `[0:v]trim=start=0:end=${d},setpts=PTS-STARTPTS${sizeToCanvas},drawbox=color=black:t=fill,setsar=1,trim=end=${d},setpts=PTS-STARTPTS[v${n}];`;
    if (hasAudio) {
      chain += `[0:a]atrim=start=0:end=${d},asetpts=PTS-STARTPTS,volume=0,${AFMT},atrim=end=${d},asetpts=PTS-STARTPTS[a${n}];`;
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
      fades.push(`fade=t=out:st=${(len - half).toFixed(3)}:d=${half.toFixed(3)}:color=${trAfter.color || 'white'}`);
    }
    const trBefore = transitions.find((t) => t.afterIndex === i - 1);
    if (trBefore) {
      const half = Math.min(trBefore.duration / 2, len / 2);
      fades.push(`fade=t=in:st=0:d=${half.toFixed(3)}:color=${trBefore.color || 'white'}`);
    }
    const fadeChain = fades.length > 0 ? `,${fades.join(',')}` : '';

    if (perPiece) {
      // Trim → per-piece composite (canvas-sized + graded) → fades on the full
      // frame. Speed/mirror are applied globally downstream.
      chain += `[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS,setsar=1[raw${n}];`;
      const comp = buildPieceComposite(canvasW, canvasH, seg.settings, `[raw${n}]`, n);
      chain += comp.chain;
      chain += `${comp.outLabel}${fadeChain ? fadeChain.replace(/^,/, '') : 'null'}[v${n}];`;
    } else {
      chain += `[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS,setsar=1${fadeChain}[v${n}];`;
    }
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

// Sequential multi-source concat: the primary clip's kept pieces (with the same
// gap-filler + white-transition handling as buildSegmentFilter) followed by the
// appended clips, in order. EVERY piece is normalized to a common WxH/fps/sar/
// pix_fmt (the primary's) so concat — which demands identical link params —
// accepts pieces from differently-encoded sources. Used only when there ARE
// appended clips; the plain single-source path above is untouched otherwise.
function buildStitchedFilter(segments, transitions, hasAudio, W, H, fps, appended, appendedInputStart, perPiece, primaryDuration) {
  const AFMT = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';
  const NV = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`;
  // concat needs identical fps/pixfmt/sar; composite output gets this suffix.
  const NORM = `fps=${fps},format=yuv420p,setsar=1`;
  // Per-piece: replace the letterbox NV with each piece's own reframe/blur/grade
  // composite (canvas-sized), then normalise for concat.
  const pieceVideo = (inLabel, settings, idx, fadeChain) => {
    if (!perPiece) return `${inLabel},${NV}${fadeChain}[v${n}];`;
    const comp = buildPieceComposite(W, H, settings, `[straw${idx}]`, `st${idx}`);
    return `${inLabel}[straw${idx}];${comp.chain}${comp.outLabel}${NORM}${fadeChain}[v${n}];`;
  };
  let chain = '';
  const pairLabels = [];
  let n = 0;
  let cursor = 0;
  const pushPair = (v, a) => {
    pairLabels.push(hasAudio ? `[v${n}][a${n}]` : `[v${n}]`);
    n += 1;
  };
  const addBlackFiller = (gapSeconds) => {
    const d = gapSeconds.toFixed(3);
    // The filler is derived from [0:v]/[0:a] (never a `color` source, whose
    // fps/timebase mismatch breaks concat — see runFfmpeg notes). But because
    // [0:v] is ALSO consumed by the primary segments, ffmpeg's split lets the
    // filler's leading trim pass a few extra frames, inflating the concat by up
    // to the gap length. A FINAL trim=end=${d} (after all transforms) re-bounds
    // it to exactly ${d}s so the black gap is the length the timeline shows.
    chain += `[0:v]trim=start=0:end=${d},setpts=PTS-STARTPTS,drawbox=color=black:t=fill,${NV},trim=end=${d},setpts=PTS-STARTPTS[v${n}];`;
    if (hasAudio) chain += `[0:a]atrim=start=0:end=${d},asetpts=PTS-STARTPTS,volume=0,${AFMT},atrim=end=${d},asetpts=PTS-STARTPTS[a${n}];`;
    pushPair();
  };

  const segs = segments || [];
  // Fade construction for a piece at UNIFIED index u (segments then appended
  // clips): a fade-OUT on its tail if a transition sits after it (and it has a
  // following piece), and a fade-IN on its head if a transition sits after the
  // PREVIOUS piece. Works at any boundary, cross-source included (C2).
  const totalPieces = segs.length + (appended ? appended.length : 0);
  const fadesFor = (u, len) => {
    const out = [];
    const trAfter = (transitions || []).find((t) => t.afterIndex === u);
    if (trAfter && u < totalPieces - 1) {
      const half = Math.min(trAfter.duration / 2, len / 2);
      out.push(`fade=t=out:st=${(len - half).toFixed(3)}:d=${half.toFixed(3)}:color=${trAfter.color || 'white'}`);
    }
    const trBefore = (transitions || []).find((t) => t.afterIndex === u - 1);
    if (trBefore) {
      const half = Math.min(trBefore.duration / 2, len / 2);
      out.push(`fade=t=in:st=0:d=${half.toFixed(3)}:color=${trBefore.color || 'white'}`);
    }
    return out.length ? `,${out.join(',')}` : '';
  };
  if (segs.length === 0) {
    // No trim on the primary — the whole source is one piece. Its output ends
    // at the source duration, which is where appended-clip gaps measure from.
    chain += `[0:v]${NV}[v${n}];`;
    if (hasAudio) chain += `[0:a]${AFMT}[a${n}];`;
    pushPair();
    cursor = primaryDuration || 0;
  } else {
    segs.forEach((seg, i) => {
      const gap = seg.outStart - cursor;
      if (gap > 0.01) addBlackFiller(gap);
      const len = seg.end - seg.start;
      // Unified piece index i (segments precede appended clips) — a transition
      // after the LAST segment now dips into the first appended clip (C2).
      chain += pieceVideo(
        `[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS`,
        seg.settings,
        n,
        fadesFor(i, len)
      );
      if (hasAudio) chain += `[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS,${AFMT}[a${n}];`;
      pushPair();
      cursor = seg.outStart + len;
    });
  }

  appended.forEach((clip, idx) => {
    const inIdx = appendedInputStart + idx;
    const s = clip.start.toFixed(3);
    const e = clip.end.toFixed(3);
    const len = (clip.end - clip.start).toFixed(3);
    // Free-mode placement: a gap before this clip (its outStart later than the
    // previous piece's end) becomes black filler, exactly like the primary's
    // between-segment gaps. Snap mode / old clients send no outStart → no gap.
    if (Number.isFinite(clip.outStart)) {
      const gap = clip.outStart - cursor;
      if (gap > 0.01) addBlackFiller(gap);
    }
    // Unified index for an appended clip = segs.length + idx (C2 transitions).
    const fadeChain = fadesFor(segs.length + idx, clip.end - clip.start);
    chain += pieceVideo(`[${inIdx}:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS`, clip.settings, n, fadeChain);
    if (hasAudio) {
      if (clip.hasAudio) {
        chain += `[${inIdx}:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS,${AFMT}[a${n}];`;
      } else {
        // Silence of the exact length so its audio matches its video for concat.
        chain += `anullsrc=r=44100:cl=stereo,atrim=end=${len},asetpts=PTS-STARTPTS,${AFMT}[a${n}];`;
      }
    }
    pushPair();
    // Advance the output cursor past this clip so the NEXT appended clip's gap
    // measures from here. This clip actually starts at max(outStart, cursor)
    // (clamp-forward — any gap was already emitted as filler above).
    const clipLen = clip.end - clip.start;
    const clipStart = Number.isFinite(clip.outStart) ? Math.max(clip.outStart, cursor) : cursor;
    cursor = clipStart + clipLen;
  });

  const outLabels = hasAudio ? '[segv][sega]' : '[segv]';
  chain += `${pairLabels.join('')}concat=n=${n}:v=1:a=${hasAudio ? 1 : 0}${outLabels};`;
  return { chain, videoLabel: '[segv]', audioLabel: hasAudio ? '[sega]' : null };
}

async function runFfmpeg(inputPath, outputPath, canvasW, canvasH, zoom, blur, panX, panY, captionOverlays, mediaOverlays, audioOverlays, mirror, speed, hasAudio, segments, transitions, mediaInfo, keyframes, faceTrack, split, mainAudio, appended, color, crop, exportOpts, onProgress, onChild) {
  const hasAppended = Array.isArray(appended) && appended.length > 0;
  // No trim info at all (null — no preview was ever loaded, so nothing
  // was sent) behaves exactly like this feature never existed: no -ss/-t,
  // straight [0:v]/[0:a]. A single kept range starting at output 0 (the
  // common case — just trimming the two ends) still uses fast,
  // frame-accurate input-side -ss/-t. Everything else — middle cuts,
  // free-form gaps (a lone piece placed after black counts), transitions
  // — goes through the trim/filler/concat filter chain below.
  const noTrim = !segments || segments.length === 0;
  // The fast input-side -ss/-t single-range path can't be used when appended
  // clips are stitched — [0:v] must stay whole for the concat filter.
  const singleRange =
    !hasAppended &&
    !noTrim &&
    segments.length === 1 &&
    segments[0].outStart <= 0.01 &&
    (!transitions || transitions.length === 0);
  // Per-piece render (B6): when the segment-concat path runs and no global
  // transform mode is active (keyframes / face-track / split each own the whole
  // composite), composite each piece to a canvas-sized fill.
  //   - Single-source pieces that all share settings can skip it: buildSegmentFilter
  //     concats the RAW trims (same dimensions) and buildFilterComplex fills once.
  //   - Appended (multi-source) clips have DIFFERENT dimensions, so concat needs
  //     them pre-normalised. The only correct normalisation is the same fill
  //     composite (cover + blur bg) — the letterbox fallback bakes black bars into
  //     each piece and its opaque pad then hides the blurred background, so the
  //     export shows black bars where the preview shows the blur. Always per-piece
  //     when appended so the render matches the preview.
  const perPiece =
    !noTrim &&
    !singleRange &&
    !(Array.isArray(keyframes) && keyframes.length >= 1) &&
    !(Array.isArray(faceTrack) && faceTrack.length >= 1) &&
    !split &&
    (hasAppended || pieceSettingsDiffer([...(segments || []), ...(hasAppended ? appended : [])]));
  // -progress pipe:1 streams machine-readable key=value progress lines to
  // stdout (stderr keeps the normal log for error reporting) — parsed by
  // runFfmpegWithProgress so the job status can expose a real percentage.
  const args = ['-y', '-progress', 'pipe:1', '-nostats'];
  if (singleRange) {
    if (segments[0].start > 0) args.push('-ss', segments[0].start.toFixed(3));
    args.push('-t', (segments[0].end - segments[0].start).toFixed(3));
  }
  args.push('-i', inputPath);
  // Appended clips are inputs 1..A (right after the primary), before overlays.
  const appendedInputStart = 1;
  if (hasAppended) for (const clip of appended) args.push('-i', clip.filePath);

  // Input order: main video is always 0; the media overlay (if any) comes
  // next so it renders underneath the text layers, which are always added
  // after it so they stay the topmost layers — matching how every
  // overlay/text combination in CapCut and similar editors stacks by
  // default.
  const overlayStages = [];
  let nextInputIndex = 1 + (hasAppended ? appended.length : 0);
  // Each overlay is its own input + composite stage, stacked in order (so a
  // later overlay sits on top). A video overlay is input-seeked by `offset`
  // (so a split video overlay's right half continues where it left off) and
  // crop-then-scaled; every overlay is shown only during its own window.
  for (const ov of mediaOverlays) {
    if (ov.isVideo && ov.offset > 0.01) args.push('-ss', ov.offset.toFixed(3));
    args.push('-i', ov.path);
    // sizePercent is the MEDIA display width, so scale the full media to it
    // FIRST, then crop the window out — cropping trims a smaller region, it
    // doesn't zoom the media (matches the preview's iOS-style crop).
    const mediaWidthPx = Math.round(canvasW * (ov.sizePercent / 100));
    const cl = ov.cropLeft / 100;
    const cr = ov.cropRight / 100;
    const ct = ov.cropTop / 100;
    const cb = ov.cropBottom / 100;
    // Keep at least a 2% sliver on each axis so a full crop never yields a
    // zero-size window (which ffmpeg's crop would reject).
    const keepW = Math.max(0.02, 1 - cl - cr);
    const keepH = Math.max(0.02, 1 - ct - cb);
    const cropChain =
      cl + cr + ct + cb > 0.001
        ? `,crop=iw*${keepW.toFixed(4)}:ih*${keepH.toFixed(4)}:iw*${cl.toFixed(4)}:ih*${ct.toFixed(4)}`
        : '';
    const enable =
      Number.isFinite(ov.start) && Number.isFinite(ov.end) && ov.end > ov.start
        ? `between(t,${ov.start.toFixed(3)},${ov.end.toFixed(3)})`
        : null;
    // Opacity (used by the brand-kit watermark) — premultiply the alpha so the
    // overlay composites semi-transparently.
    const opChain =
      Number.isFinite(ov.opacity) && ov.opacity < 1
        ? `,format=rgba,colorchannelmixer=aa=${Math.max(0, ov.opacity).toFixed(3)}`
        : '';
    const label = `[ovlm${nextInputIndex}]`;
    overlayStages.push({
      pre: `[${nextInputIndex}:v]scale=${mediaWidthPx}:-2${cropChain}${opChain}${label}`,
      inputLabel: label,
      x: `x=(main_w-overlay_w)*${(ov.xPercent / 100).toFixed(4)}`,
      y: `y=(main_h-overlay_h)*${(ov.yPercent / 100).toFixed(4)}`,
      enable,
    });
    nextInputIndex += 1;
  }
  for (const cap of captionOverlays) {
    const animated = ['fade', 'slide', 'bounce', 'shake'].includes(cap.animation);
    // An animated caption needs a continuous stream to ramp alpha over time, so
    // it's looped — but BOUNDED with -t (to its end + a margin) so the input
    // EOFs instead of looping forever, which otherwise wedges ffmpeg at the
    // finalize step long after the video stream has ended.
    if (animated) args.push('-loop', '1', '-t', (cap.end + 0.2).toFixed(3), '-i', cap.pngPath);
    else args.push('-i', cap.pngPath);
    const rawLabel = `[${nextInputIndex}:v]`;
    const stage = { inputLabel: rawLabel, x: cap.x, y: cap.y, enable: cap.enable };
    if (animated) {
      const d = CAP_ANIM_DURATION.toFixed(3);
      const st = cap.start.toFixed(3);
      const faded = `[capf${nextInputIndex}]`;
      // Fade the caption's alpha in over the first CAP_ANIM_DURATION after it
      // appears (st is on the main timeline; a -loop 1 image shares that clock).
      stage.pre = `${rawLabel}format=yuva420p,fade=t=in:st=${st}:d=${d}:alpha=1${faded}`;
      stage.inputLabel = faded;
      // Progress p over the entrance window (0→1), commas escaped for overlay.
      const P = `clip((t-${st})/${d}\\,0\\,1)`;
      if (cap.animation === 'slide') {
        // Ease the caption up from slidePx below its resting y — matches the
        // preview's per-frame translate.
        stage.y = `${cap.y}+${cap.slidePx}*(1-${P})`;
      } else if (cap.animation === 'bounce') {
        // easeOutBack overshoot on y: starts bouncePx below, springs past 0,
        // settles. u = p-1; 1-easeOutBack = -(C3*u^3 + C1*u^2).
        const U = `(${P}-1)`;
        stage.y = `${cap.y}+${cap.bouncePx}*(0-(${BACK_C3}*${U}*${U}*${U}+${BACK_C1}*${U}*${U}))`;
      } else if (cap.animation === 'shake') {
        // Damped horizontal sine over the entrance, matching preview.
        const omega = (CAP_SHAKE_CYCLES * 2 * Math.PI).toFixed(4);
        stage.x = `${cap.x}+${cap.shakePx}*sin(${P}*${omega})*(1-${P})`;
      }
    }
    overlayStages.push(stage);
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
  if (hasAppended) {
    // Stitch primary + appended clips into one normalized [segv]/[sega].
    // Sized to the CANVAS (not the source): with per-piece compositing each piece
    // is fully filled to canvas here (buildPieceComposite), and the preComposited
    // buildFilterComplex path below no longer resizes — so it must already be
    // canvas-sized (matches buildSegmentFilter, which is also passed the canvas).
    const fps = Math.round(mediaInfo.fps || 30) || 30;
    const built = buildStitchedFilter(
      segments,
      transitions || [],
      hasAudio,
      canvasW,
      canvasH,
      fps,
      appended,
      appendedInputStart,
      perPiece,
      mediaInfo.duration || 0
    );
    segmentPrefix = built.chain;
    sourceVideoLabel = built.videoLabel;
    sourceAudioLabel = built.audioLabel;
  } else if (!noTrim && !singleRange) {
    const built = buildSegmentFilter(segments, hasAudio, transitions || [], perPiece, canvasW, canvasH);
    segmentPrefix = built.chain;
    sourceVideoLabel = built.videoLabel;
    sourceAudioLabel = built.audioLabel;
  }

  let filterComplex =
    segmentPrefix +
    buildFilterComplex(canvasW, canvasH, zoom, blur, panX, panY, overlayStages, mirror, speed, sourceVideoLabel, keyframes, Math.max(1, (mediaInfo.fps || 30) * speed), faceTrack, split, mediaInfo.width, mediaInfo.height, color, crop, perPiece);

  // atempo only accepts 0.5-2.0 per instance, which matches the slider's
  // own range exactly, so a single atempo call always suffices — no need
  // to chain multiple instances for extreme speed values.
  // '0:a?' (optional-stream map) only makes sense for a literal input
  // stream reference, not a filter output label — the concat path always
  // resolves sourceAudioLabel to either a real [sega] filter label or
  // null (source had no audio at all), so it's mapped directly rather
  // than through the '?' suffix.
  // With appended clips the stitched [sega] IS the audio; otherwise the
  // no-trim / single-range fast paths map input audio directly via 0:a?.
  let audioMap = hasAppended ? sourceAudioLabel : noTrim || singleRange ? '0:a?' : sourceAudioLabel;
  if (speed !== 1 && hasAudio) {
    filterComplex += `;${sourceAudioLabel}atempo=${speed}[outa]`;
    audioMap = '[outa]';
  }

  // Main-clip volume (0-200%, 100 = untouched, 0 = muted) + head/tail fades.
  // Applied after any trim/speed and before sound mixing, so they act only on
  // the source audio. '0:a?' is a CLI map, not a filter label — swap in [0:a].
  const mainVol = mainAudio ? mainAudio.volume : 100;
  const mainFadeIn = mainAudio ? mainAudio.fadeIn : 0;
  const mainFadeOut = mainAudio ? mainAudio.fadeOut : 0;
  // Output audio duration (post trim + speed) — where the fade-out must land.
  const outSpan =
    segments && segments.length > 0
      ? segments.reduce((m, s) => Math.max(m, s.outStart + (s.end - s.start)), 0)
      : mediaInfo.duration || 0;
  const outDur = outSpan / speed;
  if (hasAudio && (mainVol !== 100 || mainFadeIn > 0 || mainFadeOut > 0)) {
    const filters = [];
    if (mainVol !== 100) filters.push(`volume=${(mainVol / 100).toFixed(3)}`);
    if (mainFadeIn > 0) filters.push(`afade=t=in:st=0:d=${mainFadeIn.toFixed(3)}`);
    if (mainFadeOut > 0 && outDur > mainFadeOut) {
      filters.push(`afade=t=out:st=${(outDur - mainFadeOut).toFixed(3)}:d=${mainFadeOut.toFixed(3)}`);
    }
    const inLabel = audioMap === '0:a?' ? '[0:a]' : audioMap;
    filterComplex += `;${inLabel}${filters.join(',')}[mainaud]`;
    audioMap = '[mainaud]';
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
      const hasTrim = Number.isFinite(au.trimStart) && Number.isFinite(au.trimEnd) && au.trimEnd > au.trimStart;
      const trimChain = hasTrim
        ? `atrim=start=${au.trimStart.toFixed(3)}:end=${au.trimEnd.toFixed(3)},asetpts=PTS-STARTPTS,`
        : '';
      // Fades act on the sound's own timeline (0 = its start), before the delay
      // that positions it. playLen is the sound's on-timeline length.
      const playLen = Number.isFinite(au.playLen) ? au.playLen : hasTrim ? au.trimEnd - au.trimStart : null;
      let fadeChain = '';
      if (au.fadeIn > 0) fadeChain += `afade=t=in:st=0:d=${au.fadeIn.toFixed(3)},`;
      if (au.fadeOut > 0 && playLen && playLen > au.fadeOut) {
        fadeChain += `afade=t=out:st=${(playLen - au.fadeOut).toFixed(3)}:d=${au.fadeOut.toFixed(3)},`;
      }
      const delayMs = Math.round((au.delay || 0) * 1000);
      const delayChain = delayMs > 0 ? `adelay=${delayMs}:all=1,` : '';
      const label = `[sfx${i}]`;
      // Duck stage AFTER volume+delay, so its enable `t` is final-video time —
      // drops this sound to DUCK_FACTOR while speech (caption ranges) plays.
      const duckChain = au.duckEnable ? `,volume=${DUCK_FACTOR}:enable='${au.duckEnable}'` : '';
      filterComplex += `;[${au.idx}:a]${trimChain}${fadeChain}${delayChain}volume=${volume}${duckChain}${label}`;
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

  // Loudness normalization (Feature 8): the LAST step in the audio chain, on the
  // final mix — so per-clip volume, fades and ducking are all preserved and only
  // the overall loudness is retargeted to a short-form-friendly -14 LUFS
  // (single-pass loudnorm; TP -1.5 dBTP true-peak ceiling, LRA 11).
  const wantsLoudnorm = exportOpts && exportOpts.normalizeLoudness;
  const anyAudio = hasAudio || (audioOverlays && audioOverlays.length > 0);
  if (wantsLoudnorm && audioMap && anyAudio) {
    const inLabel = audioMap === '0:a?' ? '[0:a]' : audioMap;
    // loudnorm resamples internally and emits a non-standard rate (96 kHz here),
    // which some platforms reject; aformat restores the pipeline's 44.1 kHz
    // stereo fltp (matching AFMT and the loudnorm-off path) so every export is
    // consistent. aformat (not a bare aresample) also re-pins the channel layout,
    // which loudnorm leaves ambiguous — otherwise the multi-source concat/amix
    // path fails with "Cannot select channel layout" at the encoder.
    filterComplex += `;${inLabel}loudnorm=I=-14:TP=-1.5:LRA=11,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[normaudio]`;
    audioMap = '[normaudio]';
  }

  // Export options: downscale the finished frame to the chosen resolution
  // (the "p" value targets the short side, so it works for portrait and
  // landscape), and use the chosen CRF (lower = higher quality/larger file).
  let mapVideoLabel = '[outv]';
  const shortSide = Math.min(canvasW, canvasH);
  const targetRes = exportOpts && exportOpts.targetRes;
  if (targetRes && targetRes < shortSide) {
    const factor = targetRes / shortSide;
    const ow = Math.max(2, Math.round((canvasW * factor) / 2) * 2);
    const oh = Math.max(2, Math.round((canvasH * factor) / 2) * 2);
    filterComplex += `;[outv]scale=${ow}:${oh}[outvs]`;
    mapVideoLabel = '[outvs]';
  }
  const crf = String((exportOpts && exportOpts.crf) || 19);
  const outputArgs = ['-filter_complex', filterComplex, '-map', mapVideoLabel];
  if (audioMap) outputArgs.push('-map', audioMap);
  // Animated captions ride a `-loop 1 -t (end+margin)` image input; that margin
  // can outlast the video and pad the render with a frozen tail. -shortest ends
  // the output with the (bounded) video/audio instead. Only added when such a
  // looped input exists, so nothing else changes.
  const hasLoopedCaption = captionOverlays.some((c) => c.animation === 'fade' || c.animation === 'slide');
  if (hasLoopedCaption) outputArgs.push('-shortest');
  args.push(
    ...outputArgs,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', crf,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart', // moves the moov atom to the front so <video> playback doesn't fail/stall before the file is fully downloaded
    outputPath,
  );
  await runFfmpegWithProgress(args, onProgress, onChild);
}

// Same contract as runCommand, but reads ffmpeg's -progress key=value
// stream off stdout and reports out_time to the caller. out_time_ms is —
// despite the name — in MICROseconds (a long-standing ffmpeg quirk), hence
// the 1e6 divisor.
const FFMPEG_TIMEOUT_MS = 60 * 60 * 1000; // 1h ceiling on a single render; a wedged ffmpeg is killed

async function runFfmpegWithProgress(args, onProgress, onChild) {
  await acquireHeavySlot();
  try {
    return await runFfmpegWithProgressInner(args, onProgress, onChild);
  } finally {
    releaseHeavySlot();
  }
}

function runFfmpegWithProgressInner(args, onProgress, onChild) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args);
    if (onChild) onChild(child); // let the job track this child so it can be cancelled
    let stderr = '';
    let stdoutBuf = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FFMPEG_TIMEOUT_MS);
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
      clearTimeout(timer);
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ffmpeg render timed out after ${Math.round(FFMPEG_TIMEOUT_MS / 60000)}m and was killed`));
      } else if (code === 0) {
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
  const overlays = [];
  textLayers.forEach((layer, i) => {
    const hasRange = Number.isFinite(layer.start) && Number.isFinite(layer.end) && layer.end > layer.start;
    // Entrance params, shared by a karaoke layer's base + word variants so they
    // move together and the coloured word stays aligned with the base.
    const animBase = {
      animation: hasRange ? layer.animation || 'none' : 'none',
      start: hasRange ? layer.start : null,
      end: hasRange ? layer.end : null,
      slidePx: Math.round(canvasH * CAP_SLIDE_FRAC),
      bouncePx: Math.round(canvasH * CAP_BOUNCE_FRAC),
      shakePx: Math.round(canvasH * CAP_SHAKE_FRAC),
    };
    const common = {
      text: layer.text,
      style: layer.style,
      fontId: layer.fontId,
      dropShadow: layer.dropShadow,
      fontSize: layer.fontSize,
      color: layer.color,
      canvasWidth: canvasW,
      wrapWidth: layer.wrapWidth,
      strokeWidth: layer.strokeWidth,
      strokeColor: layer.strokeColor,
      uppercase: layer.uppercase,
      opacity: layer.opacity,
      karaoke: !!layer.karaoke,
      karaokeColor: layer.karaokeColor,
      shadowDistance: layer.shadowDistance,
      shadowBlur: layer.shadowBlur,
      shadowOpacity: layer.shadowOpacity,
      bgOpacity: layer.bgOpacity,
      bgPadding: layer.bgPadding,
      bgRadius: layer.bgRadius,
      letterSpacing: layer.letterSpacing,
      lineHeight: layer.lineHeight,
      rotation: layer.rotation,
    };
    let pngIdx = 0;
    // Renders one caption PNG (a base with emphasizeWordIndex=-1, or a word
    // variant) and pushes it as an overlay enabled over `enable`.
    const emit = (emphasizeWordIndex, enable) => {
      const { buffer, width, height } = renderCaptionPng({ ...common, emphasizeWordIndex });
      const pngPath = path.join(CAPTIONS_DIR, `${jobId}-${i}-${pngIdx++}.png`);
      fs.writeFileSync(pngPath, buffer);
      overlays.push({
        pngPath,
        x: resolvePositionCoordinate(layer.xPercent, width, canvasW),
        y: resolvePositionCoordinate(layer.yPercent, height, canvasH),
        enable,
        ...animBase,
      });
    };
    const baseEnable = hasRange ? `between(t,${layer.start.toFixed(3)},${layer.end.toFixed(3)})` : null;
    emit(-1, baseEnable); // base caption (no word emphasised)
    // Karaoke: one extra overlay per word, coloured, enabled during that word's
    // output window (start + rel time). Sits on top of the base — same layout,
    // only the spoken word's fill differs. Word times are source-relative; the
    // common case (1x speed, block within one piece) is exact.
    if (layer.karaoke && Array.isArray(layer.words) && hasRange) {
      layer.words.forEach((w, wi) => {
        const ws = layer.start + (Number(w.rs) || 0);
        const we = layer.start + (Number(w.re) || 0);
        if (we > ws) emit(wi, `between(t,${ws.toFixed(3)},${we.toFixed(3)})`);
      });
    }
  });
  return overlays;
}

// Overlay edge crop, 0-45% off each side — clamped so the two opposite
// edges can never remove more than 90% of an axis (mirrors the frontend's
// slider clamp).
function clampCropPercent(value) {
  const pct = parseFloat(value);
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
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

// The brand-kit watermark as a top-of-stack media overlay (or null). The client
// sends the per-project watermark config in `watermark`; the image itself is the
// global brand asset on disk, so it never has to be uploaded per export. Reuses
// the media-overlay compositor (scale/position + the new opacity path).
function watermarkOverlay(body) {
  let wm;
  try {
    wm = JSON.parse(body.watermark || 'null');
  } catch {
    wm = null;
  }
  if (!wm || !wm.enabled) return null;
  const kit = readBrandKit();
  const name = kit.watermark && kit.watermark.image;
  if (!name) return null;
  let file;
  try {
    file = resolveInside(BRAND_DIR, safeLeaf(name));
  } catch {
    return null;
  }
  if (!fs.existsSync(file)) return null;
  const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  return {
    path: file,
    isVideo: false,
    sizePercent: clampPositionPercent(wm.sizePercent, kit.watermark.sizePercent),
    xPercent: clampPositionPercent(wm.xPercent, kit.watermark.xPercent),
    yPercent: clampPositionPercent(wm.yPercent, kit.watermark.yPercent),
    cropTop: 0,
    cropBottom: 0,
    cropLeft: 0,
    cropRight: 0,
    start: null,
    end: null,
    offset: 0,
    opacity: Math.max(0, Math.min(1, num(wm.opacity, kit.watermark.opacity))),
  };
}

// Media overlays plus the brand-kit watermark (last → composites on top).
function buildMediaOverlaysWithWatermark(body, overlayFiles) {
  return [...buildMediaOverlays(body, overlayFiles), watermarkOverlay(body)].filter(Boolean);
}

// Each sound file (multipart 'audioTrack' field, order-matched to the JSON
// `sounds` array) becomes a descriptor: volume, delay (FINAL-video seconds
// where it starts), and trimStart/trimEnd (the region of the file to play).
// Ducking must match the preview's DUCK_FACTOR (preview.js) for parity.
const DUCK_FACTOR = 0.3;

// An ffmpeg enable expression true during any speech (caption) range, in
// FINAL-video seconds, or null when there are none.
function speechEnableExpr(body) {
  let ranges = [];
  try {
    ranges = JSON.parse(body.speechRanges || '[]');
  } catch {
    ranges = [];
  }
  const parts = (Array.isArray(ranges) ? ranges : [])
    .map((r) => ({ s: parseFloat(r.start), e: parseFloat(r.end) }))
    .filter((r) => Number.isFinite(r.s) && Number.isFinite(r.e) && r.e > r.s)
    .map((r) => `between(t,${r.s.toFixed(3)},${r.e.toFixed(3)})`);
  return parts.length ? parts.join('+') : null;
}

function buildAudioOverlays(body, audioFiles) {
  if (!audioFiles || audioFiles.length === 0) return [];
  let meta = [];
  try {
    meta = JSON.parse(body.sounds || '[]');
  } catch {
    meta = [];
  }
  const duckEnable = speechEnableExpr(body);
  return audioFiles.map((file, i) => {
    const m = meta[i] || {};
    const delay = parseFloat(m.delay);
    const trimStart = parseFloat(m.trimStart);
    const trimEnd = parseFloat(m.trimEnd);
    const playLen = parseFloat(m.playLen);
    return {
      path: file.path,
      volume: clampVolumePercent(m.volume, 80),
      fadeIn: clampFadeSeconds(m.fadeIn),
      fadeOut: clampFadeSeconds(m.fadeOut),
      // Precomputed duck stage (only when this sound opts in AND speech exists).
      duckEnable: m.duck && duckEnable ? duckEnable : null,
      delay: Number.isFinite(delay) && delay > 0 ? delay : 0,
      playLen: Number.isFinite(playLen) && playLen > 0 ? playLen : null,
      trimStart: Number.isFinite(trimStart) ? trimStart : 0,
      trimEnd: Number.isFinite(trimEnd) ? trimEnd : null,
    };
  });
}

// Appended clips (sequential multi-source). Each entry is either a URL clip
// (re-resolved from the preview cache / downloaded at render time) or an
// uploaded file (order-matched to the 'appendedVideo' files). start/end trim
// the appended source. Their input paths are resolved later in processJob.
function buildAppendedClips(body, appendedFiles) {
  let meta = [];
  try {
    meta = JSON.parse(body.appendedClips || '[]');
  } catch {
    meta = [];
  }
  if (!Array.isArray(meta) || meta.length === 0) return [];
  const files = appendedFiles || [];
  let fileCursor = 0;
  return meta.map((m) => {
    const start = parseFloat(m.start);
    const end = parseFloat(m.end);
    const outStart = parseFloat(m.outStart);
    const clip = {
      kind: m.kind === 'file' ? 'file' : 'url',
      start: Number.isFinite(start) ? Math.max(0, start) : 0,
      end: Number.isFinite(end) && end > 0 ? end : null,
      // Free-mode output position; null in snap mode / old clients (contiguous).
      outStart: Number.isFinite(outStart) ? outStart : null,
      settings: parsePieceSettings(m.settings), // per-piece reframe/blur/grade (B6)
    };
    if (clip.kind === 'url') {
      clip.url = typeof m.url === 'string' ? m.url : null;
    } else {
      const f = files[fileCursor++];
      clip.filePath = f ? f.path : null;
    }
    return clip;
  });
}

// Export options: CRF (12-35, lower = better) + target resolution (short-side
// px, e.g. 1080/720/480; null = keep canvas).
function buildExportOpts(body) {
  const crfRaw = parseInt(body.crf, 10);
  const crf = Number.isFinite(crfRaw) ? Math.min(35, Math.max(12, crfRaw)) : 19;
  const resRaw = parseInt(body.outHeight, 10);
  // Loudness normalization defaults ON (short-form platforms expect consistent
  // loudness); the client sends 'false' to opt out.
  const normalizeLoudness = String(body.normalizeLoudness) !== 'false';
  return { crf, targetRes: Number.isFinite(resRaw) && resRaw > 0 ? resRaw : null, normalizeLoudness };
}

// Color grade { brightness, contrast, saturation }, each -100..100.
function buildColor(body) {
  let raw = {};
  try {
    raw = typeof body.color === 'string' ? JSON.parse(body.color) : body.color || {};
  } catch {
    raw = {};
  }
  const clamp = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(-100, n)) : 0;
  };
  return { brightness: clamp(raw.brightness), contrast: clamp(raw.contrast), saturation: clamp(raw.saturation) };
}

// Main-clip crop { top,bottom,left,right } from the request body (JSON string),
// clamped by parseCrop. Global whole-video, applied before the fill composite.
function buildCrop(body) {
  let raw = {};
  try {
    raw = typeof body.crop === 'string' ? JSON.parse(body.crop) : body.crop || {};
  } catch {
    raw = {};
  }
  return parseCrop(raw);
}

// ffmpeg eq chain for a color grade, or null when neutral. Contrast/saturation
// are multipliers (match CSS); brightness is additive (approximate vs CSS).
function colorGradeChain(color) {
  if (!color) return null;
  const { brightness = 0, contrast = 0, saturation = 0 } = color;
  if (brightness === 0 && contrast === 0 && saturation === 0) return null;
  const b = (brightness / 200).toFixed(4);
  const c = (1 + contrast / 100).toFixed(4);
  const s = (1 + saturation / 100).toFixed(4);
  return `eq=brightness=${b}:contrast=${c}:saturation=${s}`;
}

// Main-clip audio settings: volume 0-200 (0 = muted, already collapsed by the
// frontend) and head/tail fades in seconds.
function buildMainAudio(body) {
  return {
    volume: clampVolumePercent(body && body.audioVolume, 100),
    fadeIn: clampFadeSeconds(body && body.audioFadeIn),
    fadeOut: clampFadeSeconds(body && body.audioFadeOut),
  };
}

function findFileWithPrefix(dir, prefix) {
  const match = fs.readdirSync(dir).find((name) => name.startsWith(`${prefix}.`));
  return match ? path.join(dir, match) : null;
}

function ytDlpArgs(url, outputTemplate) {
  // `--` terminates option parsing so a URL that starts with '-' can never be
  // read as a flag (arg injection). URLs are already restricted to Twitch hosts
  // (isTwitchClipUrl) at every entry point before reaching here.
  return ['-o', outputTemplate, '--no-playlist', '--', url];
}

async function downloadWithYtDlp(url, jobId) {
  // Defense in depth: the single choke point to yt-dlp re-checks the host, so a
  // non-Twitch URL can never reach it even if a caller forgot to validate.
  if (!isTwitchClipUrl(url)) throw new Error(TWITCH_URL_ERROR);
  const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);
  await acquireHeavySlot();
  try {
    await runCommand(YTDLP_BIN, ytDlpArgs(url, outputTemplate));
  } finally {
    releaseHeavySlot();
  }
  const filePath = findFileWithPrefix(DOWNLOADS_DIR, jobId);
  if (!filePath) {
    throw new Error('yt-dlp reported success but no downloaded file was found');
  }
  return filePath;
}

function previewCacheKey(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

// Downloads a clip purely for the live preview, reusing a prior download of
// the exact same URL if one's already cached (see PREVIEW_CACHE_DIR above).
async function fetchPreviewSource(url) {
  if (!isTwitchClipUrl(url)) throw new Error(TWITCH_URL_ERROR);
  const cacheKey = previewCacheKey(url);
  let filePath = findFileWithPrefix(PREVIEW_CACHE_DIR, cacheKey);
  if (!filePath) {
    const outputTemplate = path.join(PREVIEW_CACHE_DIR, `${cacheKey}.%(ext)s`);
    await acquireHeavySlot();
    try {
      await runCommand(YTDLP_BIN, ytDlpArgs(url, outputTemplate));
    } finally {
      releaseHeavySlot();
    }
    filePath = findFileWithPrefix(PREVIEW_CACHE_DIR, cacheKey);
    if (!filePath) {
      throw new Error('yt-dlp reported success but no downloaded file was found');
    }
  }
  return filePath;
}

// Resolves each appended clip to a local file path + probed info, so it can be
// added as an ffmpeg input and stitched. URL clips reuse the preview cache
// (downloading only if missing); file clips are already on disk. A clip that
// fails to resolve is dropped (the render proceeds without it).
async function resolveAppendedClips(appendedClips) {
  const out = [];
  for (const clip of appendedClips || []) {
    try {
      let filePath = clip.filePath;
      if (clip.kind === 'url' && clip.url) filePath = await fetchPreviewSource(clip.url);
      if (!filePath || !fs.existsSync(filePath)) continue;
      const info = await probeSource(filePath);
      const start = Math.max(0, Math.min(clip.start || 0, info.duration || 0));
      const end = clip.end && clip.end > start ? Math.min(clip.end, info.duration || clip.end) : info.duration || 0;
      if (end - start < 0.05) continue;
      // Keep the piece's per-clip settings (zoom/blur/pan/colour) — without them
      // an appended clip renders with defaults (no fill/blur), mismatching the preview.
      out.push({
        filePath,
        start,
        end,
        hasAudio: info.hasAudio,
        settings: clip.settings,
        outStart: Number.isFinite(clip.outStart) ? clip.outStart : null,
      });
    } catch {
      /* skip an appended clip that can't be resolved */
    }
  }
  return out;
}

async function processJob(jobId, inputPath, aspectRatio, zoom, blur, panX, panY, textLayers, mirror, speed, segments, transitions, mediaOverlays, audioOverlays, keyframes, faceTrack, split, mainAudio, appendedClips, color, crop, exportOpts) {
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

    // Resolve appended clips (download URL clips / probe files) so they can be
    // stitched after the primary. Their total length extends the output.
    const appended = await resolveAppendedClips(appendedClips);

    captionOverlays = buildCaptionOverlays(jobId, textLayers, canvasW, canvasH);

    // Expected output length: the full output span — pieces plus any
    // free-form black gaps (max of outStart+len, not just the kept sum) —
    // stretched by speed. Capped at 0.99 until the process actually exits
    // cleanly, so the bar never shows "done" for a render that then fails
    // at the muxing stage.
    const primarySpan =
      segments && segments.length > 0
        ? segments.reduce((max, s) => Math.max(max, s.outStart + (s.end - s.start)), 0)
        : mediaInfo.duration || 0;
    // The appended section can start later than the primary end and hold black
    // gaps (free mode), so its true end is the furthest clip outEnd (clamp-forward,
    // matching buildStitchedFilter), not the summed length. Falls back to the
    // contiguous sum when clips carry no placement.
    let appendedCursor = primarySpan;
    for (const c of appended) {
      const clipStart = Number.isFinite(c.outStart) ? Math.max(c.outStart, appendedCursor) : appendedCursor;
      appendedCursor = clipStart + (c.end - c.start);
    }
    // The stitched [segv]/[sega] (primary + appended) is sped uniformly, so the
    // whole span is divided by speed.
    const expectedDuration = Math.max(primarySpan, appendedCursor) / speed;
    const onProgress = (outTime) => {
      if (expectedDuration > 0) {
        // Alongside the percentage, expose the bytes written so far so the client
        // can extrapolate an honest final-size estimate (partialBytes / progress).
        let outputBytes;
        try {
          outputBytes = fs.statSync(outputPath).size;
        } catch {
          outputBytes = undefined;
        }
        setJob(jobId, { progress: Math.min(0.99, outTime / expectedDuration), outputBytes });
      }
    };

    // A cancel that lands before the child spawns (still queued) aborts here.
    if (cancelledJobs.has(jobId)) throw new Error('cancelled');
    const onChild = (child) => {
      exportChildren.set(jobId, child);
      // If cancel raced in between the check above and spawn, kill immediately.
      if (cancelledJobs.has(jobId)) child.kill('SIGKILL');
    };

    await runFfmpeg(inputPath, outputPath, canvasW, canvasH, zoom, blur, panX, panY, captionOverlays, mediaOverlays, audioOverlays, mirror, speed, mediaInfo.hasAudio, segments, transitions, mediaInfo, keyframes, faceTrack, split, mainAudio, appended, color, crop, exportOpts, onProgress, onChild);
    let outputBytes;
    try {
      outputBytes = fs.statSync(outputPath).size;
    } catch {
      outputBytes = undefined;
    }
    setJob(jobId, { status: 'done', progress: 1, outputUrl: `/outputs/${jobId}.mp4`, outputBytes });
  } catch (err) {
    // A killed ffmpeg (cancel) surfaces as a non-zero exit — report it as a clean
    // 'cancelled' status rather than an error the UI would show as a failure.
    if (cancelledJobs.has(jobId)) {
      setJob(jobId, { status: 'cancelled' });
      try {
        fs.unlinkSync(path.join(OUTPUTS_DIR, `${jobId}.mp4`));
      } catch {}
    } else {
      setJob(jobId, { status: 'error', error: err.message });
    }
  } finally {
    exportChildren.delete(jobId);
    cancelledJobs.delete(jobId);
    // Only the text-layer PNGs are server-generated temp artifacts cleaned
    // up here — overlay/sound uploads are genuine files,
    // left in place same as the main video upload (see the Notes section
    // in README.md).
    for (const cap of captionOverlays) {
      fs.unlink(cap.pngPath, () => {});
    }
  }
}

async function downloadAndProcess(jobId, url, aspectRatio, zoom, blur, panX, panY, textLayers, mirror, speed, segments, transitions, mediaOverlays, audioOverlays, keyframes, faceTrack, split, mainAudio, appendedClips, color, crop, exportOpts) {
  try {
    setJob(jobId, { status: 'downloading' });
    // If the user already fetched a live preview for this exact URL, reuse that
    // download instead of running yt-dlp a second time.
    const cachedPath = findFileWithPrefix(PREVIEW_CACHE_DIR, previewCacheKey(url));
    const inputPath = cachedPath || (await downloadWithYtDlp(url, jobId));
    await processJob(jobId, inputPath, aspectRatio, zoom, blur, panX, panY, textLayers, mirror, speed, segments, transitions, mediaOverlays, audioOverlays, keyframes, faceTrack, split, mainAudio, appendedClips, color, crop, exportOpts);
  } catch (err) {
    if (cancelledJobs.has(jobId)) {
      setJob(jobId, { status: 'cancelled' });
      cancelledJobs.delete(jobId);
    } else {
      setJob(jobId, { status: 'error', error: err.message });
    }
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
  { name: 'appendedVideo', maxCount: 20 },
]);

const app = express();
app.disable('x-powered-by');

// --- Localhost-only, token-authenticated server (security section 1) --------
// The server used to bind every interface with zero auth, so any host on the
// LAN — or any website open in the user's browser — could reach it: read any
// file via /api/preview-file, start downloads/exports, or delete projects.
// Defenses layered here: (1) bind to loopback only (see app.listen below);
// (2) a per-run secret token required on every request — sent as an X-App-Token
// header by fetch/XHR and as a Strict, HttpOnly cookie for <video>/<img>/font
// subresources that can't set headers; (3) Host validation (defeats
// DNS-rebinding) + Origin validation. The index page is the ONLY unauthenticated
// route — it's what hands the token to the renderer.
const IS_ELECTRON = !!process.versions.electron;
// Electron's main process generates the token and injects it via env before
// requiring this file; plain `node server.js` has none, so mint one and print it.
const APP_TOKEN = process.env.CLIP_EDITOR_TOKEN || crypto.randomBytes(32).toString('hex');
if (!process.env.CLIP_EDITOR_TOKEN && !IS_ELECTRON) {
  console.log(`\n[clip-editor] dev session token: ${APP_TOKEN}\n  (auto-injected into the served page; also accepted via the X-App-Token header)\n`);
}
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const TOKEN_COOKIE = 'clip_app_token';

function timingEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function tokenOk(req) {
  const header = req.get('X-App-Token');
  if (header && timingEqual(header, APP_TOKEN)) return true;
  const cookie = readCookie(req, TOKEN_COOKIE);
  return !!cookie && timingEqual(cookie, APP_TOKEN);
}

// Serve index.html with the token + a main-world fetch shim injected (a
// contextIsolated preload can't patch window.fetch, so it must ride the page),
// and set the token cookie so media subresources authenticate too.
let INDEX_HTML = null;
function serveIndex(req, res) {
  if (INDEX_HTML == null) INDEX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // In Electron the token reaches the page via the preload (contextBridge), so
  // it's NOT written into the HTML. In dev (browser) there's no preload, so the
  // server injects the value here (same-origin, never a query string / log).
  const tokenGlobal = IS_ELECTRON ? '' : `window.__CLIP_TOKEN__=${JSON.stringify(APP_TOKEN)};`;
  // Per-response nonce so the injected bootstrap is the ONLY inline script the
  // CSP allows — script-src stays 'self' + this nonce (no 'unsafe-inline'), so
  // an injected <script> can never run (XSS defense).
  const nonce = crypto.randomBytes(16).toString('base64');
  const boot =
    `<script nonce="${nonce}">${tokenGlobal}(function(){` +
    `var t=(window.electronAPI&&window.electronAPI.appToken)||window.__CLIP_TOKEN__;if(!t)return;` +
    `var of=window.fetch;window.fetch=function(input,init){init=init||{};try{` +
    `var url=new URL(typeof input==='string'?input:input.url,location.href);` +
    `if(url.origin===location.origin){var h=new Headers((init&&init.headers)||(typeof input!=='string'&&input.headers)||{});` +
    `h.set('X-App-Token',t);init.headers=h;}}catch(e){}return of.call(this,input,init);};})();</script>`;
  const html = INDEX_HTML.replace('</head>', `${boot}\n</head>`);
  // Strict CSP: everything is bundled ('self'), no remote origins. script-src is
  // locked to 'self' + the nonce above. media-src/img-src allow blob:/data: for
  // file-source videos and canvas thumbnails. style-src keeps 'unsafe-inline' for
  // the app's static inline style attributes — this does NOT weaken the script
  // (XSS) protection, which is entirely in script-src.
  const csp =
    "default-src 'self'; " +
    `script-src 'self' 'nonce-${nonce}'; ` +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob:; " +
    "font-src 'self'; " +
    "connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=${APP_TOKEN}; Path=/; HttpOnly; SameSite=Strict`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}
app.get(['/', '/index.html'], serveIndex);

// Guard EVERY other route (static assets included): Host, Origin (if present),
// then the token. 403 on any failure.
app.use((req, res, next) => {
  const host = req.headers.host;
  if (!host || !ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: 'forbidden host' });
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'forbidden origin' });
  if (!tokenOk(req)) return res.status(403).json({ error: 'missing or invalid app token' });
  next();
});

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
  if (!isTwitchClipUrl(trimmedUrl)) {
    return res.status(400).json({ error: TWITCH_URL_ERROR });
  }
  try {
    const filePath = await fetchPreviewSource(trimmedUrl);
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
  const num = (v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);
  return raw
    .map((l) => ({
      text: typeof (l && l.text) === 'string' ? l.text : '',
      style: clampCaptionStyle(l && l.style),
      fontId: normalizeFontId(l && l.fontId),
      fontSize: clampFontSize(l && l.fontSize),
      color: normalizeColor(l && l.color),
      dropShadow: normalizeDropShadow(l && l.dropShadow),
      // D1 text options (null strokeWidth = style default; opacity 0-1).
      strokeWidth: l && l.strokeWidth != null && Number.isFinite(parseFloat(l.strokeWidth)) ? Math.max(0, Math.min(40, parseFloat(l.strokeWidth))) : null,
      strokeColor: l && typeof l.strokeColor === 'string' ? l.strokeColor : '#000000',
      uppercase: !!(l && l.uppercase),
      opacity: l && Number.isFinite(parseFloat(l.opacity)) ? Math.max(0, Math.min(1, parseFloat(l.opacity))) : 1,
      // D1 remainder — clamped fractions/multipliers/degrees.
      shadowDistance: l && Number.isFinite(parseFloat(l.shadowDistance)) ? Math.max(0, Math.min(0.4, parseFloat(l.shadowDistance))) : 0.07,
      shadowBlur: l && Number.isFinite(parseFloat(l.shadowBlur)) ? Math.max(0, Math.min(0.4, parseFloat(l.shadowBlur))) : 0.05,
      shadowOpacity: l && Number.isFinite(parseFloat(l.shadowOpacity)) ? Math.max(0, Math.min(1, parseFloat(l.shadowOpacity))) : 0.4,
      bgOpacity: l && Number.isFinite(parseFloat(l.bgOpacity)) ? Math.max(0, Math.min(1, parseFloat(l.bgOpacity))) : 1,
      bgPadding: l && Number.isFinite(parseFloat(l.bgPadding)) ? Math.max(0.25, Math.min(3, parseFloat(l.bgPadding))) : 1,
      bgRadius: l && Number.isFinite(parseFloat(l.bgRadius)) ? Math.max(0, Math.min(3, parseFloat(l.bgRadius))) : 1,
      letterSpacing: l && Number.isFinite(parseFloat(l.letterSpacing)) ? Math.max(-0.2, Math.min(1, parseFloat(l.letterSpacing))) : 0,
      lineHeight: l && Number.isFinite(parseFloat(l.lineHeight)) ? Math.max(0.7, Math.min(2.5, parseFloat(l.lineHeight))) : 1,
      rotation: l && Number.isFinite(parseFloat(l.rotation)) ? Math.max(-180, Math.min(180, parseFloat(l.rotation))) : 0,
      // D2 karaoke: emphasis + per-word rel timings.
      karaoke: !!(l && l.karaoke),
      karaokeColor: l && typeof l.karaokeColor === 'string' ? l.karaokeColor : '#ffe600',
      words:
        l && Array.isArray(l.words)
          ? l.words.map((w) => ({ rs: num(w && w.rs) || 0, re: num(w && w.re) || 0 })).filter((w) => w.re > w.rs)
          : null,
      xPercent: clampPositionPercent(l && l.xPercent, 50),
      yPercent: clampPositionPercent(l && l.yPercent, 25),
      wrapWidth: clampWrapRatio(l && l.wrapWidth),
      animation: ['fade', 'slide', 'bounce', 'shake'].includes(l && l.animation) ? l.animation : 'none',
      start: num(l && l.start),
      end: num(l && l.end),
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
  if (!isTwitchClipUrl(trimmedUrl)) {
    return res.status(400).json({ error: TWITCH_URL_ERROR });
  }

  const jobId = req.jobId;
  jobs.set(jobId, { status: 'downloading' });
  res.json({ jobId });
  downloadAndProcess(
    jobId,
    trimmedUrl,
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
    buildMediaOverlaysWithWatermark(req.body || {}, req.files.overlay),
    buildAudioOverlays(req.body || {}, req.files.audioTrack),
    buildKeyframes(req.body || {}),
    buildFaceTrack(req.body || {}),
    buildSplit(req.body || {}),
    buildMainAudio(req.body || {}),
    buildAppendedClips(req.body || {}, req.files.appendedVideo),
    buildColor(req.body || {}),
    buildCrop(req.body || {}),
    buildExportOpts(req.body || {})
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
      buildMediaOverlaysWithWatermark(req.body, req.files.overlay),
      buildAudioOverlays(req.body, req.files.audioTrack),
      buildKeyframes(req.body),
      buildFaceTrack(req.body),
      buildSplit(req.body),
      buildMainAudio(req.body),
      buildAppendedClips(req.body, req.files.appendedVideo),
      buildColor(req.body),
      buildCrop(req.body),
      buildExportOpts(req.body)
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
      if (!isTwitchClipUrl(trimmedUrl)) {
        return res.status(400).json({ error: 'Provide a video file or a Twitch clip/VOD link to transcribe' });
      }
      inputPath = await fetchPreviewSource(trimmedUrl);
    }
    const result = await transcribeSource(inputPath, {
      ffmpegBin: FFMPEG_BIN,
      resourcesDir: process.env.CLIP_EDITOR_RESOURCES,
      modelsDir: MODELS_DIR,
      workDir: TRANSCRIBE_DIR,
      // 'words' = one caption per word (TikTok style), 'blocks' = short
      // multi-word lines. Anything else falls back to blocks.
      mode: (req.body || {}).mode === 'words' ? 'words' : 'blocks',
      // Caption quality tier (fast/better/best); server resolves the model +
      // transparently downgrades if it's not downloaded yet.
      tier: readCaptionSettings().tier,
      // Custom vocabulary → whisper initial prompt (formatted/capped inside).
      prompt: readCaptionSettings().customVocab,
    });
    // tier/downgraded let the client note "Using Fast — Best is still downloading".
    res.json({ segments: result.segments, tier: result.tier, requestedTier: result.requestedTier, downgraded: result.downgraded });
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

// --- personal asset library (sounds / music / overlays / fonts) --------------
// Global, per-user, survives updates. A flat library.json index + one file per
// entry under library/<category>/. Files are content-addressed (sha256) so a
// re-import of the same bytes dedupes to the existing entry. Stored filenames are
// `<id><ext>` (id is a random uuid) so no user string ever forms a path; the
// original name is kept only as metadata. Every file read goes through
// resolveInside for containment, and all routes sit behind the token guard above.
function readLibrary() {
  try {
    const data = JSON.parse(fs.readFileSync(LIBRARY_INDEX, 'utf8'));
    return Array.isArray(data.items) ? data : { items: [] };
  } catch {
    return { items: [] };
  }
}
function writeLibrary(data) {
  fs.writeFileSync(LIBRARY_INDEX, JSON.stringify({ items: data.items }, null, 2));
}
function libraryDisplayName(filename) {
  return String(filename)
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Untitled';
}
// The absolute on-disk path for an entry, kept inside its category folder.
function libraryEntryPath(entry) {
  return resolveInside(path.join(LIBRARY_DIR, entry.category), entry.storedName);
}
// What the client sees: the stored metadata + a same-origin URL it can drop into
// <audio>/<img>/<video> or an @font-face src (token rides the HttpOnly cookie).
function libraryEntryPublic(entry) {
  return {
    id: entry.id,
    category: entry.category,
    name: entry.name,
    filename: entry.filename,
    hash: entry.hash,
    size: entry.size,
    addedAt: entry.addedAt,
    url: `/api/library/file/${entry.id}`,
  };
}
function libraryFind(id) {
  return readLibrary().items.find((it) => it.id === String(id)) || null;
}
// Store a buffer under a category, deduping by content hash. Returns
// { entry, deduped }. Throws on a bad category (caller validates the extension).
function libraryAdd(category, buffer, originalName) {
  if (!LIBRARY_CATEGORIES.includes(category)) throw new Error('bad category');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const data = readLibrary();
  const existing = data.items.find((it) => it.category === category && it.hash === hash);
  if (existing) return { entry: existing, deduped: true };
  const leaf = safeLeaf(originalName) || 'file';
  const ext = (path.extname(leaf) || '').toLowerCase();
  const id = crypto.randomUUID();
  const storedName = `${id}${ext}`;
  fs.writeFileSync(resolveInside(path.join(LIBRARY_DIR, category), storedName), buffer);
  const entry = {
    id,
    category,
    name: libraryDisplayName(leaf),
    filename: leaf,
    storedName,
    hash,
    size: buffer.length,
    addedAt: new Date().toISOString(),
  };
  data.items.push(entry);
  writeLibrary(data);
  return { entry, deduped: false };
}
function libraryRemove(id) {
  const data = readLibrary();
  const i = data.items.findIndex((it) => it.id === String(id));
  if (i === -1) return false;
  const [entry] = data.items.splice(i, 1);
  try {
    fs.unlinkSync(libraryEntryPath(entry));
  } catch {
    /* file already gone — index cleanup still proceeds */
  }
  writeLibrary(data);
  return true;
}
function libraryRename(id, name) {
  const data = readLibrary();
  const entry = data.items.find((it) => it.id === String(id));
  if (!entry) return null;
  const clean = String(name == null ? '' : name).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120);
  if (clean) entry.name = clean;
  writeLibrary(data);
  return entry;
}

const libraryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.get('/api/library', (req, res) => {
  res.json({ items: readLibrary().items.map(libraryEntryPublic) });
});

// Disk usage per category + the on-disk folder path (Settings display).
app.get('/api/library/usage', (req, res) => {
  const categories = {};
  let total = 0;
  for (const cat of LIBRARY_CATEGORIES) {
    let bytes = 0;
    let count = 0;
    try {
      for (const name of fs.readdirSync(path.join(LIBRARY_DIR, cat))) {
        try {
          const st = fs.statSync(resolveInside(path.join(LIBRARY_DIR, cat), name));
          if (st.isFile()) {
            bytes += st.size;
            count += 1;
          }
        } catch {
          /* skip unreadable entry */
        }
      }
    } catch {
      /* category folder missing — treated as empty */
    }
    categories[cat] = { bytes, count };
    total += bytes;
  }
  res.json({ categories, total, path: LIBRARY_DIR });
});

app.post('/api/library/import', libraryUpload.single('file'), (req, res) => {
  const category = String((req.body && req.body.category) || '');
  if (!LIBRARY_CATEGORIES.includes(category)) return res.status(400).json({ error: 'bad category' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const name = req.file.originalname || 'file';
  if (!LIBRARY_EXT[category].test(name)) {
    const msg =
      category === 'fonts'
        ? 'Only .ttf and .otf fonts are supported (woff2 renders in preview but not in exports).'
        : `Unsupported file type for ${category}.`;
    return res.status(400).json({ error: msg });
  }
  // Fonts must actually parse — reject a corrupt/renamed file at the door so it
  // can never crash a later export.
  if (category === 'fonts' && !isValidFontBuffer(req.file.buffer)) {
    return res.status(400).json({ error: "That font file couldn't be read — it may be corrupted or not a real .ttf/.otf." });
  }
  try {
    const { entry, deduped } = libraryAdd(category, req.file.buffer, name);
    res.json({ item: libraryEntryPublic(entry), deduped });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/library/rename', (req, res) => {
  const entry = libraryRename(req.body && req.body.id, req.body && req.body.name);
  if (!entry) return res.status(404).json({ error: 'not found' });
  res.json({ item: libraryEntryPublic(entry) });
});

app.post('/api/library/remove', (req, res) => {
  const ok = libraryRemove(req.body && req.body.id);
  res.json({ ok });
});

// Serve one library file (used by <audio>/<img>/<video>/@font-face and the
// export upload path). resolveInside guarantees containment; the entry's
// storedName is server-generated, never user input.
app.get('/api/library/file/:id', (req, res) => {
  const entry = libraryFind(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  let abs;
  try {
    abs = libraryEntryPath(entry);
  } catch {
    return res.status(400).json({ error: 'bad path' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file missing' });
  res.sendFile(abs);
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

// Cancel an in-flight (or still-queued) export: kill the ffmpeg child if one is
// running; a not-yet-spawned job is flagged so processJob aborts before it
// starts. Idempotent — cancelling a finished job just echoes its status.
app.post('/api/cancel/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job id' });
  if (['done', 'error', 'cancelled'].includes(job.status)) {
    return res.json({ ok: true, status: job.status });
  }
  cancelledJobs.add(jobId);
  const child = exportChildren.get(jobId);
  if (child) child.kill('SIGKILL');
  setJob(jobId, { status: 'cancelled' });
  res.json({ ok: true, status: 'cancelled' });
});

// --- recent exports (global, userData) ---------------------------------------
// A small rolling list (last 10) of finished exports so the user can re-open the
// folder or re-render with the same settings. Persisted in userData; the file
// path is never stored — Show-in-Folder re-derives it from OUTPUTS_DIR in the
// main process, so a stale record can never point the shell at an arbitrary path.
const RECENT_EXPORTS_FILE = path.join(DATA_ROOT, 'recent-exports.json');
const RECENT_EXPORTS_MAX = 10;
function readRecentExports() {
  try {
    const v = JSON.parse(fs.readFileSync(RECENT_EXPORTS_FILE, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeRecentExports(list) {
  fs.writeFileSync(RECENT_EXPORTS_FILE, JSON.stringify(list.slice(0, RECENT_EXPORTS_MAX)));
}
app.get('/api/recent-exports', (req, res) => {
  // Annotate each row with whether its output file still exists on disk, so the
  // UI can grey out Show-in-Folder for exports the user has since deleted/moved.
  const list = readRecentExports().map((r) => {
    let fileExists = false;
    try {
      const leaf = safeLeaf(String(r.outputUrl || '').replace('/outputs/', ''));
      fileExists = !!leaf && fs.existsSync(path.join(OUTPUTS_DIR, leaf));
    } catch {}
    return { ...r, fileExists };
  });
  res.json({ exports: list });
});
app.post('/api/recent-exports', (req, res) => {
  const b = req.body || {};
  const rec = {
    id: crypto.randomUUID(),
    filename: typeof b.filename === 'string' ? b.filename.slice(0, 200) : 'export.mp4',
    durationSec: Number.isFinite(b.durationSec) ? b.durationSec : null,
    savedAt: Date.now(),
    outputUrl: typeof b.outputUrl === 'string' ? b.outputUrl.slice(0, 200) : null,
    res: b.res || null,
    crf: b.crf || null,
    loudness: b.loudness !== false,
    sizeBytes: Number.isFinite(b.sizeBytes) ? b.sizeBytes : null,
  };
  const list = [rec, ...readRecentExports()].slice(0, RECENT_EXPORTS_MAX);
  writeRecentExports(list);
  res.json({ exports: list });
});

// --- projects (save/load/autosave) --------------------------------------------
// A project = a JSON snapshot of the editor state + any imported sound/overlay
// media, stored under projects/<id>/. Media rides along in the same multipart
// request (memory storage — these are small clips, not the source video, which
// is referenced by URL or path). Ids are validated to stay inside PROJECTS_DIR.
const projectUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
function projectDir(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  try {
    return resolveInside(PROJECTS_DIR, safe); // belt-and-suspenders over the char filter
  } catch {
    return null;
  }
}

app.post('/api/project/save', projectUpload.array('media'), (req, res) => {
  try {
    const project = JSON.parse(req.body.project);
    const id = (project.id && String(project.id).replace(/[^a-zA-Z0-9_-]/g, '')) || crypto.randomUUID();
    const dir = projectDir(id);
    if (!dir) return res.status(400).json({ error: 'bad project id' });
    const mediaDir = path.join(dir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    for (const f of req.files || []) {
      // originalname is the media id (overlay/sound id) — sanitize to a leaf and
      // confirm it resolves inside mediaDir before writing (no "..", no escape).
      const leaf = safeLeaf(f.originalname);
      if (!leaf) continue;
      let dest;
      try {
        dest = resolveInside(mediaDir, leaf);
      } catch {
        continue;
      }
      fs.writeFileSync(dest, f.buffer);
    }
    project.id = id;
    project.savedAt = Date.now();
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
    res.json({ id, name: project.name || 'Untitled', savedAt: project.savedAt });
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

// --- brand kit (global, userData) --------------------------------------------
const BRAND_JSON = path.join(BRAND_DIR, 'brand-kit.json');
const brandUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function brandDefaults() {
  return {
    defaultFontId: null,
    defaultTextColor: null,
    watermark: { image: null, sizePercent: 18, xPercent: 88, yPercent: 90, opacity: 0.7, onByDefault: false },
  };
}
function readBrandKit() {
  try {
    return { ...brandDefaults(), ...JSON.parse(fs.readFileSync(BRAND_JSON, 'utf8')) };
  } catch {
    return brandDefaults();
  }
}
function clearWatermarkImage() {
  for (const f of fs.readdirSync(BRAND_DIR)) {
    if (f.startsWith('watermark.')) fs.unlinkSync(path.join(BRAND_DIR, f));
  }
}

app.get('/api/brand-kit', (req, res) => res.json(readBrandKit()));

app.post('/api/brand-kit', brandUpload.single('watermark'), (req, res) => {
  try {
    const kit = { ...brandDefaults(), ...JSON.parse(req.body.kit || '{}') };
    kit.watermark = { ...brandDefaults().watermark, ...(kit.watermark || {}) };
    if (req.file) {
      clearWatermarkImage(); // one watermark at a time
      const ext = ((path.extname(req.file.originalname || '').toLowerCase().match(/^\.(png|jpg|jpeg|webp|gif)$/) || ['.png'])[0]);
      fs.writeFileSync(path.join(BRAND_DIR, `watermark${ext}`), req.file.buffer);
      kit.watermark.image = `watermark${ext}`;
    } else if (req.body.removeWatermark === 'true') {
      clearWatermarkImage();
      kit.watermark.image = null;
    }
    fs.writeFileSync(BRAND_JSON, JSON.stringify(kit));
    res.json(kit);
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

app.get('/api/brand-kit/watermark', (req, res) => {
  const name = readBrandKit().watermark.image;
  if (!name) return res.status(404).end();
  let file;
  try {
    file = resolveInside(BRAND_DIR, safeLeaf(name));
  } catch {
    return res.status(400).end();
  }
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

// --- caption settings (global, userData) -------------------------------------
// Quality tier + custom vocabulary. Global (shared across projects, survives
// updates) — lives next to the other userData state.
const CAPTION_SETTINGS_FILE = path.join(DATA_ROOT, 'caption-settings.json');
function captionDefaults() {
  return { tier: DEFAULT_TIER, customVocab: '' };
}
function readCaptionSettings() {
  try {
    return { ...captionDefaults(), ...JSON.parse(fs.readFileSync(CAPTION_SETTINGS_FILE, 'utf8')) };
  } catch {
    return captionDefaults();
  }
}
function writeCaptionSettings(patch) {
  const merged = { ...readCaptionSettings(), ...(patch || {}) };
  merged.tier = TIER_ORDER.includes(merged.tier) ? merged.tier : DEFAULT_TIER;
  merged.customVocab = typeof merged.customVocab === 'string' ? merged.customVocab.slice(0, 2000) : '';
  fs.writeFileSync(CAPTION_SETTINGS_FILE, JSON.stringify(merged));
  return merged;
}

app.get('/api/caption-settings', (req, res) => {
  res.json({
    settings: readCaptionSettings(),
    tiers: tierAvailability({ modelsDir: MODELS_DIR, resourcesDir: process.env.CLIP_EDITOR_RESOURCES }),
    totalMemBytes: os.totalmem(),
  });
});

app.post('/api/caption-settings', (req, res) => {
  res.json({ settings: writeCaptionSettings(req.body || {}) });
});

// --- misc app UI state (global, userData) ------------------------------------
// Tiny persistent flags that live across projects AND app updates: whether the
// first-run onboarding has been shown, and the last app version whose "what's
// new" card the user has already seen. One small JSON next to the other
// userData state — deliberately schema-less so new flags need no migration.
const APP_STATE_FILE = path.join(DATA_ROOT, 'app-state.json');
function readAppState() {
  try {
    const v = JSON.parse(fs.readFileSync(APP_STATE_FILE, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function writeAppState(patch) {
  const merged = { ...readAppState(), ...(patch && typeof patch === 'object' ? patch : {}) };
  fs.writeFileSync(APP_STATE_FILE, JSON.stringify(merged));
  return merged;
}
app.get('/api/app-state', (req, res) => res.json(readAppState()));
app.post('/api/app-state', (req, res) => res.json(writeAppState(req.body || {})));

// --- what's-new release notes ------------------------------------------------
// The app's own version + the bundled bullet notes for it (release-notes.json,
// keyed by version). The client compares this version to app-state.lastSeenVersion
// to decide whether to show the one-time "What's new" card. Notes ship inside the
// build — no network — so this works fully offline.
app.get('/api/release-notes', (req, res) => {
  let version = '';
  try {
    version = String(require('./package.json').version || '');
  } catch {
    version = '';
  }
  let notes = [];
  try {
    const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-notes.json'), 'utf8'));
    if (all && Array.isArray(all[version])) notes = all[version].filter((n) => typeof n === 'string').slice(0, 5);
  } catch {
    notes = [];
  }
  res.json({ version, notes });
});

// --- project templates (global, userData) ------------------------------------
// A template = a JSON snapshot of the reusable LOOK of a project (aspect,
// layout, background, caption group style, watermark, manual text layers) —
// never the source clip or transcript. One <id>.json per template so rename and
// delete touch a single file. No media rides along (templates carry no uploads).
function templateFile(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  try {
    return resolveInside(TEMPLATES_DIR, `${safe}.json`);
  } catch {
    return null;
  }
}
function readAllTemplates() {
  let files = [];
  try {
    files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8'));
      if (t && t.id) out.push(t);
    } catch {
      /* skip a corrupt template file */
    }
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}
app.get('/api/templates', (req, res) => res.json({ templates: readAllTemplates() }));

app.post('/api/templates', (req, res) => {
  try {
    const body = req.body || {};
    const id = (body.id && String(body.id).replace(/[^a-zA-Z0-9_-]/g, '')) || crypto.randomUUID();
    const file = templateFile(id);
    if (!file) return res.status(400).json({ error: 'bad template id' });
    const name = (typeof body.name === 'string' && body.name.trim().slice(0, 80)) || 'Untitled template';
    const existing = (() => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    })();
    const template = {
      id,
      name,
      createdAt: (existing && existing.createdAt) || Date.now(),
      updatedAt: Date.now(),
      data: body.data && typeof body.data === 'object' ? body.data : {},
      summary: body.summary && typeof body.summary === 'object' ? body.summary : {},
    };
    fs.writeFileSync(file, JSON.stringify(template));
    res.json({ template });
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

app.post('/api/templates/rename', (req, res) => {
  const { id, name } = req.body || {};
  const file = templateFile(id);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    t.name = (typeof name === 'string' && name.trim().slice(0, 80)) || t.name;
    t.updatedAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(t));
    res.json({ template: t });
  } catch (err) {
    res.status(400).json({ error: String((err && err.message) || err) });
  }
});

app.post('/api/templates/delete', (req, res) => {
  const file = templateFile((req.body || {}).id);
  if (!file) return res.status(400).json({ error: 'bad id' });
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
  res.json({ ok: true });
});

// --- caption model downloads (user-initiated, from Hugging Face) --------------
// The ONLY new network activity in the app (see SECURITY.md). Streams a tier's
// ggml model to userData/models via a .part file, verifies the exact byte size,
// and only then swaps it into place — a cancelled/failed/corrupt download never
// leaves a half file that whisper would choke on.
const modelDownloads = new Map(); // jobId -> job

function followingGet(url, onResponse, onError, redirects = 0) {
  const req = https.get(url, { headers: { 'User-Agent': 'clip-editor' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
      res.resume();
      return followingGet(res.headers.location, onResponse, onError, redirects + 1);
    }
    onResponse(res, req);
  });
  req.on('error', onError);
  return req;
}

function startModelDownload(tier) {
  const spec = CAPTION_TIERS[tier];
  const jobId = crypto.randomUUID();
  const dest = path.join(MODELS_DIR, spec.file);
  const partPath = `${dest}.part`;
  const job = { tier, state: 'downloading', downloadedBytes: 0, totalBytes: spec.sizeBytes || 0, error: null, aborted: false, req: null };
  modelDownloads.set(jobId, job);

  const fail = (msg) => {
    if (job.state === 'done') return;
    job.state = 'error';
    job.error = msg;
    try {
      fs.unlinkSync(partPath);
    } catch {
      /* nothing to clean */
    }
  };

  try {
    fs.rmSync(partPath, { force: true });
  } catch {
    /* ignore */
  }
  const out = fs.createWriteStream(partPath);
  job.req = followingGet(
    spec.url,
    (res, req) => {
      if (res.statusCode !== 200) {
        res.resume();
        out.destroy();
        return fail(`download failed (HTTP ${res.statusCode})`);
      }
      const total = parseInt(res.headers['content-length'], 10);
      if (Number.isFinite(total)) job.totalBytes = total;
      job.req = req;
      res.on('data', (chunk) => {
        job.downloadedBytes += chunk.length;
      });
      res.on('error', (e) => {
        out.destroy();
        if (!job.aborted) fail(e.message);
      });
      res.pipe(out);
      out.on('finish', () => {
        if (job.aborted) return;
        let size = 0;
        try {
          size = fs.statSync(partPath).size;
        } catch {
          return fail('download vanished');
        }
        // Exact-size verification against the known HF byte count — a truncated
        // or corrupted download won't match.
        if (spec.sizeBytes && size !== spec.sizeBytes) {
          return fail(`size check failed (${size} of ${spec.sizeBytes} bytes)`);
        }
        try {
          fs.renameSync(partPath, dest);
          job.state = 'done';
        } catch (e) {
          fail(`could not save model: ${e.message}`);
        }
      });
    },
    (e) => {
      out.destroy();
      if (!job.aborted) fail(e.message);
    }
  );
  return jobId;
}

app.post('/api/model/download', (req, res) => {
  const tier = (req.body || {}).tier;
  const spec = CAPTION_TIERS[tier];
  if (!spec || !spec.url) return res.status(400).json({ error: 'nothing to download for that tier' });
  const dirs = { modelsDir: MODELS_DIR, resourcesDir: process.env.CLIP_EDITOR_RESOURCES };
  if (tierModelPath(tier, dirs)) return res.json({ jobId: null, alreadyHave: true });
  res.json({ jobId: startModelDownload(tier) });
});

app.get('/api/model/status/:jobId', (req, res) => {
  const job = modelDownloads.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown download' });
  const pct = job.totalBytes ? Math.min(100, Math.round((job.downloadedBytes / job.totalBytes) * 100)) : 0;
  res.json({
    tier: job.tier,
    state: job.state, // 'downloading' | 'done' | 'error' | 'cancelled'
    percent: pct,
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    error: job.error,
  });
});

app.post('/api/model/cancel/:jobId', (req, res) => {
  const job = modelDownloads.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown download' });
  job.aborted = true;
  job.state = 'cancelled';
  try {
    if (job.req) job.req.destroy();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(path.join(MODELS_DIR, `${CAPTION_TIERS[job.tier].file}.part`), { force: true });
  } catch {
    /* ignore */
  }
  res.json({ ok: true });
});

app.post('/api/model/remove', (req, res) => {
  const tier = (req.body || {}).tier;
  const spec = CAPTION_TIERS[tier];
  if (!spec || spec.bundled) return res.status(400).json({ error: 'that model cannot be removed' });
  // Only remove from the user's models dir (never the bundled resources copy).
  const p = path.join(MODELS_DIR, spec.file);
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* already gone */
  }
  res.json({ ok: true });
});

app.get('/api/projects', (req, res) => {
  const projects = [];
  let autosave = null;
  for (const id of fs.readdirSync(PROJECTS_DIR)) {
    const p = path.join(PROJECTS_DIR, id, 'project.json');
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const entry = { id, name: j.name || 'Untitled', savedAt: j.savedAt || 0, sourceKind: j.source && j.source.kind };
      if (id === 'autosave') autosave = entry;
      else projects.push(entry);
    } catch {}
  }
  projects.sort((a, b) => b.savedAt - a.savedAt);
  res.json({ projects, autosave });
});

app.get('/api/project/:id', (req, res) => {
  const dir = projectDir(req.params.id);
  const p = dir && path.join(dir, 'project.json');
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  // Parse defensively: a corrupt/truncated project.json must not crash the
  // request, and only a well-formed object is returned to the client.
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return res.status(422).json({ error: 'project file is corrupt' });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(422).json({ error: 'project file is malformed' });
  }
  res.json(data);
});

app.delete('/api/project/:id', (req, res) => {
  const dir = projectDir(req.params.id);
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// Imported media for a project, served back so the frontend can re-wrap it as
// a File on open: /api/project/<id>/media/<leaf>
app.get('/api/project/:id/media/:leaf', (req, res) => {
  const dir = projectDir(req.params.id);
  if (!dir) return res.status(404).end();
  const leaf = safeLeaf(req.params.leaf);
  if (!leaf) return res.status(404).end();
  let file;
  try {
    file = resolveInside(path.join(dir, 'media'), leaf); // must stay in media/
  } catch {
    return res.status(404).end();
  }
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

// REMOVED (any-file-on-disk read primitive): this endpoint used to take an
// arbitrary absolute path from the request body and copy that file into the
// web-served preview-cache — so any LAN host or website reaching the server
// could read any file on disk (~/.ssh/id_rsa, project.json anywhere, etc.).
// File-source reopening now goes through an Electron IPC call in the main
// process (electron/main.js `reopen-file`), so the HTTP server never touches a
// caller-supplied path. In dev (no Electron) reopening falls back to re-picking
// the file. Kept as an explicit 410 so an old client gets a clear error.
app.post('/api/preview-file', (req, res) =>
  res.status(410).json({ error: 'removed: reopen file-based projects from the desktop app' })
);

resolveFontPath(); // logs which caption font got resolved, right at boot

// Bind to loopback ONLY (was app.listen(PORT) = every interface, LAN-reachable).
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Clip Editor server on http://127.0.0.1:${PORT} (loopback only)`);
});
// Never half-listen: if the port is taken, fail loudly instead of silently
// continuing (which would leave the app pointed at a stranger's server).
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[clip-editor] port ${PORT} is already in use — refusing to start. Close the other instance or set a different PORT.`);
  } else {
    console.error('[clip-editor] server failed to start:', err);
  }
  process.exit(1);
});
