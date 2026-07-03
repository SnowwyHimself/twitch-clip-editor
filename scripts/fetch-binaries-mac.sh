#!/usr/bin/env bash
# Downloads the ffmpeg + yt-dlp binaries that get bundled into the macOS
# desktop app build (see package.json's "build.mac.extraResources"). Not
# committed to the repo — kept out of git history since they're large and
# yt-dlp in particular needs frequent updates to keep working against site
# changes. macOS arm64 only — see fetch-binaries-win.sh for Windows.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/resources/bin-mac"
mkdir -p "$BIN_DIR"

echo "Fetching ffmpeg (arm64)..."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
(cd "$TMP_DIR" && npm init -y >/dev/null 2>&1 && npm install ffmpeg-static >/dev/null 2>&1)
cp "$TMP_DIR/node_modules/ffmpeg-static/ffmpeg" "$BIN_DIR/ffmpeg"
chmod +x "$BIN_DIR/ffmpeg"
xattr -d com.apple.quarantine "$BIN_DIR/ffmpeg" 2>/dev/null || true

echo "Fetching yt-dlp (macOS)..."
curl -sL -o "$BIN_DIR/yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
chmod +x "$BIN_DIR/yt-dlp"
xattr -d com.apple.quarantine "$BIN_DIR/yt-dlp" 2>/dev/null || true

echo "Done. Binaries are in resources/bin-mac/:"
"$BIN_DIR/ffmpeg" -version | head -1
"$BIN_DIR/yt-dlp" --version
