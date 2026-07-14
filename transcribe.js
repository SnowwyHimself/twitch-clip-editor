const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Auto-captions via a local whisper.cpp binary — deliberately no cloud STT
// API, matching the app's local-first principle. The binary is resolved the
// same way ffmpeg/yt-dlp are (packaged extraResources bin/ first, PATH
// second); the model file is the one genuinely new kind of dependency, a
// ~148MB ggml file fetched once by scripts/fetch-whisper-model.sh (or
// pointed at directly with WHISPER_MODEL).

const MODEL_ENV = 'WHISPER_MODEL';

// Homebrew's whisper-cpp formula has shipped the CLI under both names over
// time (`whisper-cli` currently, `whisper-cpp` before that) — try both on
// PATH rather than betting on one.
const WHISPER_BINARY_NAMES = ['whisper-cli', 'whisper-cpp'];

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(Object.assign(new Error(`${cmd} is not installed`), { code: 'ENOENT' }));
      } else {
        reject(new Error(`Failed to start ${cmd}: ${err.message}`));
      }
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

// Directories a whisper CLI could plausibly live in beyond PATH — GUI-
// launched (packaged Electron) processes inherit a minimal PATH that skips
// Homebrew's /opt/homebrew/bin, and this machine keeps its media binaries
// (ffmpeg/yt-dlp) in ~/.local/bin, so a manually-installed whisper-cli
// naturally lands there too.
function fallbackBinDirs() {
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
}

function resolveWhisperBinary(resourcesDir) {
  if (resourcesDir) {
    for (const name of WHISPER_BINARY_NAMES) {
      const candidate = path.join(resourcesDir, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of WHISPER_BINARY_NAMES) {
    if (pathDirs.some((dir) => fs.existsSync(path.join(dir, name)))) return name;
    for (const dir of fallbackBinDirs()) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// The models dir is scanned for any ggml *.bin rather than hardcoding one
// filename, so swapping base.en for small.en (or a multilingual model) is
// just a matter of dropping a different file in — no config change. The
// user's models dir is checked first (a model they dropped there wins),
// then the app's bundled resources/models (the packaged desktop app ships
// ggml-base.en.bin there, so auto-captions works with no extra install).
function modelDirs({ modelsDir, resourcesDir }) {
  const dirs = [modelsDir];
  if (resourcesDir) dirs.push(path.join(resourcesDir, 'models'));
  return dirs;
}

// Caption quality tiers (user-facing names live in the UI — here we only map to
// the concrete ggml model + its DTW token-alignment preset). Fast is the bundled
// base.en (works offline, no download); Better/Best are downloaded on demand into
// userData/models (see the download manager). Sizes are the exact HF byte counts
// used to verify a finished download.
const CAPTION_TIERS = {
  fast: { file: 'ggml-base.en.bin', dtw: 'base.en', bundled: true, sizeBytes: null, url: null },
  better: {
    file: 'ggml-small.en.bin',
    dtw: 'small.en',
    bundled: false,
    sizeBytes: 487614201,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
  },
  best: {
    // q5_0 quant of large-v3-turbo — a fraction of the full 1.6 GB f16 with
    // negligible caption-quality loss, so it fits far more machines.
    file: 'ggml-large-v3-turbo-q5_0.bin',
    dtw: 'large.v3.turbo',
    bundled: false,
    sizeBytes: 574041195,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  },
};
const TIER_ORDER = ['fast', 'better', 'best'];
const DEFAULT_TIER = 'fast';

// A specific tier's model file on disk (userData models first, then bundled
// resources/models), or null if it isn't present.
function tierModelPath(tier, { modelsDir, resourcesDir }) {
  const spec = CAPTION_TIERS[tier];
  if (!spec) return null;
  for (const dir of modelDirs({ modelsDir, resourcesDir })) {
    const candidate = path.join(dir, spec.file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Per-tier availability, for the settings UI + status endpoint.
function tierAvailability(dirs) {
  const out = {};
  for (const tier of TIER_ORDER) {
    const p = tierModelPath(tier, dirs);
    out[tier] = {
      available: !!p,
      bundled: !!CAPTION_TIERS[tier].bundled,
      sizeBytes: CAPTION_TIERS[tier].sizeBytes,
      file: CAPTION_TIERS[tier].file,
    };
  }
  return out;
}

// The tier we'll actually run: the requested one if its model is present, else
// the best AVAILABLE tier (highest on disk — Fast is always bundled). Lets
// generation proceed transparently while a bigger model is still downloading.
function effectiveTier(requested, dirs) {
  const req = CAPTION_TIERS[requested] ? requested : DEFAULT_TIER;
  const reqPath = tierModelPath(req, dirs);
  if (reqPath) return { tier: req, modelPath: reqPath, requested: req, downgraded: false };
  for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
    const t = TIER_ORDER[i];
    const p = tierModelPath(t, dirs);
    if (p) return { tier: t, modelPath: p, requested: req, downgraded: t !== req };
  }
  return { tier: null, modelPath: null, requested: req, downgraded: false };
}

// The silero VAD model (optional). When present, transcription runs with
// Voice Activity Detection, which isolates speech and skips wind/background
// noise — big accuracy + timing win on noisy clips.
function resolveVadModelPath({ modelsDir, resourcesDir }) {
  for (const dir of modelDirs({ modelsDir, resourcesDir })) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const vad = entries.find((name) => /silero|vad/i.test(name) && /\.bin$/.test(name));
    if (vad) return path.join(dir, vad);
  }
  return null;
}

// Reports what's missing (binary/model) so the frontend can show setup
// instructions instead of a raw spawn error.
function checkWhisperSetup({ resourcesDir, modelsDir }) {
  const binary = resolveWhisperBinary(resourcesDir);
  // Ready = a binary + ANY tier model on disk. An explicit WHISPER_MODEL override
  // still counts (power users pointing at their own file).
  const envModel = process.env[MODEL_ENV];
  const model =
    (envModel && fs.existsSync(envModel) && envModel) || effectiveTier(DEFAULT_TIER, { modelsDir, resourcesDir }).modelPath;
  return { binary, model, ready: !!(binary && model) };
}

// Caption blocks want short, punchy lines (TikTok-style), not whisper's
// default sentence-length segments — max-len in characters plus
// split-on-word keeps blocks readable without cutting mid-word. Word mode
// (max-len 1) gives one segment per word for the one-word-at-a-time
// caption style.
const MAX_SEGMENT_CHARS = 28;

// whisper's default segment timestamps come from a heuristic and can
// drift noticeably from the actual speech — its DTW token-alignment mode
// (--dtw) anchors them to the audio much more tightly, which matters most
// in word mode where every word is its own caption. --dtw needs to be
// told which model architecture it's aligning against; derive that from
// the model filename (ggml-base.en.bin -> "base.en") and skip the flag
// entirely for a filename we don't recognize rather than risking a hard
// whisper error.
function dtwTypeFromModelPath(modelPath) {
  const match = path.basename(modelPath).match(/^ggml-(tiny|base|small|medium|large\.v[123])(\.en)?\.bin$/);
  return match ? `${match[1]}${match[2] || ''}` : null;
}

// Turn the user's "names & words to recognize" list into a whisper initial
// prompt — a natural comma phrase that biases spelling toward these terms.
// Split on commas/newlines (so multi-word terms like "World Cup" survive), dedupe
// case-insensitively, and cap the length well under whisper's prompt token window
// (~n_text_ctx/2) by dropping trailing terms rather than erroring.
const VOCAB_PROMPT_MAX_CHARS = 600;
function formatVocabPrompt(vocab) {
  if (!vocab || typeof vocab !== 'string') return '';
  const seen = new Set();
  const terms = [];
  for (const raw of vocab.split(/[,\n]+/)) {
    const t = raw.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
  }
  let out = '';
  for (const t of terms) {
    const next = out ? `${out}, ${t}` : t;
    if (next.length > VOCAB_PROMPT_MAX_CHARS) break;
    out = next;
  }
  return out;
}

async function transcribeSource(
  inputPath,
  { ffmpegBin, resourcesDir, modelsDir, workDir, mode = 'blocks', tier = DEFAULT_TIER, prompt = '' }
) {
  const binary = resolveWhisperBinary(resourcesDir);
  if (!binary) {
    throw new Error(
      'whisper.cpp is not installed. Install it with "brew install whisper-cpp" (macOS), then retry.'
    );
  }
  const dirs = { modelsDir, resourcesDir };

  // Model selection: an explicit WHISPER_MODEL override wins (power users), else
  // the requested quality tier, transparently downgraded to the best AVAILABLE
  // tier if that model isn't downloaded yet.
  const envModel = process.env[MODEL_ENV];
  let modelPath = envModel && fs.existsSync(envModel) ? envModel : null;
  let usedTier = tier;
  let requestedTier = tier;
  let downgraded = false;
  let dtwPreset;
  if (modelPath) {
    dtwPreset = dtwTypeFromModelPath(modelPath);
    usedTier = null;
  } else {
    const eff = effectiveTier(tier, dirs);
    if (!eff.modelPath) {
      throw new Error(
        `No whisper model found in ${modelsDir}. Run "npm run fetch-whisper-model" once to download it, then retry.`
      );
    }
    modelPath = eff.modelPath;
    usedTier = eff.tier;
    requestedTier = eff.requested;
    downgraded = eff.downgraded;
    dtwPreset = CAPTION_TIERS[usedTier] && CAPTION_TIERS[usedTier].dtw;
  }

  const stamp = crypto.randomUUID();
  const wavPath = path.join(workDir, `${stamp}.wav`);
  const outBase = path.join(workDir, `${stamp}`);
  const jsonPath = `${outBase}.json`;

  try {
    // whisper.cpp wants 16kHz mono PCM — extract it regardless of what the
    // source container/codec is.
    await runCommand(ffmpegBin, ['-y', '-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]);

    const args = [
      '-m', modelPath,
      '-f', wavPath,
      '-oj',            // JSON output (written to <-of base>.json)
      '-of', outBase,
      '-ml', mode === 'words' ? '1' : String(MAX_SEGMENT_CHARS),
      '-sow',           // split on word boundaries, never mid-word
    ];
    if (dtwPreset) args.push('--dtw', dtwPreset);

    // Custom vocabulary — initial prompt biasing (names, game terms). Empty =
    // exactly the previous behavior. Applies on every tier.
    const vocabPrompt = formatVocabPrompt(prompt);
    if (vocabPrompt) args.push('--prompt', vocabPrompt);

    // Voice Activity Detection when the silero model is available — isolates
    // speech and skips wind/background noise, which is the main cause of bad
    // timing/accuracy on noisy clips. A little speech padding avoids clipping
    // word onsets.
    const vadModel = resolveVadModelPath({ resourcesDir, modelsDir });
    if (vadModel) {
      args.push('--vad', '--vad-model', vadModel, '--vad-speech-pad-ms', '48');
    }
    await runCommand(binary, args);

    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const rawSegments = parsed.transcription || [];
    const segments = rawSegments
      .map((seg) => ({
        start: (seg.offsets && seg.offsets.from) / 1000,
        end: (seg.offsets && seg.offsets.to) / 1000,
        text: (seg.text || '').trim(),
      }))
      .filter((seg) => seg.text && Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start);

    // Raw word segments — display timing (continuous, capped so nothing lingers
    // through a long pause) is decided when words are grouped into caption
    // blocks on the client (see groupCaptionWords in panel.js). `tier` reports
    // which model actually ran so the UI can note a transparent downgrade.
    return { segments, tier: usedTier, requestedTier, downgraded };
  } finally {
    fs.unlink(wavPath, () => {});
    fs.unlink(jsonPath, () => {});
  }
}

module.exports = {
  transcribeSource,
  checkWhisperSetup,
  CAPTION_TIERS,
  TIER_ORDER,
  DEFAULT_TIER,
  tierAvailability,
  tierModelPath,
  effectiveTier,
  formatVocabPrompt,
};
