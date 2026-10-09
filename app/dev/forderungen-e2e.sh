#!/usr/bin/env bash
# End-to-end check of „Offene Forderungen“ (Idee 12) against the demo workspace — drives the real desktop
# app over the devtools D-Bus plane, like forderungen-e2e.sh.
#
#   app/dev/forderungen-e2e.sh [shots-dir]     (build first: gjsify run build:gjs build:app)
#
# The demo GbR has open invoices of every kind: a claim from 2023 (Verjährung 31.12.2026), one more than
# 90 days overdue, one partly paid by a customer, and a slow payer whose delay grows (2, 5, 11, 18, 26 days).
# The run checks Als Nächstes counts the overdue claims; the Forderungen tab shows the ageing buckets, the
# customer behaviour (mean, worst case, trend) and each invoice's Verjährung; drafting a Mahnung of stage 1
# shows the text and leaves the ledger WITHOUT a sent mark; „Noch nicht“ in the confirmation changes
# nothing; „Ja, ich habe sie versendet“ stores stage 1 with today's date, and it is still there after a
# restart. With a shots-dir the pictures are written there as forderungen-ansicht.png (buckets and invoices),
# forderungen-mahnung.png (the draft) and forderungen-verhalten.png (how each customer pays).
#
# Dates: the demo's invoices have fixed dates and the app reads the real clock, so the run asserts only
# what does not move with it (names, stages, the 31.12.2026 deadline until it has passed).
#
# A LOCKED or blanked screen stops the frame clock (see frei-verfuegbar-e2e.sh); then run it on a private
# headless compositor: `dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11
# --virtual-monitor 1400x1500 --wayland-display e2e-wl & sleep 2; WAYLAND_DISPLAY=e2e-wl DISPLAY=
# app/dev/forderungen-e2e.sh <shots-dir>; kill %1'`.
#
# PRIVACY: same isolation as forderungen-e2e.sh — a COPY of app/demo in a throwaway dir, an empty
# environment (no credentials, no LLM), HOME/XDG and cwd inside it, and a Paperless stub that answers
# every request with an empty list. The committed demo is never modified.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
SHOTS="${1:-}"
GJSIFY="$APP/../node_modules/.bin/gjsify"
[ -x "$GJSIFY" ] || GJSIFY="$(command -v gjsify)"

T="$(mktemp -d)"
APP_PID=""
stop_app() {
  if [ -n "$APP_PID" ]; then
    kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true
    APP_PID=""
  fi
  return 0
}
STUB_PID=""
trap 'stop_app; [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$T"' EXIT

cat > "$T/stub.py" <<'PY'
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"count": 0, "next": None, "previous": None, "results": []}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    do_POST = do_GET
    def log_message(self, *a): pass
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
PY
python3 "$T/stub.py" > "$T/stub.port" &
STUB_PID=$!
for _ in $(seq 1 20); do [ -s "$T/stub.port" ] && break; sleep 0.2; done
STUB_PORT="$(cat "$T/stub.port")"

fail() { echo "FAIL: $*" >&2; [ -f "$T/log" ] && grep -v "^\$" "$T/log" | tail -5 >&2; exit 1; }
step() { echo "ok: $*"; }

launch() {
  stop_app
  if [ -z "${KEEP:-}" ]; then
    rm -rf "$T/demo" "$T/home"
    cp -r "$APP/demo" "$T/demo"
    rm -f "$T"/demo/ledger.db*
    rm -rf "$T/demo/transactions-data/documents"
  fi
  mkdir -p "$T/home" "$T/cfg" "$T/data"
  : > "$T/empty.env"
  echo '{"name":"forderungen-e2e","private":true}' > "$T/package.json"
  ID="eu.jumplink.Steuererklaerung.E2e$$x$RANDOM"
  OBJ="/$(printf '%s' "$ID" | tr . /)/devtools"
  ( cd "$T" && exec setsid env -i PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data" \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
      WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" DISPLAY="${DISPLAY:-:0}" \
      DOTENV_CONFIG_PATH="$T/empty.env" PAPERLESS_BASE_URL=http://127.0.0.1:$STUB_PORT PAPERLESS_API_TOKEN=demo GJSIFY_DEVTOOLS=1 STEUER_APP_ID="$ID" STEUER_DEMO=1 \
      STEUER_WORKSPACE="$T/demo/steuererklaerung.json" TRANSACTIONS_DATA_DIR="$T/demo/transactions-data" \
      LEDGER_DB_PATH="$T/demo/ledger.db" STEUER_APP_SIZE="1280 900" STEUER_APP_ENTITY=gbr STEUER_APP_YEAR=2026 "$@" \
      "$GJSIFY" run "$APP/dist/app/steuer-app.gjs.mjs" >"$T/log" 2>&1 ) &
  APP_PID=$!
  for _ in $(seq 1 80); do
    gdbus call --session --dest "$ID" --object-path "$OBJ" --method org.gjsify.Devtools.GetStatus >/dev/null 2>&1 && break
    sleep 0.5
  done
}

ui() { gjs -m "$HERE/dbus-ui.js" "$ID" "$OBJ" "$@"; }
await() {
  for _ in $(seq 1 40); do ui has "$1" && return 0; sleep 0.5; done
  fail "never saw \"$1\""
}
absent() {
  for _ in $(seq 1 40); do ui has "$1" || return 0; sleep 0.5; done
  fail "\"$1\" is still there"
}
click() {
  if [ "$1" = click-tip ]; then
    shift
    ui click-tip "$1" >/dev/null || fail "no button with the tooltip \"$1\""
  else
    ui click "$@" >/dev/null || fail "cannot click \"$1\""
  fi
  sleep 1.5
}
shot() {
  [ -z "$SHOTS" ] && return 0
  mkdir -p "$SHOTS"
  sleep 1.5
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/forderungen-$1.png" >/dev/null || fail "screenshot $1"
}

# Read what the app persisted — the ledger rows, not what it drew.
reminders() {
  python3 -c '
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
try:
    rows = db.execute("SELECT invoice_number, stage, CASE WHEN sent_at IS NULL THEN \"entworfen\" ELSE sent_at END FROM invoice_reminders ORDER BY invoice_number, stage").fetchall()
except sqlite3.OperationalError:
    rows = []
print(";".join("|".join(map(str, r)) for r in rows) or "none")
' "$T/demo/ledger.db"
}
# A deadline text that moves with the calendar: still „Handeln bis“ in 2026, „verjährt seit“ afterwards.
await_verjaehrung() {
  for _ in $(seq 1 40); do
    ui texts | grep -qE "(Handeln bis|vermutlich verjährt seit) 31.12.2026" && return 0
    sleep 0.5
  done
  fail "no Verjährung line for the 2023 claim"
}
TAB=(STEUER_APP_VIEW=rechnungen STEUER_APP_TAB=forderungen STEUER_APP_SIZE="1280 1500")
RECHNUNG=RE-2026-0004

# ── 1. Als Nächstes: the overdue claims and the Verjährung hint ─────────────────────────────────────────
launch STEUER_APP_VIEW=home
await "Forderungen überfällig"
await "Verjährung droht bei offenen Forderungen"
step "Als Nächstes shows „N Forderungen überfällig“ and the Verjährung task, each invoice once"

# ── 2. The tab: buckets, customer behaviour, Verjährung ──────────────────────────────────────────────────
KEEP=1 launch "${TAB[@]}"
await "Offene Posten nach Alter"
await "Über 90 Tage überfällig"
await "Noch nicht fällig"
await "Zahlungsverhalten je Kunde"
step "the tab shows the age buckets and the behaviour group"
await "Gasthof Strandperle"
await "Ø 12,4 Tage nach Fälligkeit"
await "schlimmster Fall 26 Tage"
await "Trend: zahlt zunehmend später"
step "the slow payer reads: mean 12,4 days, worst 26 days, trend later"
await_verjaehrung
await "RE-2023-0001"
await "eingegangen"
await "Vermutlich schon bezahlt"
step "the 2023 claim shows its Verjährung date; the partly paid one its payment; the overpaid one is not chased"
shot ansicht

# ── 3. Draft stage 1: text shown, NOT marked sent ──────────────────────────────────────────────────────
click click-tip "Mahnung entwerfen: $RECHNUNG"
await "Zahlungserinnerung: Rechnung $RECHNUNG"
await "16.02.2026"
await "nicht versendet"
await "Als versandt markieren"
step "the draft names the invoice, the due date and says it is not sent"
shot mahnung
click "Kopieren" GtkButton
sleep 1
grep -qiE "JS ERROR|TypeError|is not a function" "$T/log" && fail "copying the draft raised an error: $(grep -iE 'JS ERROR|TypeError|is not a function' "$T/log" | head -2)"
step "„Kopieren“ ran without an error"
[ "$(reminders)" = "$RECHNUNG|1|entworfen" ] || fail "after drafting the ledger should only know a draft: $(reminders)"
step "the ledger holds the draft of stage 1 and no sent mark"

# ── 4. „Noch nicht“ changes nothing; „Ja“ stores the stage ──────────────────────────────────────────────
click "Als versandt markieren" GtkButton
await "Stufe 1 als versandt markieren?"
click "Noch nicht"
sleep 1
[ "$(reminders)" = "$RECHNUNG|1|entworfen" ] || fail "cancelling must not mark anything sent: $(reminders)"
step "„Noch nicht“ leaves the stage unsent"
click "Als versandt markieren" GtkButton
await "Stufe 1 als versandt markieren?"
click "Ja, ich habe sie versendet"
TODAY="$(date +%F)"
for _ in $(seq 1 20); do [ "$(reminders)" = "$RECHNUNG|1|$TODAY" ] && break; sleep 0.5; done
[ "$(reminders)" = "$RECHNUNG|1|$TODAY" ] || fail "stage 1 not stored as sent today: $(reminders)"
step "„Ja, ich habe sie versendet“ stores stage 1 with today's date"
await "Stufe 1 · Zahlungserinnerung (versandt"
step "the list now reads the stage on the invoice"

# ── 5. Still there after a restart; the next stage is not due yet ────────────────────────────────────────
KEEP=1 launch "${TAB[@]}"
await "Stufe 1 · Zahlungserinnerung (versandt"
step "after a restart the stage is still there"
VERSANDT="(versandt $(date +%d.%m.%Y))"
ui texts | grep -qF "$VERSANDT" || fail "no line carries \"$VERSANDT\""
ui texts | grep -F "$VERSANDT" | grep -qF "Stufe 2 ist fällig" && fail "stage 2 must not be due right after stage 1"
step "stage 2 is not offered as due right after stage 1"

# ── 6. The behaviour group, scrolled into view for the picture ──────────────────────────────────────────
if [ -n "$SHOTS" ]; then
  KEEP=1 launch "${TAB[@]}" STEUER_APP_SCROLL=end
  await "Trend: zahlt zunehmend später"
  shot verhalten
fi

echo "forderungen e2e: all steps passed"
