#!/usr/bin/env bash
# Builds whisper.cpp's whisper-cli from source and installs it to
# ~/.local/bin — for machines without Homebrew (with Homebrew,
# `brew install whisper-cpp` is simpler). Needs Xcode command line tools
# (clang); cmake is fetched as a portable binary if not installed, so no
# other build tooling is required. Run `npm run fetch-whisper-model` too
# if you haven't — auto-captions need both the binary and a model.
set -euo pipefail

WORK_DIR="$(mktemp -d /tmp/whisper-build.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
cd "$WORK_DIR"

CMAKE="$(command -v cmake || true)"
if [ -z "$CMAKE" ]; then
  echo "cmake not found — fetching a portable copy..."
  CMAKE_URL=$(curl -sL https://api.github.com/repos/Kitware/CMake/releases/latest \
    | grep -o 'https://[^"]*macos-universal\.tar\.gz' | head -1)
  curl -sL -o cmake.tar.gz "$CMAKE_URL"
  mkdir -p cmake
  tar -xzf cmake.tar.gz -C cmake --strip-components 1
  CMAKE="$WORK_DIR/cmake/CMake.app/Contents/bin/cmake"
fi
"$CMAKE" --version | head -1

echo "Cloning whisper.cpp..."
git clone --depth 1 https://github.com/ggml-org/whisper.cpp
cd whisper.cpp

echo "Building whisper-cli (a few minutes)..."
"$CMAKE" -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
"$CMAKE" --build build --config Release -j "$(sysctl -n hw.ncpu)" --target whisper-cli

mkdir -p "$HOME/.local/bin"
cp build/bin/whisper-cli "$HOME/.local/bin/whisper-cli"
chmod +x "$HOME/.local/bin/whisper-cli"
echo "Installed: $HOME/.local/bin/whisper-cli"
"$HOME/.local/bin/whisper-cli" --help >/dev/null 2>&1 && echo "whisper-cli OK"
