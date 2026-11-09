#!/usr/bin/env bash
# Retake the screenshots the metainfo points at: English, light, demo data, 1000x700 logical at 2x,
# plus the 360 px phone pass over the reworked pages (see below).
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
# The phone pass (`mobile-*.png`): every page the mobile rework (docs/app/mobile-layout.md) reshaped,
# at 360×760 — receipt inbox, transactions and invoices, the reports table, the small pages (time,
# deadlines, EÜR, settings, accounts) and the four dialogs (tx detail, invoice detail, link receipt,
# add account) through the STEUER_APP_* hooks screenshot.sh documents. The reviews views need their
# tab named (`review offen`), and the slow Konten view and its dialog get a longer settle.
#
# The German catalogue is compiled first and GJSIFY_LOCALE_DIR set explicitly: `gjsify run` sets
# none, and without it the app silently falls back to English.
set -euo pipefail
PASS="${STEUER_SHOT_PASS:-all}"

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
OUT="$(mkdir -p "${1:-$APP/../docs/screenshots}" && cd "${1:-$APP/../docs/screenshots}" && pwd)"
HEADLESS="${HEADLESS_RUN:-}"
# The headless runner is werkstatt's scripts/headless-run: it sits beside the werkstatt-carried
# checkout (…/werkstatt/projects/steuererklaerung) and beside a checkout of its own
# (…/steuererklaerung beside …/werkstatt). Neither is a fixed hop from here — the checked-out
# path depends on which worktree this runs in, and the two hard-coded guesses above silently
# missed in a .worktrees checkout, where the missing headless-run then failed as "missing <shot>".
# So walk up: the first ancestor that carries scripts/headless-run wins; HEADLESS_RUN overrides.
if [ -z "$HEADLESS" ] && TOP="$(git -C "$APP" rev-parse --show-toplevel 2>/dev/null)"; then
  d="$(dirname "$TOP")"
  while [ "$d" != "/" ]; do
    if [ -x "$d/scripts/headless-run" ]; then HEADLESS="$d/scripts/headless-run"; break
    elif [ -x "$d/werkstatt/scripts/headless-run" ]; then HEADLESS="$d/werkstatt/scripts/headless-run"; break
    fi
    d="$(dirname "$d")"
  done
fi
[ -x "$HEADLESS" ] || HEADLESS="$(command -v headless-run 2>/dev/null || true)"
[ -x "$HEADLESS" ] || { echo "headless-run not found (set HEADLESS_RUN)" >&2; exit 2; }
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

shot() { # <file> <view> <tab> [VAR=value …] — LOCALE defaults to English, the msgid language.
          # Additional VAR=value operands go onto the app's environment for THIS shot only (the
          # dialog hooks STEUER_APP_LINK_DIALOG & co.), never spill into the following ones.
  local file="$1" view="$2" tab="${3:-}" loc="${LOCALE:-en_US.UTF-8}"
  shift 2; [ $# -gt 0 ] && shift   # drop view and tab, keep the VAR=value list
  rm -f "$OUT/$file"
  local ran
  ran="$(env LANG="$loc" LANGUAGE="${loc%%_*}" LC_ALL="$loc" "$@" \
    "$HEADLESS" --scale 2 --size "${MONITOR:-2400x1800}" ${DARK:+--dark} --window-shot "$OUT/$file" \
    -- "$HERE/screenshot.sh" "$view" "$OUT/$file" ${tab:+"$tab"} 2>&1)" || true
  printf '%s\n' "$ran" | grep -E '^(wrote|window-matte)' || true
  # A rig that cannot say why is a rig that lies about its own result: when no file arrived, the
  # headless-run output is the only clue (wrong path, matte refused, app never came up).
  [ -s "$OUT/$file" ] || { echo "missing $file" >&2; printf '%s\n' "$ran" | tail -10 >&2; exit 1; }
}

views() { # <suffix> — the metainfo's six views in the order it lists them, then the two extra
          # figures the two front-page READMEs embed
    purge_demo
    shot "01-uebersicht$1.png" home ""
    shot "04-belege$1.png" review alle
    shot "05-buchungen$1.png" transactions ""
    shot "06-rechnungen$1.png" rechnungen ""
    shot "10-euer$1.png" steuer euer
    shot "09-steuererklaerung$1.png" steuer erklaerung
    shot "02-beleg-eingang$1.png" review eingang
    shot "08-auswertungen$1.png" auswertungen ""
}

if [ "$PASS" != mobile ]; then
    views ""
    LOCALE=de_DE.UTF-8 views -de
fi

# The phone pass: 360 logical wide, the <requires><display_length> the metainfo declares, so the
# store shows the app at its narrowest. Light goes into the metainfo (with a German twin like every
# other view); dark is for pages that follow the reader's colour scheme, so it has no twin.
mobile() { # <suffix> — the reworked pages at 360 px (mobile-layout step 12): the receipt inbox,
           # the reworked list pages, the reports table, the small step-8b pages with Accounts,
           # and the four dialogs — every dialog case the responsive check also guards, launched
           # through the same STEUER_APP_* hooks screenshot.sh documents.
    purge_demo
    shot "mobile-01-uebersicht$1.png" home ""
    shot "mobile-02-beleg-eingang$1.png" review eingang
    shot "mobile-03-buchungen$1.png" transactions ""
    shot "mobile-04-rechnungen$1.png" rechnungen ""
    shot "mobile-05-berichte$1.png" auswertungen ""
    shot "mobile-06-zeiten$1.png" zeiten ""
    shot "mobile-07-fristen$1.png" fristen ""
    shot "mobile-08-euer$1.png" steuer euer
    shot "mobile-09-einstellungen$1.png" settings ""
    shot "mobile-10-konten$1.png" konten "" STEUER_SHOT_SETTLE=20
    shot "mobile-11-buchung-detail$1.png" transactions "" STEUER_APP_TX_DETAIL=1 STEUER_SHOT_SETTLE=20
    shot "mobile-12-rechnung-detail$1.png" rechnungen "" STEUER_APP_YEAR=2025 STEUER_APP_INVOICE_DETAIL=RE-2025-0004
    shot "mobile-13-beleg-verknuepfen$1.png" review offen STEUER_APP_LINK_DIALOG=1
    shot "mobile-14-konto-hinzufuegen$1.png" konten "" STEUER_APP_ADD_ACCOUNT=choose STEUER_SHOT_SETTLE=20
}
if [ "$PASS" != desktop ]; then
    export STEUER_SHOT_SIZE="360 760" MONITOR=1000x1800
    mobile ""
    LOCALE=de_DE.UTF-8 mobile -de
    DARK=1 mobile -dark
fi

if command -v oxipng >/dev/null 2>&1; then oxipng -q -o 4 --strip safe "$OUT"/{01,02,04,05,06,08,09,10,mobile}-*.png; fi
