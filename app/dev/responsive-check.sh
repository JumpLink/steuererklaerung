#!/usr/bin/env bash
# Responsive guard: opens every sidebar page, the hub tabs and the main dialogs on the demo data at
# four window sizes and FAILS when the layout breaks at any of them.
#
#   app/dev/responsive-check.sh [case …]     case = view[/tab] or view@ENVVAR[=value] (default: all)
#
#   RESPONSIVE_SIZES="360x760 1280x860"   override the sizes
#   RESPONSIVE_OUT=dir                    where the per-case screenshots go (default app/dist/responsive)
#   RESPONSIVE_SETTLE=s                   seconds to wait after a navigation (default 3)
#   HEADLESS_RUN=path                     run inside werkstatt's headless-run (a private mutter);
#                                         without it the script expects a display and a session bus
#                                         already, as in CI (mutter --headless in dbus-run-session)
#
# Sizes: 360×760 is a phone; 481×800 is one pixel above the 480 px phone breakpoint, where the desktop
# layout must still hold; 768×1024 a tablet; 1280×860 the default desktop window.
#
# Per case, per size:
#   · no libadwaita "exceeds … width" warning in the app log — the window's minimum width is the
#     maximum over all stack pages, so one rigid widget anywhere makes the whole app wider than a phone
#   · the window really has that width (allocation and screenshot — `ResizeWindow` only echoes the ask)
#   · no mapped widget allocated less than its minimum (devtools `geometry.short`), dump not truncated;
#     the allowlist app/dev/responsive.allow.json takes an entry only with a one-line justification
#   · ≤ 480 px: row-action buttons and the overflow button are at least TOUCH_TARGET (48) square;
#     ≥ 481 px: no overflow button. At 360 px at least one row action must have been SEEN, so the
#     touch-target check cannot pass by looking at nothing.
#
# Views are switched inside ONE app instance per size with `win.navigate`; dialog cases need their own
# launch (an env var opens them at startup). Demo data only (STEUER_DEMO=1) and throw-away XDG dirs —
# no real manifest, no fints-data, no transactions-data.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"

SIZES="${RESPONSIVE_SIZES:-360x760 481x800 768x1024 1280x860}"
SETTLE="${RESPONSIVE_SETTLE:-3}"
OUT="${RESPONSIVE_OUT:-$APP/dist/responsive}"
ALLOW="$HERE/responsive.allow.json"

# The case list of the former mobile-width-check.sh, unchanged: `view[/tab]` navigates inside the
# running instance, `view@ENV` launches with the env var that opens that dialog.
NAV_CASES=(home review review/offen review/alle transactions rechnungen zeiten kontakte
  auswertungen fristen steuer steuer/euer steuer/anlagen steuer/ustva steuer/steuerkonto projekte vertraege konten settings)
DIALOG_CASES=(transactions@STEUER_APP_TX_DETAIL rechnungen@STEUER_APP_INVOICE_DETAIL=RE-2025-0004
  review@STEUER_APP_EDIT_DOC review@STEUER_APP_LINK_DIALOG settings@STEUER_APP_ADD_ACCOUNT=choose)

INNER=""; if [ "${1:-}" = "--inner" ]; then INNER=1; shift; fi

if [ $# -gt 0 ]; then
  NAV_CASES=(); DIALOG_CASES=()
  for c in "$@"; do if [[ "$c" == *@* ]]; then DIALOG_CASES+=("$c"); else NAV_CASES+=("${c/:/\/}"); fi; done
fi

# Re-exec inside the private compositor. `--inner` marks the second pass.
if [ -z "$INNER" ] && [ -n "${HEADLESS_RUN:-}" ]; then
  exec "$HEADLESS_RUN" --size 1400x1100 -- env RESPONSIVE_SIZES="$SIZES" RESPONSIVE_OUT="$OUT" RESPONSIVE_SETTLE="$SETTLE" \
    bash "$0" --inner "$@"
fi
if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  echo "no display/session bus: set HEADLESS_RUN=…/headless-run, or run inside a Wayland compositor with a session bus (CI: mutter --headless, see ci.yml)" >&2
  exit 2
fi

GJSIFY="$APP/node_modules/.bin/gjsify"
[ -x "$GJSIFY" ] || GJSIFY="$APP/../node_modules/.bin/gjsify"
[ -x "$GJSIFY" ] || GJSIFY="$(command -v gjsify)"
[ -s "$APP/dist/app/steuer-app.gjs.mjs" ] || { echo "build first: npm run build:app" >&2; exit 2; }

mkdir -p "$OUT"
TMP="$(mktemp -d)"
fail=0
row_actions_at_phone=0
APP_PID=""

stop_app() {
  [ -n "$APP_PID" ] && { kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; }
  APP_PID=""
  return 0
}
trap 'stop_app; rm -rf "$TMP"' EXIT

# Some views block the main loop for a long time while they load (Konten: ~50 s on one workstation).
# Wait for the control plane instead of timing out inside a call, and say so.
wait_responsive() {
  local what="$1" t0=$SECONDS
  until gdbus call --session --timeout 3 --dest "$APP_ID" --object-path "$OBJ" --method org.gjsify.Devtools.GetStatus >/dev/null 2>&1; do
    [ $((SECONDS - t0)) -lt 150 ] || break
  done
  [ $((SECONDS - t0)) -lt 10 ] || echo "note $what: the UI was unresponsive for $((SECONDS - t0)) s"
}

# start_app <WxH> <view> <logfile> [ENV=value …]
start_app() {
  local size="$1" view="$2" log="$3"; shift 3
  APP_ID="eu.jumplink.Steuererklaerung.Resp$$x${RANDOM}"
  OBJ="/$(printf '%s' "$APP_ID" | tr . /)/devtools"
  mkdir -p "$TMP/xdg/data" "$TMP/xdg/config" "$TMP/xdg/cache"
  # The app rewrites demo data while it runs; a copy keeps the tracked app/demo untouched.
  rm -rf "$TMP/demo" && cp -r "$APP/demo" "$TMP/demo"
  # setsid: the trap can reap the whole tree (subshell → gjsify → gjs), see screenshot.sh.
  setsid env -u BUCHHALTUNG_WORKSPACE -u STEUER_WORKSPACE \
    GJSIFY_DEVTOOLS=1 STEUER_DEMO=1 "STEUER_DEMO_DIR=$TMP/demo" "STEUER_APP_ID=$APP_ID" "STEUER_APP_VIEW=$view" \
    "STEUER_APP_SIZE=${size%x*} ${size#*x}" \
    "XDG_DATA_HOME=$TMP/xdg/data" "XDG_CONFIG_HOME=$TMP/xdg/config" "XDG_CACHE_HOME=$TMP/xdg/cache" \
    "$@" bash -c "cd \"$APP\" && exec \"$GJSIFY\" run start:app" >"$log" 2>&1 &
  APP_PID=$!
  local up=""
  for _ in $(seq 1 120); do
    if gdbus call --session --dest "$APP_ID" --object-path "$OBJ" --method org.gjsify.Devtools.GetStatus >/dev/null 2>&1; then up=1; break; fi
    sleep 0.5
  done
  [ -n "$up" ] || return 1
  sleep "$SETTLE"
}

# judge <WxH> <case> <logfile> <log-offset>
judge() {
  local size="$1" name="$2" log="$3" off="$4" tag
  wait_responsive "$size $name"
  tag="${size}-$(printf '%s' "$name" | tr '/@=:' '____')"
  local w="${size%x*}" h="${size#*x}" ok=1 lines
  local warns
  warns="$(tail -c +"$((off + 1))" "$log" | grep -E 'exceeds .* width' | sed -E 's/^.*Adwaita-WARNING \*\*: [0-9:.]+: //' | sort -u)"
  lines="$(gjs -m "$HERE/responsive-probe.js" "$APP_ID" "$OBJ" "$w" "$h" "$name" "$OUT/$tag.png" "$ALLOW" 2>&1)" || ok=""
  [ -z "$warns" ] || ok=""
  if [ -n "$ok" ]; then
    echo "ok   $size $name"
  else
    fail=1
    echo "FAIL $size $name"
    [ -z "$warns" ] || printf '%s\n' "$warns" | sed 's/^/     warning: /'
    printf '%s\n' "$lines" | grep -v '^stats:' | sed 's/^/     /'
  fi
  if [ "$w" -le 480 ]; then
    local n
    n="$(printf '%s\n' "$lines" | sed -n 's/^stats: .*"rowActions":\([0-9]*\),"overflow":\([0-9]*\).*/\1 \2/p')"
    [ -z "$n" ] || row_actions_at_phone=$((row_actions_at_phone + ${n% *} + ${n#* }))
  fi
}

for size in $SIZES; do
  if [ ${#NAV_CASES[@]} -gt 0 ]; then
    log="$TMP/nav-$size.log"
    first="${NAV_CASES[0]%%/*}"
    if ! start_app "$size" "$first" "$log"; then
      echo "FAIL $size (the app never answered the devtools)"; tail -20 "$log" | sed 's/^/     /'; fail=1; stop_app; continue
    fi
    off=0
    for c in "${NAV_CASES[@]}"; do
      if [ "$c" != "${NAV_CASES[0]}" ]; then
        wait_responsive "$size before $c"
        off="$(stat -c %s "$log")"
        if ! err="$(gdbus call --session --timeout 150 --dest "$APP_ID" --object-path "$OBJ" --method org.gjsify.Devtools.ActivateAction \
             win navigate "'\"$c\"'" 2>&1)"; then
          echo "FAIL $size $c (win.navigate refused: $err)"; fail=1; continue
        fi
        sleep "$SETTLE"
      fi
      judge "$size" "$c" "$log" "$off"
    done
    stop_app
  fi
  for c in "${DIALOG_CASES[@]}"; do
    env_kv="${c#*@}"; [[ "$env_kv" == *=* ]] || env_kv="$env_kv=1"
    log="$TMP/dlg-$size.log"
    if ! start_app "$size" "${c%%@*}" "$log" "$env_kv"; then
      echo "FAIL $size $c (the app never answered the devtools)"; tail -20 "$log" | sed 's/^/     /'; fail=1; stop_app; continue
    fi
    judge "$size" "$c" "$log" 0
    stop_app
  done
done

if [ -z "${RESPONSIVE_NO_SEEN_CHECK:-}" ] && [ ${#NAV_CASES[@]} -gt 3 ] && [[ " $SIZES " == *" 360x"* ]] && [ "$row_actions_at_phone" -eq 0 ]; then
  echo "FAIL no row action or overflow button was seen at 360 px — the touch-target check looked at nothing"; fail=1
fi
echo "screenshots: $OUT"
exit $fail
