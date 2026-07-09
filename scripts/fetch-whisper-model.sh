#!/usr/bin/env bash
# Downloads the whisper.cpp model used for auto-captions into models/.
# base.en: English-only, ~148MB — the best accuracy/speed/size tradeoff for
# Twitch clip captioning. Swap WHISPER_MODEL_NAME for e.g. ggml-small.en.bin
# (better accuracy, ~488MB) or ggml-base.bin (multilingual) if needed; the
# server picks up whichever ggml-*.bin it finds in models/.
set -euo pipefail

MODEL_NAME="${WHISPER_MODEL_NAME:-ggml-base.en.bin}"
MODELS_DIR="$(cd "$(dirname "$0")/.." && pwd)/models"
DEST="$MODELS_DIR/$MODEL_NAME"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME"

if [ -f "$DEST" ]; then
  echo "Model already present: $DEST"
  exit 0
fi

mkdir -p "$MODELS_DIR"
if [ ! -f "$DEST" ]; then
  echo "Downloading $MODEL_NAME (~148MB for base.en)..."
  curl -L --fail --progress-bar -o "$DEST.tmp" "$URL"
  mv "$DEST.tmp" "$DEST"
  echo "Done: $DEST"
fi

# Silero VAD model (~0.9MB) — enables Voice Activity Detection so noisy
# clips transcribe far better (see transcribe.js). Optional; skipped
# silently if the download fails.
VAD_NAME="ggml-silero-v5.1.2.bin"
VAD_DEST="$MODELS_DIR/$VAD_NAME"
if [ ! -f "$VAD_DEST" ]; then
  echo "Downloading VAD model ($VAD_NAME)..."
  curl -L --fail -o "$VAD_DEST.tmp" "https://huggingface.co/ggml-org/whisper-vad/resolve/main/$VAD_NAME" \
    && mv "$VAD_DEST.tmp" "$VAD_DEST" && echo "Done: $VAD_DEST" \
    || { echo "VAD model download failed — auto-captions still work, just without VAD."; rm -f "$VAD_DEST.tmp"; }
fi
