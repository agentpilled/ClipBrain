#!/usr/bin/env bash
#
# build-extension-zip.sh — package the Chrome extension for the Chrome Web Store.
#
# Produces store/dist/clipbrain-extension-v<version>.zip containing ONLY the files
# Chrome loads (manifest, service worker, content/inject scripts, popup, icons, lib).
# The local Bun server, MCP bridge, tooling, tests, docs, and node_modules are NOT
# part of the extension and are intentionally excluded.
#
# Usage:  bash store/build-extension-zip.sh
#
set -euo pipefail

# Resolve repo root as the parent of this script's directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# The exact set of files Chrome loads (verified against manifest.json + every
# chrome.scripting.executeScript call in service-worker.js and popup.js).
FILES=(
  manifest.json
  service-worker.js
  content-script.js
  kindle-content-script.js
  gmail-content-script.js
  toast.js
  popup.html
  popup.css
  popup.js
  lib/readability.js
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
)

# Read version straight from the manifest so the zip name always matches what
# Chrome will display and use for auto-update.
VERSION="$(grep '"version"' manifest.json | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
if [ -z "$VERSION" ]; then
  echo "ERROR: could not read version from manifest.json" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Copy the allowlist into a clean staging dir, preserving lib/ and icons/ layout.
# Fail loudly if any expected file is missing — a partial package would be
# rejected by Chrome or, worse, install broken.
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: missing extension file: $f" >&2
    exit 1
  fi
  mkdir -p "$STAGE/$(dirname "$f")"
  cp "$f" "$STAGE/$f"
done

OUT_DIR="$ROOT/store/dist"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/clipbrain-extension-v$VERSION.zip"
rm -f "$OUT"

# Zip from inside the staging dir so manifest.json sits at the zip root
# (Chrome requires the manifest at the top level of the package).
( cd "$STAGE" && zip -r -X "$OUT" . >/dev/null )

echo "✅ Built: $OUT"
echo ""
echo "Contents:"
unzip -l "$OUT" | awk 'NR>3 && $4!="" {print "  " $4}' | grep -v '^\s*$' || true
echo ""
echo "Version: $VERSION   Size: $(du -h "$OUT" | cut -f1)"
