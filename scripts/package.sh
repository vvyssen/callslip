#!/bin/sh
# Builds dist/callslip-<version>.zip: the extension folder, zipped the way
# the Chrome Web Store (and a GitHub release) wants it.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
out="dist/callslip-$version.zip"
mkdir -p dist
rm -f "$out"
(cd extension && zip -qr "../$out" . -x '.*' -x '*/.*')
echo "$out"
