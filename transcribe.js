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
function resolveModelPath({ modelsDir, resourcesDir }) {
  const fromEnv = process.env[MODEL_ENV];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const dirs = [modelsDir];
  if (resourcesDir) dirs.push(path.join(resourcesDir, 'models'));
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const model = entries.find((name) => /^ggml-.*\.bin$/.test(name));
    if (model) return path.join(dir, model);
  }
  return null;
}

// Reports what's missing (binary/model) so the frontend can show setup
// instructions instead of a raw spawn error.
function checkWhisperSetup({ resourcesDir, modelsDir }) {
  const binary = resolveWhisperBinary(resourcesDir);
  const model = resolveModelPath({ modelsDir, resourcesDir });
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

async function transcribeSource(inputPath, { ffmpegBin, resourcesDir, modelsDir, workDir, mode = 'blocks' }) {
  const setup = checkWhisperSetup({ resourcesDir, modelsDir });
  if (!setup.binary) {
    throw new Error(
      'whisper.cpp is not installed. Install it with "brew install whisper-cpp" (macOS), then retry.'
    );
  }
  if (!setup.model) {
    throw new Error(
      `No whisper model found in ${modelsDir}. Run "npm run fetch-whisper-model" once to download it (~148MB), then retry.`
    );
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
      '-m', setup.model,
      '-f', wavPath,
      '-oj',            // JSON output (written to <-of base>.json)
      '-of', outBase,
      '-ml', mode === 'words' ? '1' : String(MAX_SEGMENT_CHARS),
      '-sow',           // split on word boundaries, never mid-word
    ];
    const dtwType = dtwTypeFromModelPath(setup.model);
    if (dtwType) args.push('--dtw', dtwType);
    await runCommand(setup.binary, args);

    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const rawSegments = parsed.transcription || [];
    return rawSegments
      .map((seg) => ({
        start: (seg.offsets && seg.offsets.from) / 1000,
        end: (seg.offsets && seg.offsets.to) / 1000,
        text: (seg.text || '').trim(),
      }))
      .filter((seg) => seg.text && Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start);
  } finally {
    fs.unlink(wavPath, () => {});
    fs.unlink(jsonPath, () => {});
  }
}

module.exports = { transcribeSource, checkWhisperSetup };
