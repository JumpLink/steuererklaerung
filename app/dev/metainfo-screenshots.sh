#!/usr/bin/env bash
# Retake the six screenshots the metainfo points at, at true 2x (2560x1720), German, light, demo data.
#
#   app/dev/metainfo-screenshots.sh [outdir]     default outdir: ../docs/screenshots
#
# Flathub wants the metainfo screenshots at the window's default size, never upscaled, so every
# shot runs through `headless-run --scale 2` and screenshot.sh's screencast path. The German
# catalogue is compiled first and GJSIFY_LOCALE_DIR set explicitly: `gjsify run` sets none, and
# without it the app silently falls back to English.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
OUT="$(mkdir -p "${1:-$APP/../docs/screenshots}" && cd "${1:-$APP/../docs/screenshots}" && pwd)"
HEADLESS="${HEADLESS_RUN:-$HERE/../../../werkstatt/scripts/headless-run}"
command -v headless-run >/dev/null 2>&1 && HEADLESS=headless-run

(cd "$APP" && ./dev/i18n.sh compile >/dev/null && gjsify run build:app >/dev/null)

export GJSIFY_LOCALE_DIR="$APP/dist/locale" LANG=de_DE.UTF-8 LANGUAGE=de LC_ALL=de_DE.UTF-8
PORT_FILE="$(mktemp)"
python3 "$HERE/paperless-stub.py" >"$PORT_FILE" &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null; rm -f "$PORT_FILE"' EXIT
for _ in $(seq 1 20); do [ -s "$PORT_FILE" ] && break; sleep 0.2; done
export PAPERLESS_BASE_URL="http://127.0.0.1:$(cat "$PORT_FILE")" PAPERLESS_API_TOKEN=demo
export STEUER_APP_YEAR=2025 STEUER_SHOT_SETTLE=6 STEUER_SHOT_SCREENCAST=1

shot() { # <file> <view> [tab] — WIDTH (logical px) defaults to the 1280 window
  local w="${WIDTH:-1280}"
  STEUER_SHOT_SIZE="$w 860" "$HEADLESS" --scale 2 --size "$((w * 2))x1720" -- "$HERE/screenshot.sh" "$2" "$OUT/$1" ${3:+"$3"} 2>&1 | grep -E '^wrote' || true
  [ -s "$OUT/$1" ] || { echo "missing $1" >&2; exit 1; }
}

shot 01-uebersicht.png home
shot 04-belege.png review alle
shot 05-buchungen.png transactions
shot 06-rechnungen.png rechnungen
shot 10-euer.png steuer euer
# The stepper plus the open assistant panel need ~1350 px; at 1280 the window overflows the output
# and the right edge (close button, panel) is cut off.
WIDTH=1440 shot 09-steuererklaerung.png steuer erklaerung

if command -v oxipng >/dev/null 2>&1; then oxipng -q -o 4 --strip safe "$OUT"/{01,04,05,06,09,10}-*.png; fi
