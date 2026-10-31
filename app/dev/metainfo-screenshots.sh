#!/usr/bin/env bash
# Retake the screenshots the metainfo points at: English, light, demo data, 1000x700 logical at 2x.
#
#   app/dev/metainfo-screenshots.sh [outdir]     default outdir: ../docs/screenshots
#   STEUER_SHOT_PASS=desktop|mobile              take only that pass (default: both)
#
# Flathub's quality guidelines want the app's DEFAULT size, never upscaled, English first, and the
# plain window with its shadow and rounded corners — nothing else in the frame. So every shot runs
# under `headless-run --scale 2 --window-shot`, which mattes the window off a backdrop and keeps
# the alpha; screenshot.sh only sets the stage (STEUER_SHOT_HOLD=1) and holds it.
#
# The monitor is deliberately LARGER than the window (2400x1800 for a 2000x1400 window): a window
# the exact size of the monitor has no backdrop around it, and the matte then refuses with
# "the window fills the whole monitor".
#
# Every view is taken twice: `<name>.png` in English for the metainfo's <image> and for README.md,
# `<name>-de.png` for the German manual in docs/app/README.md. That is the rule for
# every view this script takes; a figure of the German manual that was never taken in English keeps
# its plain name and stays German. The metainfo takes both: the English shot as <image>, the German twin as
# <image xml:lang="de"> through `localizedUrls` of each screenshot in `gjsify.ship` (package.json),
# so a new twin needs that entry too. Views without a twin stay English-only.
# The German catalogue is compiled first and GJSIFY_LOCALE_DIR set explicitly: `gjsify run` sets
# none, and without it the app silently falls back to English.
set -euo pipefail
PASS="${STEUER_SHOT_PASS:-all}"

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
OUT="$(mkdir -p "${1:-$APP/../docs/screenshots}" && cd "${1:-$APP/../docs/screenshots}" && pwd)"
HEADLESS="${HEADLESS_RUN:-$HERE/../../../werkstatt/scripts/headless-run}"
# A checkout beside werkstatt, or the one werkstatt carries as projects/steuererklaerung.
[ -x "$HEADLESS" ] || [ -n "${HEADLESS_RUN:-}" ] || HEADLESS="$HERE/../../../../scripts/headless-run"
command -v headless-run >/dev/null 2>&1 && HEADLESS=headless-run
# The checkout's own CLI, like welcome-e2e.sh: a globally installed one can be a different version.
GJSIFY="$APP/../node_modules/.bin/gjsify"
[ -x "$GJSIFY" ] || GJSIFY="$(command -v gjsify)"

(cd "$APP" && ./dev/i18n.sh compile >/dev/null && "$GJSIFY" run build:app >/dev/null)

export GJSIFY_LOCALE_DIR="$APP/dist/locale"
PORT_FILE="$(mktemp)"
python3 "$HERE/paperless-stub.py" >"$PORT_FILE" &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null; rm -f "$PORT_FILE"' EXIT
for _ in $(seq 1 20); do [ -s "$PORT_FILE" ] && break; sleep 0.2; done
export PAPERLESS_BASE_URL="http://127.0.0.1:$(cat "$PORT_FILE")" PAPERLESS_API_TOKEN=demo
export STEUER_APP_YEAR=2025 STEUER_SHOT_SETTLE=6 STEUER_SHOT_HOLD=1 STEUER_SHOT_SIZE="1000 700"

purge_demo() { # The ledger, the cursors and the built-in DMS PDFs are derived (demo/.gitignore) and
               # are rebuilt on the next demo start. They also STORE translated text — the §14
               # classification reason goes into the DMS as "<kind>|<reason>" — so a store seeded in
               # one language shows that language in the other one's screenshots. Hence per pass.
    rm -rf "$APP/demo/transactions-data/documents" "$APP/demo/transactions-data/cursors.json"
    rm -f "$APP"/demo/ledger.db*
}

shot() { # <file> <view> [tab] — LOCALE defaults to English, the msgid language
  rm -f "$OUT/$1"
  local loc="${LOCALE:-en_US.UTF-8}"
  env LANG="$loc" LANGUAGE="${loc%%_*}" LC_ALL="$loc" \
    "$HEADLESS" --scale 2 --size "${MONITOR:-2400x1800}" ${DARK:+--dark} --window-shot "$OUT/$1" \
    -- "$HERE/screenshot.sh" "$2" "$OUT/$1" ${3:+"$3"} 2>&1 | grep -E '^(wrote|window-matte)' || true
  [ -s "$OUT/$1" ] || { echo "missing $1" >&2; exit 1; }
}

views() { # <suffix> — the metainfo's six views in the order it lists them, then the two extra
          # figures the two front-page READMEs embed
    purge_demo
    shot "01-uebersicht$1.png" home
    shot "04-belege$1.png" review alle
    shot "05-buchungen$1.png" transactions
    shot "06-rechnungen$1.png" rechnungen
    shot "10-euer$1.png" steuer euer
    shot "09-steuererklaerung$1.png" steuer erklaerung
    shot "02-beleg-eingang$1.png" review eingang
    shot "08-auswertungen$1.png" auswertungen
}

if [ "$PASS" != mobile ]; then
    views ""
    LOCALE=de_DE.UTF-8 views -de
fi

# The phone pass: 360 logical wide, the <requires><display_length> the metainfo declares, so the
# store shows the app at its narrowest. Light goes into the metainfo (with a German twin like every
# other view); dark is for pages that follow the reader's colour scheme, so it has no twin.
mobile() { # <suffix>
    purge_demo
    shot "mobile-01-uebersicht$1.png" home
}
if [ "$PASS" != desktop ]; then
    export STEUER_SHOT_SIZE="360 760" MONITOR=1000x1800
    mobile ""
    LOCALE=de_DE.UTF-8 mobile -de
    DARK=1 mobile -dark
fi

if command -v oxipng >/dev/null 2>&1; then oxipng -q -o 4 --strip safe "$OUT"/{01,02,04,05,06,08,09,10,mobile}-*.png; fi
