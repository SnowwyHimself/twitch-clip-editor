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

# @resvg/resvg-js (the caption renderer) is a native module whose real code
# lives in a platform-specific package. When we build the Windows app on a
# Mac, npm only installed the macOS binding, so the Windows one is absent
# and the packaged app crashes on launch with "Cannot find module
# '@resvg/resvg-js-win32-x64-msvc'". Force-install the Windows x64 binding
# (matching the resvg-js version) so electron-builder can bundle it. --no-save
# keeps package.json clean; the mac build's `files` config excludes this
# package so it never leaks into the .dmg.
echo "Installing Windows resvg native binding (cross-platform build fix)..."
RESVG_VER="$(node -e "console.log(require('$ROOT/node_modules/@resvg/resvg-js/package.json').version)")"
( cd "$ROOT" && npm install "@resvg/resvg-js-win32-x64-msvc@$RESVG_VER" --os=win32 --cpu=x64 --no-save --force >/dev/null 2>&1 )
test -f "$ROOT/node_modules/@resvg/resvg-js-win32-x64-msvc/resvgjs.win32-x64-msvc.node" \
  && echo "  win32 resvg binding present ✓" || { echo "  ERROR: win32 resvg binding missing"; exit 1; }

FFMPEG_ZIP_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-7.1.zip"
FFMPEG_ZIP_ENTRY="ffmpeg-n7.1-latest-win64-gpl-7.1/bin/ffmpeg.exe"

echo "Fetching ffmpeg (win64)..."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -sL -o "$TMP_DIR/ffmpeg-win64.zip" "$FFMPEG_ZIP_URL"
unzip -q "$TMP_DIR/ffmpeg-win64.zip" "$FFMPEG_ZIP_ENTRY" -d "$TMP_DIR"
cp "$TMP_DIR/$FFMPEG_ZIP_ENTRY" "$BIN_DIR/ffmpeg.exe"

echo "Fetching yt-dlp (Windows)..."
curl -sL -o "$BIN_DIR/yt-dlp.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"

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
