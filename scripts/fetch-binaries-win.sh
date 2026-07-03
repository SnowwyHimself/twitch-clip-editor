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

echo "Done. Binaries are in resources/bin-win/:"
file "$BIN_DIR/ffmpeg.exe" "$BIN_DIR/yt-dlp.exe"
