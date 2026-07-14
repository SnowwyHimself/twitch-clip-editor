#!/usr/bin/env bash
# Downloads the ffmpeg + yt-dlp binaries that get bundled into the Windows
# desktop app build (see package.json's "build.win.extraResources"). Not
# committed to the repo — kept out of git history since they're large and
# yt-dlp in particular needs frequent updates to keep working against site
# changes. Windows x64 only.
#
# ffmpeg comes from BtbN/FFmpeg-Builds — the Windows build source
# ffmpeg.org's own download page links to. yt-dlp ships an official
# standalone yt-dlp.exe directly from its GitHub releases.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/resources/bin-win"
mkdir -p "$BIN_DIR"

# The caption renderer's native Windows binding, added non-destructively so
# it can coexist with the mac binding (see ensure-resvg-binding.sh for the
# full why). electron-builder's win `files` config excludes the darwin one,
# so only the win32 binding ends up in the .exe.
echo "Ensuring Windows resvg native binding (cross-platform build fix)..."
bash "$ROOT/scripts/ensure-resvg-binding.sh" resvg-js-win32-x64-msvc

FFMPEG_ZIP_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-7.1.zip"
FFMPEG_ZIP_ENTRY="ffmpeg-n7.1-latest-win64-gpl-7.1/bin/ffmpeg.exe"

echo "Fetching ffmpeg (win64)..."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -sL -o "$TMP_DIR/ffmpeg-win64.zip" "$FFMPEG_ZIP_URL"
unzip -q "$TMP_DIR/ffmpeg-win64.zip" "$FFMPEG_ZIP_ENTRY" -d "$TMP_DIR"
cp "$TMP_DIR/$FFMPEG_ZIP_ENTRY" "$BIN_DIR/ffmpeg.exe"

# yt-dlp: pin via YTDLP_VERSION for reproducible builds, else 'latest'. Verified
# against yt-dlp's OWN published SHA2-256SUMS from the same release before bundling.
YTDLP_VERSION="${YTDLP_VERSION:-latest}"
if [ "$YTDLP_VERSION" = "latest" ]; then
  YTDLP_BASE="https://github.com/yt-dlp/yt-dlp/releases/latest/download"
else
  YTDLP_BASE="https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION"
fi
echo "Fetching yt-dlp (Windows, $YTDLP_VERSION)..."
curl -fsSL -o "$BIN_DIR/yt-dlp.exe" "$YTDLP_BASE/yt-dlp.exe"
curl -fsSL -o "$TMP_DIR/yt-dlp.SHA2-256SUMS" "$YTDLP_BASE/SHA2-256SUMS"
YTDLP_EXPECTED="$(grep ' yt-dlp.exe$' "$TMP_DIR/yt-dlp.SHA2-256SUMS" | awk '{print $1}')"
# Portable SHA-256: git-bash on Windows CI ships `sha256sum` (no `shasum`),
# macOS/dev ships `shasum` (no `sha256sum`) — use whichever exists.
if command -v sha256sum >/dev/null 2>&1; then
  YTDLP_ACTUAL="$(sha256sum "$BIN_DIR/yt-dlp.exe" | awk '{print $1}')"
else
  YTDLP_ACTUAL="$(shasum -a 256 "$BIN_DIR/yt-dlp.exe" | awk '{print $1}')"
fi
if [ -z "$YTDLP_EXPECTED" ] || [ "$YTDLP_EXPECTED" != "$YTDLP_ACTUAL" ]; then
  echo "ERROR: yt-dlp.exe checksum mismatch (expected='$YTDLP_EXPECTED' actual='$YTDLP_ACTUAL') — refusing to bundle." >&2
  exit 1
fi
echo "yt-dlp.exe checksum verified."

# whisper.cpp powers Auto-captions. The official prebuilt Windows x64 build
# ships whisper-cli.exe plus its whisper/ggml DLLs (including CPU-variant
# ggml-cpu-*.dll files it picks at runtime) — all copied next to the exe so
# Windows loads them from the same dir. The ~148MB model is fetched into
# models/ (shipped via package.json's build.win.extraResources).
echo "Fetching whisper-cli (Windows, auto-captions)..."
WHISPER_ZIP_URL="$(curl -sL https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest \
  | grep -oE 'https://[^"]*whisper-bin-x64\.zip' | head -1)"
curl -sL -o "$TMP_DIR/whisper-win.zip" "$WHISPER_ZIP_URL"
unzip -q "$TMP_DIR/whisper-win.zip" -d "$TMP_DIR/whisper"
cp "$TMP_DIR/whisper/Release/whisper-cli.exe" "$BIN_DIR/"
cp "$TMP_DIR/whisper/Release/whisper.dll" "$BIN_DIR/"
cp "$TMP_DIR"/whisper/Release/ggml*.dll "$BIN_DIR/"

echo "Fetching whisper model..."
bash "$ROOT/scripts/fetch-whisper-model.sh"

echo "Done. Binaries are in resources/bin-win/:"
file "$BIN_DIR/ffmpeg.exe" "$BIN_DIR/yt-dlp.exe" "$BIN_DIR/whisper-cli.exe"
