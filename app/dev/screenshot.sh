#!/usr/bin/env bash
# Screenshot a Steuererklärung view without a human in the loop.
#
#   app/dev/screenshot.sh <view> <out.png> [tab]
#     view : home | review | transactions | rechnungen | zeiten | kontakte |
#            auswertungen | steuer | projekte | konten | settings
#     out  : output PNG path
#     tab  : hub tab — eingang|offen|alle, or erklaerung|assistent|euer|anlagen|ustva|steuerkonto
#
#   STEUER_APP_FIRSTRUN=1   run against an EMPTY config dir, i.e. the first-run assistant
#   STEUER_APP_SETUP_PAGE=  entity|dms|finish — open the assistant on that page
#   STEUER_APP_ADD_ACCOUNT= choose|file|qonto|fints — open the Konto-hinzufügen dialog there
#   STEUER_APP_EDIT_DOC=1   open the Beleg-Metadaten editor on the first document
#   STEUER_APP_LINK_DIALOG=1 open the Beleg-verknüpfen picker on the first gap booking
#   STEUER_APP_INVOICE_DETAIL=RE-2025-0004  open that invoice's detail dialog (view rechnungen); the demo
#                           has a full duplicate on RE-2025-0004 and a partial overpayment on RE-2026-0003
#   STEUER_APP_TX_DETAIL=1  open the Buchungs-Detail sheet on the first classified booking
#   STEUER_APP_MAIL_DIALOG=1 open the invoice mail dialog on the first issued invoice (view rechnungen)
#   STEUER_SHOT_SIZE="W H"  window size before capture (default 1280 860)
#   STEUER_SHOT_SETTLE=s    seconds to wait after resize before capturing (default 2.5)
#   STEUER_APP_SEARCH=text  prefill the Buchungen search box (reaches the "nothing found" state)
#   STEUER_APP_STEP=id      open a Steuererklärung step, e.g. zusammenfassung (the Absenden chain)
#   STEUER_APP_SCROLL=      scroll the Einstellungen page: "end" or a fraction 0..1; "vor-abgabe" in the Abgabe step
#   STEUER_APP_ENTITY=id    entity to open
#   STEUER_APP_YEAR=YYYY    year to open
#   STEUER_SHOT_ACTION=     activate a GAction before capturing, e.g. "win goto-konten" (scope and
#                           name, space-separated) — proves a
#                           keyboard shortcut's action exists and does something (the accel itself
#                           needs a real key press, which no headless transport can send)
#   STEUER_SHOT_ACTIVATE=   activate a widget before capturing, e.g. "GtkButton:suggested-action"
#                           (type[:css-class]); the capture FAILS if no such widget exists or the
#                           activation does not take
#
# The procedure was written down in docs/app/README.md and never committed as a script, so every
# screenshot was hand-assembled from a code block — which is why the two traps below kept being
# rediscovered. Now it runs.
#
# How it works: the app exports @gjsify/devtools' D-Bus control plane under GJSIFY_DEVTOOLS=1, whose
# Screenshot method renders the window in-process through the GSK renderer — no compositor portal,
# headless-capable. Same mechanism bauplaner uses.
#
# KNOWN LIMIT, measured: it captures the WINDOW's own surface. A GTK popover (the entity switcher's
# list, a MenuButton menu, a tooltip) is a separate surface and does NOT appear — the capture
# succeeds and simply shows the window without it, which is easy to mistake for "the popover never
# opened". Anything that must be seen in a screenshot has to live in a dialog or inline.
set -euo pipefail

VIEW="${1:?usage: screenshot.sh <view> <out.png> [tab]}"
OUT="${2:?usage: screenshot.sh <view> <out.png> [tab]}"
TAB="${3:-}"

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
# The WORKSPACE gjsify, never whatever is on PATH: a global CLI of a different version does not fail
# loudly, it runs the wrong bundler/loader against these pins and quietly does nothing useful.
GJSIFY="$APP/../node_modules/.bin/gjsify"
[ -x "$GJSIFY" ] || GJSIFY="$(command -v gjsify)"

# A UNIQUE app-id per invocation. GNOME dedups instances by D-Bus app-id, so a fresh id always
# spawns a fresh window and an orphaned prior shot can never be re-activated in its place (which
# would silently screenshot the wrong view). Distinct from the real app, so it never hijacks a
# Steuererklärung you have open.
APP_ID="${STEUER_SHOT_APP_ID:-eu.jumplink.Steuererklaerung.Shot$$}"
OBJ="/$(printf '%s' "$APP_ID" | tr . /)/devtools"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" DISPLAY="${DISPLAY:-:0}"

# `env` accepts OPTIONS only before the VAR=value operands, so the -u flags are collected
# separately. Mixing them in produced `env: '-u': No such file or directory` — env had already
# switched to operand mode and read the flag as a program name.
# The forwarding below is explicitness, not necessity: `env` without `-i` inherits this shell's
# environment, so an exported STEUER_APP_* already reaches the app. Listing them keeps the set
# discoverable and survives a future `env -i` — but it also means a MISSING line here fails
# silently, which is how two of them went unnoticed for a while.
UNSET_ARGS=()
ENV_ARGS=(GJSIFY_DEVTOOLS=1 "STEUER_APP_ID=$APP_ID" "STEUER_APP_VIEW=$VIEW")
[ -n "$TAB" ] && ENV_ARGS+=("STEUER_APP_TAB=$TAB")
[ -n "${STEUER_APP_SETUP_PAGE:-}" ] && ENV_ARGS+=("STEUER_APP_SETUP_PAGE=$STEUER_APP_SETUP_PAGE")
[ -n "${STEUER_APP_ADD_ACCOUNT:-}" ] && ENV_ARGS+=("STEUER_APP_ADD_ACCOUNT=$STEUER_APP_ADD_ACCOUNT")
[ -n "${STEUER_APP_EDIT_DOC:-}" ] && ENV_ARGS+=("STEUER_APP_EDIT_DOC=$STEUER_APP_EDIT_DOC")
[ -n "${STEUER_APP_LINK_DIALOG:-}" ] && ENV_ARGS+=("STEUER_APP_LINK_DIALOG=$STEUER_APP_LINK_DIALOG")
[ -n "${STEUER_APP_TX_DETAIL:-}" ] && ENV_ARGS+=("STEUER_APP_TX_DETAIL=$STEUER_APP_TX_DETAIL")
[ -n "${STEUER_APP_INVOICE_DETAIL:-}" ] && ENV_ARGS+=("STEUER_APP_INVOICE_DETAIL=$STEUER_APP_INVOICE_DETAIL")
[ -n "${STEUER_APP_MAIL_DIALOG:-}" ] && ENV_ARGS+=("STEUER_APP_MAIL_DIALOG=$STEUER_APP_MAIL_DIALOG")
[ -n "${STEUER_APP_SEARCH:-}" ] && ENV_ARGS+=("STEUER_APP_SEARCH=$STEUER_APP_SEARCH")
[ -n "${STEUER_APP_STEP:-}" ] && ENV_ARGS+=("STEUER_APP_STEP=$STEUER_APP_STEP")
ENV_ARGS+=("STEUER_APP_SIZE=${STEUER_SHOT_SIZE:-1280 860}")
[ -n "${STEUER_APP_SCROLL:-}" ] && ENV_ARGS+=("STEUER_APP_SCROLL=$STEUER_APP_SCROLL")

TMPHOME=""
if [ "${STEUER_APP_FIRSTRUN:-}" = "1" ]; then
  # First run means "no configuration anywhere". Clearing XDG alone is NOT enough: `gjsify run`
  # needs a package.json in cwd, so the app always starts in app/ — where a real manifest sits, and
  # the cwd branch of the lookup wins over XDG. Measured: the first attempt at this silently
  # screenshotted the fully configured app.
  #
  # So point STEUER_WORKSPACE at a path inside a throwaway dir that does not exist. The override
  # wins over everything, isFirstRun() is true, and a completed assistant writes THERE — the real
  # steuererklaerung.json / buchhaltung.json cannot be reached at all.
  TMPHOME="$(mktemp -d)"
  mkdir -p "$TMPHOME/cfg" "$TMPHOME/data"
  ENV_ARGS+=(
    "STEUER_WORKSPACE=$TMPHOME/cfg/steuererklaerung.json"
    "TRANSACTIONS_DATA_DIR=$TMPHOME/data"
    "XDG_CONFIG_HOME=$TMPHOME/cfg"
    "XDG_DATA_HOME=$TMPHOME/data"
  )
  UNSET_ARGS+=(-u BUCHHALTUNG_WORKSPACE -u STEUER_DEMO)
else
  ENV_ARGS+=(STEUER_DEMO=1)
fi

# setsid puts the app in its own session/process group so the trap reaps the whole tree
# (subshell → gjsify → gjs); killing the bare subshell PID orphans the gjs child, which then lingers
# and blocks future single-instance runs. `pkill -f steuer-app` is NOT the way — it matches this
# script's own command line too.
setsid env "${UNSET_ARGS[@]}" "${ENV_ARGS[@]}" bash -c "cd \"$APP\" && exec \"$GJSIFY\" run start:app" >/tmp/steuer-shot.log 2>&1 &
APP_PID=$!
cleanup() {
  kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true
  [ -n "$TMPHOME" ] && rm -rf "$TMPHOME"
  # An EXIT trap's last command decides the script's exit status. Without this, the `[ -n "$TMPHOME" ]`
  # test above returned 1 whenever TMPHOME was empty (every non-first-run capture) and a screenshot
  # that had just been written successfully reported failure — a rig that lies about its own result.
  return 0
}
trap cleanup EXIT

# Poll GetStatus — never a fixed sleep. Startup time depends on what the view fetches.
for _ in $(seq 1 60); do
  if gdbus call --session --dest "$APP_ID" --object-path "$OBJ" \
       --method org.gjsify.Devtools.GetStatus >/dev/null 2>&1; then break; fi
  sleep 0.5
done

# Size FIRST: the assistant panel docks itself as soon as the window passes the 1180 px breakpoint,
# so resizing after a capture would produce a different picture than the one just taken.
#
# Retried, because GetStatus answering does NOT mean the window is mapped: a slow start (demo
# seeding) let the resize land on nothing, `|| true` swallowed it, and the shot came out at the
# default size — the difference is easy to miss when you are looking at the content.
# The size is set BEFORE the window maps (STEUER_APP_SIZE, forwarded above), so there is nothing to
# retry here. Resizing afterwards was never reliable: `set_default_size` on a mapped window is a
# request the compositor may ignore, and `default-width` then reads back what was ASKED FOR — which
# is how a "verified" resize still produced 1100×760 pictures.

# Let the GSK renderer lay out a few frames — and, more importantly, let the view's own data
# arrive. GetStatus answers as soon as the control plane is up, which is long before a view that
# fetches from Paperless (~10 s) has anything to draw; capturing then yields a spinner, and a
# spinner screenshot looks like a broken view rather than an early one.
sleep "${STEUER_SHOT_SETTLE:-2.5}"

# Optional: press something first.
#
# A screenshot proves a button was DRAWN, never that it does anything — and a Gtk.Button whose
# activate_action names an action its widget tree cannot resolve fails in total silence. That exact
# class already cost this app its "Buchungen öffnen" button (see nav.ts). So: find the widget, tell
# the app to activate it, and refuse to produce a picture if either step fails. A rig that cannot
# report failure is a rig that lies.
if [ -n "${STEUER_SHOT_ACTION:-}" ]; then
  # ActivateAction takes THREE strings — scope, name, JSON parameter — so STEUER_SHOT_ACTION is
  # written unquoted as `win goto-konten` and splits into the first two. '""' is "no parameter".
  # An unknown action FAILS here, which is the whole point: a shortcut wired to an action nobody
  # registered would otherwise look exactly like a working one.
  if ! gdbus call --session --dest "$APP_ID" --object-path "$OBJ" \
       --method org.gjsify.Devtools.ActivateAction ${STEUER_SHOT_ACTION} '""' >/dev/null; then
    echo "ActivateAction $STEUER_SHOT_ACTION failed" >&2; exit 1
  fi
  echo "activated action $STEUER_SHOT_ACTION" >&2
  sleep "${STEUER_SHOT_SETTLE:-2.5}"
fi

if [ -n "${STEUER_SHOT_ACTIVATE:-}" ]; then
  WPATH="$(gjs -m "$HERE/dbus-find.js" "$APP_ID" "$OBJ" "$STEUER_SHOT_ACTIVATE")" || {
    echo "no widget matches $STEUER_SHOT_ACTIVATE" >&2; exit 1;
  }
  echo "activating $STEUER_SHOT_ACTIVATE at $WPATH" >&2
  RESULT="$(gdbus call --session --dest "$APP_ID" --object-path "$OBJ" \
    --method org.gjsify.Devtools.ActivateWidget "$WPATH")"
  case "$RESULT" in
    *true*) : ;;
    *) echo "ActivateWidget refused $WPATH: $RESULT" >&2; exit 1 ;;
  esac
  # Whatever the activation triggers (navigation, a dialog, a reload) needs its own settle.
  sleep "${STEUER_SHOT_SETTLE:-2.5}"
fi

SHOT="$(gjs -m "$HERE/dbus-shot.js" "$APP_ID" "$OBJ" "$OUT")" || exit 1
echo "$SHOT"
# Hold the picture to the size that was asked for — read from the PNG itself, the one number about
# a screenshot that cannot be faked. A capture at the wrong size looks like a layout bug in the app.
WANT_W="${STEUER_SHOT_SIZE:-1280 860}"; WANT_W="${WANT_W%% *}"
case "$SHOT" in
  *"${WANT_W}×"*) : ;;
  *) echo "warning: captured at a different width than the requested ${WANT_W} px" >&2 ;;
esac
