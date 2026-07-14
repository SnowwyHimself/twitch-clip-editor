#!/usr/bin/env bash
# Downloads the ffmpeg + yt-dlp binaries that get bundled into the macOS
# desktop app build (see package.json's "build.mac.extraResources"). Not
# committed to the repo — kept out of git history since they're large and
# yt-dlp in particular needs frequent updates to keep working against site
# changes. macOS arm64 only — see fetch-binaries-win.sh for Windows.
#
# Also compiles emoji-render, a tiny Swift/AppKit CLI (source lives in
# native/emoji-render-mac/, committed to the repo since it's our own code)
# that rasterizes real Apple Color Emoji glyphs — resvg (the SVG renderer
# captions otherwise use) can't render Apple's color emoji at all. End
# users never need Xcode; this compiles once here at build time.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/resources/bin-mac"
mkdir -p "$BIN_DIR"

# Make sure the caption renderer's macOS native binding is present (a prior
# Windows build can leave node_modules without it) so the .dmg isn't missing
# it. See ensure-resvg-binding.sh.
echo "Ensuring macOS resvg native binding..."
bash "$ROOT/scripts/ensure-resvg-binding.sh" resvg-js-darwin-arm64

echo "Fetching ffmpeg (arm64)..."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
(cd "$TMP_DIR" && npm init -y >/dev/null 2>&1 && npm install ffmpeg-static >/dev/null 2>&1)
cp "$TMP_DIR/node_modules/ffmpeg-static/ffmpeg" "$BIN_DIR/ffmpeg"
chmod +x "$BIN_DIR/ffmpeg"
xattr -d com.apple.quarantine "$BIN_DIR/ffmpeg" 2>/dev/null || true

# yt-dlp: pin a release for reproducible builds (YTDLP_VERSION=2025.xx.xx), or
# leave 'latest'. Either way the binary is verified against yt-dlp's OWN
# published SHA2-256SUMS from the SAME release before it's bundled — a corrupted
# or substituted download fails the build loudly instead of shipping.
YTDLP_VERSION="${YTDLP_VERSION:-latest}"
if [ "$YTDLP_VERSION" = "latest" ]; then
  YTDLP_BASE="https://github.com/yt-dlp/yt-dlp/releases/latest/download"
else
  YTDLP_BASE="https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION"
fi
echo "Fetching yt-dlp (macOS, $YTDLP_VERSION)..."
curl -fsSL -o "$BIN_DIR/yt-dlp" "$YTDLP_BASE/yt-dlp_macos"
curl -fsSL -o "$TMP_DIR/yt-dlp.SHA2-256SUMS" "$YTDLP_BASE/SHA2-256SUMS"
YTDLP_EXPECTED="$(grep ' yt-dlp_macos$' "$TMP_DIR/yt-dlp.SHA2-256SUMS" | awk '{print $1}')"
YTDLP_ACTUAL="$(shasum -a 256 "$BIN_DIR/yt-dlp" | awk '{print $1}')"
if [ -z "$YTDLP_EXPECTED" ] || [ "$YTDLP_EXPECTED" != "$YTDLP_ACTUAL" ]; then
  echo "ERROR: yt-dlp checksum mismatch (expected='$YTDLP_EXPECTED' actual='$YTDLP_ACTUAL') — refusing to bundle." >&2
  exit 1
fi
echo "yt-dlp checksum verified."
chmod +x "$BIN_DIR/yt-dlp"
xattr -d com.apple.quarantine "$BIN_DIR/yt-dlp" 2>/dev/null || true

echo "Compiling emoji-render (Apple Color Emoji rasterizer, mac only)..."
swiftc -O "$ROOT/native/emoji-render-mac/main.swift" -o "$BIN_DIR/emoji-render"
chmod +x "$BIN_DIR/emoji-render"
xattr -d com.apple.quarantine "$BIN_DIR/emoji-render" 2>/dev/null || true

# whisper.cpp powers Auto-captions. It's built from source (statically
# linked, so the single binary is self-contained) and bundled alongside
# ffmpeg/yt-dlp, and the ~148MB model is fetched into models/ (shipped via
# package.json's build.mac.extraResources) — so the packaged app does
# auto-captions with nothing extra to install.
echo "Building + bundling whisper-cli (auto-captions)..."
if [ ! -x "$HOME/.local/bin/whisper-cli" ]; then
  bash "$ROOT/scripts/build-whisper-mac.sh"
fi
cp "$HOME/.local/bin/whisper-cli" "$BIN_DIR/whisper-cli"
chmod +x "$BIN_DIR/whisper-cli"
xattr -d com.apple.quarantine "$BIN_DIR/whisper-cli" 2>/dev/null || true

echo "Fetching whisper model..."
bash "$ROOT/scripts/fetch-whisper-model.sh"

echo "Done. Binaries are in resources/bin-mac/:"
"$BIN_DIR/ffmpeg" -version | head -1
"$BIN_DIR/yt-dlp" --version
"$BIN_DIR/emoji-render" "🔥" /tmp/emoji-render-smoketest.png 64 && echo "emoji-render OK" && rm -f /tmp/emoji-render-smoketest.png
"$BIN_DIR/whisper-cli" --help >/dev/null 2>&1 && echo "whisper-cli OK"
