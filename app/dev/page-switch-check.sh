#!/usr/bin/env bash
# Page-switch regression check for the desktop app.
#
# Opens every sidebar page once (cold) and then returns to each page once (warm) in a single app
# instance, using the app's own STEUER_DEBUG_TIMING=1 output. Fails when a warm switch takes longer
# than PAGE_SWITCH_WARM_MS (default 200) to show content, or when any mainloop stall in the measured
# window exceeds PAGE_SWITCH_STALL_MS (default 200).
#
#   scripts/headless-run -- app/dev/page-switch-check.sh [--warm-ms N] [--stall-ms N]
#
# Demo data only (STEUER_DEMO=1) and throw-away XDG dirs — no real manifest, no fints-data,
# no transactions-data. The checked-in app/demo is copied first; the copy is written while running.
set -euo pipefail

# Warm/stall budget: hard ceiling for perceived responsiveness.
WARM_LIMIT="${PAGE_SWITCH_WARM_MS:-200}"
STALL_LIMIT="${PAGE_SWITCH_STALL_MS:-200}"

# Cold thresholds are derived from a measured origin/main run, not tuned to pass.
# Measurement (2026-11-10, demo data, this machine):
#   home cold ready 734.8 ms, home cold stall 592.3 ms;
#   all other cold pages ready <= 102 ms and stall-free.
# Reserve 1.5x, rounded up to the next 100 ms.
COLD_READY_LIMIT="${PAGE_SWITCH_COLD_READY_MS:-1100}"
COLD_STALL_LIMIT="${PAGE_SWITCH_COLD_STALL_MS:-900}"
while [ $# -gt 0 ]; do
  case "$1" in
    --warm-ms) WARM_LIMIT="${2:?--warm-ms needs a number}"; shift 2 ;;
    --stall-ms) STALL_LIMIT="${2:?--stall-ms needs a number}"; shift 2 ;;
    --cold-ready-ms) COLD_READY_LIMIT="${2:?--cold-ready-ms needs a number}"; shift 2 ;;
    --cold-stall-ms) COLD_STALL_LIMIT="${2:?--cold-stall-ms needs a number}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
GJSIFY="$APP/../node_modules/.bin/gjsify"
[ -x "$GJSIFY" ] || GJSIFY="$APP/node_modules/.bin/gjsify"
[ -x "$GJSIFY" ] || GJSIFY="$(command -v gjsify)"
[ -s "$APP/dist/app/steuer-app.gjs.mjs" ] || { echo "build first: npm run build:app" >&2; exit 2; }

TMP="$(mktemp -d)"
LOG="$TMP/app.log"
APP_ID="eu.jumplink.Steuererklaerung.PageSwitch$$"
OBJ="/$(printf '%s' "$APP_ID" | tr . /)/devtools"
cp -r "$APP/demo" "$TMP/demo"
rm -f "$TMP/demo"/ledger.db*

APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && { kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true; }
  rm -rf "$TMP"
  return 0
}
trap cleanup EXIT

setsid env GJSIFY_DEVTOOLS=1 STEUER_APP_ID="$APP_ID" STEUER_DEMO=1 STEUER_DEMO_DIR="$TMP/demo" \
  STEUER_DEBUG_TIMING=1 STEUER_APP_VIEW=home STEUER_APP_SIZE="1280 860" \
  XDG_DATA_HOME="$TMP/xdg/data" XDG_CONFIG_HOME="$TMP/xdg/config" XDG_CACHE_HOME="$TMP/xdg/cache" \
  bash -c "cd \"$APP\" && exec \"$GJSIFY\" run start:app" >"$LOG" 2>&1 &
APP_PID=$!

for _ in $(seq 1 120); do
  gdbus call --session --dest "$APP_ID" --object-path "$OBJ" --method org.gjsify.Devtools.GetStatus >/dev/null 2>&1 && break
  sleep 0.5
done

# Wait until the log has been quiet for $1 seconds (or $2 seconds passed in total).
settle() {
  local quiet="$1" max="$2" last=-1 same=0 t=0 size
  while [ "$t" -lt $((max * 10)) ]; do
    size="$(stat -c %s "$LOG")"
    if [ "$size" = "$last" ]; then same=$((same + 1)); else same=0; last="$size"; fi
    [ "$same" -ge $((quiet * 10)) ] && return 0
    sleep 0.1; t=$((t + 1))
  done
}

settle 2 90
START_LINES="$(wc -l <"$LOG")"

# All top-level sidebar pages, in the order they appear there.
VIEWS=(home review transactions rechnungen zeiten kontakte auswertungen fristen steuer projekte vertraege konten settings)
declare -A SEEN
FAIL=0

print_header() {
  printf '%-14s %-6s %10s %10s %10s  %s\n' page visit visible_ms ready_ms stall_ms notes
}
print_header

echo "startup:"
grep -aE '→ ready|mainloop stall' "$LOG" | sed 's/^/  /' | head -50

measure() {
  local view="$1" round="$2"
  local before="$(wc -l <"$LOG")"
  if ! err="$(gdbus call --session --timeout 30 --dest "$APP_ID" --object-path "$OBJ" --method org.gjsify.Devtools.ActivateAction \
       win navigate "'\"$view\"'" 2>&1)"; then
    echo "FAIL navigate $view ($round): $err" >&2
    FAIL=1
    return 0
  fi
  settle 1 60
  local chunk="$(tail -n +"$((before + 1))" "$LOG")"
  local ready warm visible stall note=""
  ready="$(printf '%s\n' "$chunk" | grep -a '→ ready' | sed -E 's/.* ([0-9.]+) ms$/\1/' | sort -n | tail -1 || true)"
  warm="$(printf '%s\n' "$chunk" | grep -ac '(warm) → ready' || true)"
  stall="$(printf '%s\n' "$chunk" | grep -a 'mainloop stall' | sed -E 's/.* ([0-9.]+) ms$/\1/' | sort -n | tail -1 || true)"
  if [ -z "$ready" ]; then
    # Navigating to the already-visible page produces no new timing line; treat as warm/0.
    [ "$round" = back ] && printf '%-14s %-6s %10s %10s %10s  %s\n' "$view" "$round" 0 0 "${stall:--}" "already visible"
    return 0
  fi
  if [ "$warm" -gt 0 ]; then visible=0; else visible="$ready"; fi
  if [ -n "$stall" ] && awk "BEGIN{exit !($stall > $STALL_LIMIT)}"; then
    note="stall ${stall}ms>${STALL_LIMIT}ms"
    FAIL=1
  fi
  if [ "$round" = back ] && awk "BEGIN{exit !($visible > $WARM_LIMIT)}"; then
    note="${note:+, }warm ${visible}ms>${WARM_LIMIT}ms"
    FAIL=1
  fi
  printf '%-14s %-6s %10s %10s %10s  %s\n' "$view" "$round" "$visible" "$ready" "${stall:--}" "${note:-}"
  return 0
}

# Home is already loaded at startup; its cold time comes from the startup log.
home_cold_ready="$(grep -a 'view .* → ready' "$LOG" | sed -E 's/.* ([0-9.]+) ms$/\1/' | sort -n | tail -1 || true)"
home_cold_stall="$(grep -a 'mainloop stall' "$LOG" | sed -E 's/.* ([0-9.]+) ms$/\1/' | sort -n | tail -1 || true)"
home_cold_note="startup"
if [ -n "$home_cold_stall" ] && awk "BEGIN{exit !($home_cold_stall > $COLD_STALL_LIMIT)}"; then
  home_cold_note="startup, stall ${home_cold_stall}ms>${COLD_STALL_LIMIT}ms"
  FAIL=1
fi
if [ -n "$home_cold_ready" ] && awk "BEGIN{exit !($home_cold_ready > $COLD_READY_LIMIT)}"; then
  home_cold_note="${home_cold_note:+, }cold ${home_cold_ready}ms>${COLD_READY_LIMIT}ms"
  FAIL=1
fi
printf '%-14s %-6s %10s %10s %10s  %s\n' home cold "${home_cold_ready:-}" "${home_cold_ready:-}" "${home_cold_stall:--}" "$home_cold_note"

for v in review transactions rechnungen zeiten kontakte auswertungen fristen steuer projekte vertraege konten settings; do
  measure "$v" cold
  SEEN[$v]=1
done
for v in home review transactions rechnungen zeiten kontakte auswertungen fristen steuer projekte vertraege konten settings; do
  measure "$v" back
done

exit "$FAIL"
