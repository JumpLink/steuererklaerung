#!/usr/bin/env bash
# End-to-end check of „Erstattungen verknüpfen" (Idee 9) against the demo workspace — drives the real
# desktop app over the devtools D-Bus plane, like laufende-kosten-e2e.sh.
#
#   app/dev/erstattungen-e2e.sh [shots-dir]     (build first: gjsify run build:gjs build:app)
#
# The demo GbR has two refunds in 2026: Büromöbel Kranich pays a returned office chair back in full, and
# Messebau Ostsee refunds part of a trade-fair stand. The run checks Als Nächstes counts them in one task;
# answers „Ja" in the booking detail of the Kranich refund → it is linked in the ledger, inherits
# 4930 Bürobedarf and reads „via Erstattung zu …" with the undo sentence; answers „Nein" for Messebau in
# „Zu prüfen" → stored as rejected and not asked again after a restart; and lifts the Kranich link again →
# the question is back. With a shots-dir the pictures are written there as erstattung-frage.png and
# erstattung-verknuepft.png.
#
# A LOCKED or blanked screen stops the frame clock (see frei-verfuegbar-e2e.sh); then run it on a private
# headless compositor: `dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11
# --virtual-monitor 1400x1100 --wayland-display e2e-wl & sleep 2; WAYLAND_DISPLAY=e2e-wl DISPLAY=
# app/dev/erstattungen-e2e.sh <shots-dir>; kill %1'`.
#
# PRIVACY: same isolation as laufende-kosten-e2e.sh — a COPY of app/demo in a throwaway dir, an empty
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
  echo '{"name":"erstattungen-e2e","private":true}' > "$T/package.json"
  ID="eu.jumplink.Steuererklaerung.E2e$$x$RANDOM"
  OBJ="/$(printf '%s' "$ID" | tr . /)/devtools"
  ( cd "$T" && exec setsid env -i LANG="${E2E_LANG:-de_DE.UTF-8}" PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data" \
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
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/erstattung-$1.png" >/dev/null || fail "screenshot $1"
}

# Read what the app persisted — the ledger rows, not what it drew.
links() {
  python3 -c '
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
try:
    rows = db.execute("SELECT refund_tx_id, original_tx_id, status, category, vat_rate FROM refund_links ORDER BY refund_tx_id").fetchall()
except sqlite3.OperationalError:
    rows = []
print(";".join("|".join(map(str, r)) for r in rows) or "none")
' "$T/demo/ledger.db"
}

KRANICH="Büromöbel Kranich GmbH"
FRAGE="Gehört das zu dieser Zahlung?"
URSPRUNG="via Erstattung zu Buchung vom 10.03.2026 ($KRANICH)"
BUCHUNGEN=(STEUER_APP_VIEW=transactions STEUER_APP_TAB=buchungen STEUER_APP_SEARCH=Rücksendung)

# ── 1. Als Nächstes counts both refunds in one task ──────────────────────────────────────────────────
launch STEUER_APP_VIEW=home
await "2 Erstattungen zuordnen"
step "Als Nächstes shows one task „2 Erstattungen zuordnen“"

# ── 2. „Ja" in the booking detail → linked, inherits the category ─────────────────────────────────────
KEEP=1 launch "${BUCHUNGEN[@]}"
await "$KRANICH"
click "$KRANICH" AdwActionRow
await "$FRAGE"
await "4930 Bürobedarf · gleicher Betrag · Verwendungszweck passt"
step "the booking detail asks „$FRAGE“ with the chair debit beside it"
shot frage
click click-tip "Gehört zu: 10.03.2026"
for _ in $(seq 1 20); do [ "$(links)" != none ] && break; sleep 0.5; done
[ "$(links)" = "demo-qonto-151|demo-qonto-150|linked|4930 Bürobedarf|0.19" ] || fail "link not stored as expected: $(links)"
step "„Ja“ stores the link with the inherited category and 19 %"

KEEP=1 launch "${BUCHUNGEN[@]}"
await "$KRANICH"
click "$KRANICH" AdwActionRow
await "$URSPRUNG"
await "4930 Bürobedarf"
await "Danach ist die Buchung unklassifiziert."
ui texts | grep -qF "$FRAGE" && fail "a linked refund is still asked about"
step "after a restart the refund reads „$URSPRUNG“ with the undo sentence"
shot verknuepft

# ── 3. „Nein" in Zu prüfen → stored, not asked again ─────────────────────────────────────────────────
KEEP=1 launch STEUER_APP_VIEW=transactions STEUER_APP_TAB=zu-pruefen
await "Erstattung? Zahlung zuordnen"
for _ in $(seq 1 40); do
  ui texts | grep -q "Teilerstattung — offen 1.547,00 €" && break
  ui click-tip "Nächste Buchung" >/dev/null || true
  sleep 1
done
await "Teilerstattung — offen 1.547,00 €"
step "Zu prüfen asks about the partial Messebau refund"
click click-tip "Gehört nicht zu: 20.02.2026"
for _ in $(seq 1 20); do links | grep -q "demo-qonto-153|demo-qonto-152|rejected" && break; sleep 0.5; done
links | grep -q "demo-qonto-153|demo-qonto-152|rejected|None|None" || fail "rejection not stored: $(links)"
KEEP=1 launch STEUER_APP_VIEW=transactions STEUER_APP_TAB=zu-pruefen
await "Zu prüfen"
sleep 3
ui texts | grep -qF "Erstattung? Zahlung zuordnen" && fail "a rejected candidate is offered again"
KEEP=1 launch STEUER_APP_VIEW=home
await "Als Nächstes"
sleep 3
ui texts | grep -qF "Erstattungen zuordnen" && fail "Als Nächstes still counts decided refunds"
ui texts | grep -qF "Erstattung zuordnen" && fail "Als Nächstes still counts a decided refund"
step "„Nein“ is stored and the refund is not asked about again, also after a restart"

# ── 4. „Verknüpfung lösen" → the question is back ──────────────────────────────────────────────────────
KEEP=1 launch "${BUCHUNGEN[@]}"
await "$KRANICH"
click "$KRANICH" AdwActionRow
await "Verknüpfung lösen"
click click-tip "Verknüpfung lösen: $KRANICH"
for _ in $(seq 1 20); do links | grep -q "|linked|" || break; sleep 0.5; done
links | grep -q "|linked|" && fail "link still stored: $(links)"
await "$KRANICH"
click "$KRANICH" AdwActionRow
await "$FRAGE"
step "„Verknüpfung lösen“ removes the link and the question returns"

echo "erstattungen e2e: all steps passed"
