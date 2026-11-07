#!/usr/bin/env bash
set -euo pipefail

# Wrapper for `start:app` that compiles the GSettings schema and points XDG_DATA_DIRS at the local
# schema directory so Gio.Settings works without a system-wide install.

cd "$(dirname "$0")/.."

bash dev/compile-schemas.sh

export XDG_DATA_DIRS="${PWD}/data${XDG_DATA_DIRS:+:${XDG_DATA_DIRS}}"

exec gjsify run dist/app/steuer-app.gjs.mjs "$@"
