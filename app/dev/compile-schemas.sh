#!/usr/bin/env bash
set -euo pipefail

# Compile the GSettings schema for local GJS runs. The source XML lives in app/data/; the compiled
# file is written to app/data/glib-2.0/schemas/ so that adding app/data to XDG_DATA_DIRS is enough
# for Gio.Settings to find it without a system-wide install.

cd "$(dirname "$0")/.."

mkdir -p data/glib-2.0/schemas
glib-compile-schemas --targetdir=data/glib-2.0/schemas --strict data
