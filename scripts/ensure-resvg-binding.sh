#!/usr/bin/env bash
# Ensures a platform-specific @resvg/resvg-js native binding is present in
# node_modules for a cross-platform build.
#
# @resvg/resvg-js is a native module whose real code lives in per-platform
# packages (…-darwin-arm64, …-win32-x64-msvc, …). npm only installs the one
# matching the machine you build on, so building the *other* platform's app
# omits its binding and the packaged app crashes on launch with "Cannot find
# module '@resvg/resvg-js-<triple>'".
#
# We deliberately DON'T use `npm install …-win32-x64-msvc --os=win32 --cpu=x64`
# to add the missing one: that makes npm reconcile the whole tree for that
# fake platform and PRUNE the current machine's binding (which silently broke
# the macOS build). `npm pack` just downloads the tarball — it never touches
# anything else — so the mac and win bindings can coexist, and each build's
# electron-builder `files` config excludes the one it doesn't want.
#
# Usage: ensure-resvg-binding.sh resvg-js-win32-x64-msvc
set -euo pipefail

PKG="${1:?usage: ensure-resvg-binding.sh <resvg platform package name>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/node_modules/@resvg/$PKG"

if ls "$DEST"/*.node >/dev/null 2>&1; then
  echo "  @resvg/$PKG already present ✓"
  exit 0
fi

VER="$(node -e "console.log(require('$ROOT/node_modules/@resvg/resvg-js/package.json').version)")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "  fetching @resvg/$PKG@$VER (npm pack)…"
( cd "$TMP" && npm pack "@resvg/$PKG@$VER" >/dev/null 2>&1 )
mkdir -p "$DEST"
tar xzf "$TMP"/*.tgz -C "$DEST" --strip-components 1

ls "$DEST"/*.node >/dev/null 2>&1 && echo "  @resvg/$PKG installed ✓" || {
  echo "  ERROR: @resvg/$PKG has no .node binding"
  exit 1
}
