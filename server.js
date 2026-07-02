const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { renderCaptionPng, resolveFontPath } = require('./caption');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');
const OUTPUTS_DIR = path.join(ROOT, 'outputs');
const CAPTIONS_DIR = path.join(ROOT, 'captions');

for (const dir of [UPLOADS_DIR, DOWNLOADS_DIR, OUTPUTS_DIR, CAPTIONS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const CANVAS_W = 1080;
const CANVAS_H = 1920;
const MIN_ZOOM = 1.0;
const MAX_ZOOM = 2.0;
const MIN_BLUR = 0;
const MAX_BLUR = 100;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2.0;

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
  if (Number.isNaN(blur)) return 20;
  return Math.min(MAX_BLUR, Math.max(MIN_BLUR, blur));
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
  return value === 'box' ? 'box' : 'outline';
}

function normalizeMirror(value) {
  return value === true || value === 'true';
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
    const child = spawn('ffmpeg', ['-i', inputPath]);
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
      resolve({ width: parseInt(videoMatch[1], 10), height: parseInt(videoMatch[2], 10), hasAudio });
    });
  });
}

// Mirrors the fgWidth/fgHeight math the ffmpeg filter graph itself performs
// (scale to fgWidth, preserve aspect ratio, round to even), so the caption
// overlay can be positioned before ffmpeg ever runs.
function computeForegroundHeight(fgWidth, srcWidth, srcHeight) {
  const rawHeight = fgWidth * (srcHeight / srcWidth);
  return Math.round(rawHeight / 2) * 2;
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
// PNG on top at the precomputed y position (horizontally centered).
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
function buildSourcePrefix(speed, mirror, consumerCount) {
  const steps = [];
  if (speed !== 1) {
    steps.push(`setpts=(1/${speed})*PTS`);
  }
  if (mirror) {
    steps.push('hflip');
  }

  if (steps.length === 0) {
    return consumerCount === 2 ? { stage: '', labels: ['[0:v]', '[0:v]'] } : { stage: '', labels: ['[0:v]'] };
  }

  const chain = steps.join(',');
  if (consumerCount === 2) {
    return { stage: `[0:v]${chain},split=2[src1][src2];`, labels: ['[src1]', '[src2]'] };
  }
  return { stage: `[0:v]${chain}[src];`, labels: ['[src]'] };
}

function buildFilterComplex(zoom, blur, captionOverlay, mirror, speed) {
  const fgWidth = Math.round((CANVAS_W * zoom) / 2) * 2;
  const fgChain = `scale=${fgWidth}:-2,crop=${CANVAS_W}:ih:(iw-${CANVAS_W})/2:0`;
  const compositeLabel = captionOverlay ? '[comp]' : '[precap]';

  let graph;
  if (blur <= 0) {
    const { stage, labels } = buildSourcePrefix(speed, mirror, 1);
    graph = `${stage}${labels[0]}${fgChain},pad=${CANVAS_W}:${CANVAS_H}:0:(${CANVAS_H}-ih)/2:color=black${compositeLabel}`;
  } else {
    const { stage, labels } = buildSourcePrefix(speed, mirror, 2);
    const [bgSource, fgSource] = labels;
    const bg = `${bgSource}scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H},gblur=sigma=${blur}[bg]`;
    const fg = `${fgSource}${fgChain}[fg]`;
    const overlay = `[bg][fg]overlay=(W-w)/2:(H-h)/2${compositeLabel}`;
    graph = `${stage}${bg};${fg};${overlay}`;
  }

  if (captionOverlay) {
    graph += `;[comp][1:v]overlay=(W-w)/2:${captionOverlay.y}[precap]`;
  }

  graph += `;[precap]setsar=1[outv]`;

  return graph;
}

async function runFfmpeg(inputPath, outputPath, zoom, blur, captionOverlay, mirror, speed, hasAudio) {
  let filterComplex = buildFilterComplex(zoom, blur, captionOverlay, mirror, speed);
  const args = ['-y', '-i', inputPath];
  if (captionOverlay) {
    args.push('-i', captionOverlay.pngPath);
  }

  // atempo only accepts 0.5-2.0 per instance, which matches the slider's
  // own range exactly, so a single atempo call always suffices — no need
  // to chain multiple instances for extreme speed values.
  let audioMap = '0:a?';
  if (speed !== 1 && hasAudio) {
    filterComplex += `;[0:a]atempo=${speed}[outa]`;
    audioMap = '[outa]';
  }

  args.push(
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', audioMap,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '19',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart', // moves the moov atom to the front so <video> playback doesn't fail/stall before the file is fully downloaded
    outputPath,
  );
  await runCommand('ffmpeg', args);
}

// Renders the caption to a temp PNG and computes its overlay position so
// the image's exact vertical center lands on fgTopY — the seam where the
// sharp foreground clip meets the blurred background above it. Takes
// mediaInfo (source width/height) as already-probed data rather than
// probing itself, since the caller may also need it for audio detection
// when speed is adjusted — one probe covers both needs.
function buildCaptionOverlay(jobId, mediaInfo, captionText, captionStyle, zoom) {
  if (typeof captionText !== 'string' || !captionText.trim()) return null;

  const { buffer, height } = renderCaptionPng({ text: captionText, style: captionStyle });
  const fgWidth = Math.round((CANVAS_W * zoom) / 2) * 2;
  const fgHeight = computeForegroundHeight(fgWidth, mediaInfo.width, mediaInfo.height);
  const fgTopY = (CANVAS_H - fgHeight) / 2;
  const y = Math.round(fgTopY - height / 2);

  const pngPath = path.join(CAPTIONS_DIR, `${jobId}.png`);
  fs.writeFileSync(pngPath, buffer);
  return { pngPath, y };
}

async function downloadWithYtDlp(url, jobId) {
  const outputTemplate = path.join(DOWNLOADS_DIR, `${jobId}.%(ext)s`);
  await runCommand('yt-dlp', ['-o', outputTemplate, '--no-playlist', url]);
  const match = fs
    .readdirSync(DOWNLOADS_DIR)
    .find((name) => name.startsWith(`${jobId}.`));
  if (!match) {
    throw new Error('yt-dlp reported success but no downloaded file was found');
  }
  return path.join(DOWNLOADS_DIR, match);
}

async function processJob(jobId, inputPath, zoom, blur, captionText, captionStyle, mirror, speed) {
  let captionOverlay = null;
  try {
    setJob(jobId, { status: 'processing' });
    const outputPath = path.join(OUTPUTS_DIR, `${jobId}.mp4`);

    const needsProbe = (typeof captionText === 'string' && captionText.trim()) || speed !== 1;
    const mediaInfo = needsProbe ? await probeSource(inputPath) : null;

    captionOverlay = buildCaptionOverlay(jobId, mediaInfo, captionText, captionStyle, zoom);
    const hasAudio = mediaInfo ? mediaInfo.hasAudio : true;

    await runFfmpeg(inputPath, outputPath, zoom, blur, captionOverlay, mirror, speed, hasAudio);
    setJob(jobId, { status: 'done', outputUrl: `/outputs/${jobId}.mp4` });
  } catch (err) {
    setJob(jobId, { status: 'error', error: err.message });
  } finally {
    if (captionOverlay) {
      fs.unlink(captionOverlay.pngPath, () => {});
    }
  }
}

async function downloadAndProcess(jobId, url, zoom, blur, captionText, captionStyle, mirror, speed) {
  try {
    setJob(jobId, { status: 'downloading' });
    const inputPath = await downloadWithYtDlp(url, jobId);
    await processJob(jobId, inputPath, zoom, blur, captionText, captionStyle, mirror, speed);
  } catch (err) {
    setJob(jobId, { status: 'error', error: err.message });
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.mp4';
      cb(null, `${req.jobId}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/outputs', express.static(OUTPUTS_DIR));

app.post('/api/process-url', (req, res) => {
  const { url, zoom, blur, captionText, captionStyle, mirror, speed } = req.body || {};
  const trimmedUrl = typeof url === 'string' ? url.trim() : '';
  if (!isValidHttpUrl(trimmedUrl)) {
    return res.status(400).json({ error: 'Please enter a valid clip URL (starting with http:// or https://)' });
  }

  const jobId = createJob();
  res.json({ jobId });
  downloadAndProcess(
    jobId,
    trimmedUrl,
    clampZoom(zoom),
    clampBlur(blur),
    captionText,
    clampCaptionStyle(captionStyle),
    normalizeMirror(mirror),
    clampSpeed(speed)
  );
});

app.post(
  '/api/process-upload',
  (req, res, next) => {
    req.jobId = crypto.randomUUID();
    next();
  },
  upload.single('video'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'A video file is required' });
    }
    const jobId = req.jobId;
    jobs.set(jobId, { status: 'processing' });
    res.json({ jobId });
    processJob(
      jobId,
      req.file.path,
      clampZoom(req.body.zoom),
      clampBlur(req.body.blur),
      req.body.captionText,
      clampCaptionStyle(req.body.captionStyle),
      normalizeMirror(req.body.mirror),
      clampSpeed(req.body.speed)
    );
  }
);

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
