#!/usr/bin/env bash
# End-to-end check of the Splitbuchung (Idee 13) against the demo workspace — drives the real desktop
# app over the devtools D-Bus plane, like erstattungen-e2e.sh.
#
#   app/dev/splitbuchung-e2e.sh [shots-dir]     (build first: gjsify run build:gjs build:app)
#
# The demo GbR has a mixed online order in June 2026 (Versandhaus Möwenpost: office supplies and a
# private coffee machine). The run opens the booking, „Aufteilen" starts half and half with the
# remainder computed, adds and removes a part, and saves. The demo register holds Q2/2026 as filed, so
# saving asks first: „Abbrechen" writes nothing, „Trotzdem aufteilen" stores both parts in the ledger.
# After a restart the booking reads „aufgeteilt in 2 Teile" with its parts, the EÜR's Bürobedarf
# Herleitung shows it as „Teil 1 von 2", and „Aufteilung aufheben" removes the split and says what
# applies then. With a shots-dir the pictures are written there as splitbuchung-dialog.png and
# splitbuchung-aufgeteilt.png.
#
# A LOCKED or blanked screen stops the frame clock (see frei-verfuegbar-e2e.sh); then run it on a private
# headless compositor: `dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11
# --virtual-monitor 1400x1100 --wayland-display e2e-wl & sleep 2; WAYLAND_DISPLAY=e2e-wl DISPLAY=
# app/dev/splitbuchung-e2e.sh <shots-dir>; kill %1'`.
#
# PRIVACY: same isolation as erstattungen-e2e.sh — a COPY of app/demo in a throwaway dir, an empty
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
  echo '{"name":"splitbuchung-e2e","private":true}' > "$T/package.json"
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
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/splitbuchung-$1.png" >/dev/null || fail "screenshot $1"
}

# Read what the app persisted — the ledger rows, not what it drew.
parts() {
  python3 -c '
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
try:
    rows = db.execute("SELECT tx_id, part_no, category, amount_cents, vat_rate FROM booking_splits ORDER BY tx_id, part_no").fetchall()
except sqlite3.OperationalError:
    rows = []
print(";".join("|".join(map(str, r)) for r in rows) or "none")
' "$T/demo/ledger.db"
}

MOEWE="Versandhaus Möwenpost"
BUCHUNGEN=(STEUER_APP_VIEW=transactions STEUER_APP_TAB=buchungen STEUER_APP_SEARCH=Möwenpost)
GESPEICHERT="demo-qonto-159|1|4930 Bürobedarf|11900|0.19;demo-qonto-159|2|1800 Privatentnahme|None|0.19"

# ── 1. „Aufteilen": half and half, the remainder computed, a part added and removed ─────────────────
launch "${BUCHUNGEN[@]}"
await "$MOEWE"
click "$MOEWE" AdwActionRow
await "Aufteilen"
click "Aufteilen" GtkButton
await "Teil 2 · Rest"
await "119,00 €"
await "Zeitraum schon eingereicht"
step "the dialog starts half and half: Teil 1 119,00 € in 4930 Bürobedarf, the rest 119,00 € private"
click click-tip "Teil hinzufügen"
await "Teil 3 · Rest"
await "Teil 2: Betrag fehlt."
step "a third part without amount is refused live: „Teil 2: Betrag fehlt.“"
click click-tip "Teil 2 entfernen"
absent "Teil 3 · Rest"
absent "Betrag fehlt"
shot dialog

# ── 2. Filed period: „Abbrechen" writes nothing, „Trotzdem aufteilen" stores both parts ────────────
click "Speichern" GtkButton
await "USt-Voranmeldung Q2/2026 ist schon eingereicht"
await "§ 153 AO"
click "Abbrechen" GtkButton
sleep 1
[ "$(parts)" = none ] || fail "a split was stored without confirmation: $(parts)"
step "in a filed period nothing is written without confirmation"
click "Speichern" GtkButton
await "Trotzdem aufteilen"
click "Trotzdem aufteilen" GtkButton
for _ in $(seq 1 20); do [ "$(parts)" != none ] && break; sleep 0.5; done
[ "$(parts)" = "$GESPEICHERT" ] || fail "split not stored as expected: $(parts)"
step "„Trotzdem aufteilen“ stores both parts, the remainder without an amount"

# ── 3. After a restart: the parts in the booking detail and in the Herleitung ────────────────────────
KEEP=1 launch "${BUCHUNGEN[@]}"
await "$MOEWE"
click "$MOEWE" AdwActionRow
await "aufgeteilt in 2 Teile"
await "Teil 2 · Rest"
await "1800 Privatentnahme · 19 % · privat, keine Vorsteuer"
await "Danach gilt wieder: via Regel"
await "(Auffangregel) → 4930 Bürobedarf."
step "the booking reads „aufgeteilt in 2 Teile“ with its parts and the undo sentence"
shot aufgeteilt

KEEP=1 launch STEUER_APP_VIEW=steuer STEUER_APP_TAB=euer
await "4930 Bürobedarf ·"
click "4930 Bürobedarf ·" AdwActionRow
await "Teil 1 von 2"
click "Teil 1 von 2" AdwActionRow
await "Aufteilung"
await "Teil 1 · diese Zahl"
await "Aufteilung aufheben"
step "the Herleitung of 4930 Bürobedarf shows the booking as „Teil 1 von 2“ with every part"

# ── 4. „Aufteilung aufheben" → back to one booking ───────────────────────────────────────────────────
KEEP=1 launch "${BUCHUNGEN[@]}"
await "$MOEWE"
click "$MOEWE" AdwActionRow
await "Aufteilung aufheben"
click "Aufheben" GtkButton
await "Aufteilung aufheben?"
click "Aufteilung aufheben" GtkButton
await "Trotzdem aufheben"
click "Trotzdem aufheben" GtkButton
for _ in $(seq 1 20); do [ "$(parts)" = none ] && break; sleep 0.5; done
[ "$(parts)" = none ] || fail "split still stored: $(parts)"
# Relaunch: ActivateWidget opens a row's detail sheet twice (activate() and the list box), so the
# second, stale sheet would still be on screen — a rig artefact, a real click opens one.
KEEP=1 launch "${BUCHUNGEN[@]}"
await "$MOEWE"
click "$MOEWE" AdwActionRow
await "Aufteilen"
ui texts | grep -F "aufgeteilt in 2 Teile" >&2 && fail "the booking still reads as split"
step "„Aufteilung aufheben“ removes the parts and the booking is one again"

echo "splitbuchung e2e: all steps passed"
