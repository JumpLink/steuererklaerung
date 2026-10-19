#!/bin/sh
# with-koffi.sh <win32|darwin> <x64|arm64> <command...>
# Run the command with koffi added to the ship payload (ship-koffi.ts patches package.json), then
# put package.json back so the next target starts clean.
set -eu
cd "$(dirname "$0")/.."
os="$1"; arch="$2"; shift 2
cp package.json /tmp/package.json.koffi-orig
trap 'cp /tmp/package.json.koffi-orig package.json' EXIT
node dev/ship-koffi.ts "$os" "$arch"
"$@"
