#!/usr/bin/env bash
# Page-switch benchmark for the desktop app: opens every main page twice (cold, then back again)
# and prints how long each took to be ready, from the app's own STEUER_DEBUG_TIMING lines.
#
#   scripts/headless-run -- app/dev/bench-pages.sh [--scale N] [--assert-warm-ms MS]
#
#   --scale N            inflate the demo ledger N-fold (default 1 = the plain demo; ~400 bookings,
#                        so --scale 40 is ~16 000, a few years of a busy shop)
#   --assert-warm-ms MS  fail when a page that was already visited needed more than MS before it
#                        showed content (the acceptance bound is 200)
#
# Runs on a THROWAWAY COPY of app/demo in a temp dir (STEUER_DEMO_DIR), never on real data and never
# on the checked-in demo. Needs a built app (`gjsify run build:app`) and a session bus — run it under
# scripts/headless-run so no window lands on the real desktop.
#
# What the numbers mean: `ready` is reload() → content shown, in ms. A page that already showed
# content for the same entity/year keeps it on screen while it refreshes ("warm"), so for it the
# time before content is visible is 0 and `ready` only says when the refresh landed.
set -euo pipefail

SCALE=1
ASSERT_WARM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --scale) SCALE="${2:?--scale needs a number}"; shift 2 ;;
    --assert-warm-ms) ASSERT_WARM="${2:?--assert-warm-ms needs a number}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
GJSIFY="$APP/../node_modules/.bin/gjsify"
[ -x "$GJSIFY" ] || GJSIFY="$(command -v gjsify)"

TMP="$(mktemp -d)"
LOG="$TMP/app.log"
APP_ID="eu.jumplink.Steuererklaerung.Bench$$"
OBJ="/$(printf '%s' "$APP_ID" | tr . /)/devtools"
cp -r "$APP/demo" "$TMP/demo"
rm -f "$TMP/demo"/ledger.db*

if [ "$SCALE" -gt 1 ]; then
  node - "$TMP/demo/transactions-data" "$SCALE" <<'JS'
const fs = require('fs'), path = require('path');
const [dir, n] = [process.argv[2], Number(process.argv[3])];
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson'))) {
  const rows = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const out = [];
  for (let k = 0; k < n; k++) {
    for (const r of rows) {
      const d = new Date(r.bookingDate + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + (k % 28)); // same year mostly, spread over the days
      const iso = d.toISOString().slice(0, 10);
      out.push(JSON.stringify({ ...r, id: k === 0 ? r.id : `${r.id}-x${k}`, bookingDate: iso, valueDate: iso,
        amount: Math.round(r.amount * (1 + (k % 7) / 10) * 100) / 100 }));
    }
  }
  fs.writeFileSync(path.join(dir, f), out.join('\n') + '\n');
}
JS
fi

APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && { kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true; }
  [ -n "${BENCH_KEEP_LOG:-}" ] && cp "$LOG" "$BENCH_KEEP_LOG"; rm -rf "$TMP"
  return 0
}
trap cleanup EXIT

setsid env GJSIFY_DEVTOOLS=1 STEUER_APP_ID="$APP_ID" STEUER_DEMO=1 STEUER_DEMO_DIR="$TMP/demo" \
  STEUER_DEBUG_TIMING=1 STEUER_APP_VIEW=home STEUER_APP_SIZE="1280 860" \
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

# The first page loads on its own at startup — its time is the startup measurement.
settle 2 90
START_LINES="$(wc -l <"$LOG")"

VIEWS=(home review transactions rechnungen zeiten kontakte auswertungen fristen steuer)
declare -A SEEN
FAIL=0
printf '%-14s %-6s %10s %10s  %s\n' page visit visible_ms ready_ms longest_stall_ms
echo "startup:"
grep -a '→ ready\|mainloop stall' "$LOG" | sed 's/^/  /' | head -20

for round in cold back; do
  for v in "${VIEWS[@]}"; do
    before="$(wc -l <"$LOG")"
    gdbus call --session --dest "$APP_ID" --object-path "$OBJ" --method org.gjsify.Devtools.ActivateAction \
      win "goto-$v" null >/dev/null || { echo "goto-$v failed" >&2; continue; }
    settle 1 60
    chunk="$(tail -n +"$((before + 1))" "$LOG")"
    # Pages that opened as an error/placeholder (privat-only or not available) log no ready line.
    ready="$(printf '%s\n' "$chunk" | grep -a '→ ready' | sed -E 's/.* ([0-9.]+) ms$/\1/' | sort -n | tail -1 || true)"
    warm="$(printf '%s\n' "$chunk" | grep -ac '(warm) → ready' || true)"
    stall="$(printf '%s\n' "$chunk" | grep -a 'mainloop stall' | sed -E 's/.* ([0-9.]+) ms$/\1/' | sort -n | tail -1 || true)"
    [ -n "$ready" ] || continue
    if [ "$warm" -gt 0 ]; then visible=0; else visible="$ready"; fi
    printf '%-14s %-6s %10s %10s  %s\n' "$v" "$round" "$visible" "$ready" "${stall:--}"
    if [ "$round" = back ] && [ -n "$ASSERT_WARM" ] && awk "BEGIN{exit !($visible > $ASSERT_WARM)}"; then
      echo "FAIL: $v took ${visible} ms to show content on a revisit (limit ${ASSERT_WARM} ms)" >&2
      FAIL=1
    fi
  done
done
exit "$FAIL"
