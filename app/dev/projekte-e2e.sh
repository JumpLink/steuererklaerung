#!/usr/bin/env bash
# End-to-end check of „Projekte auch für Ausgaben" (Idee 14) against the demo workspace — drives the real
# desktop app over the devtools D-Bus plane, like splitbuchung-e2e.sh.
#
#   app/dev/projekte-e2e.sh [shots-dir]     (build first: gjsify run build:gjs, then gjsify run build:app)
#
# The demo GbR has the project „Website-Relaunch Wattküste" with two invoices (1.200 € net), 16,5 tracked
# hours and three costs in May 2026: a picture licence and a font licence (nothing assigns them) and a
# domain, which the project rule „Relaunch Wattküste" assigns. The run
#   1. opens Buchungen, switches to „Auswählen", marks the two licences and assigns them with „Zuordnen";
#   2. checks the ledger: two decisions in booking_projects, logged as projekt.assign;
#   3. restarts, opens the project: Umsatz, Kosten (the domain „via Regel"), Ergebnis, hours and €/h;
#   4. opens the booking detail of a licence: its project, „manuell", and „Zuordnung zurücknehmen" with
#      the sentence what applies afterwards; takes it back — the cost list and the result follow;
#   5. takes the rule-assigned domain out of the project („kein Projekt" wins over the rule) and checks
#      that the decision, not the rule, is what the ledger holds now.
# With a shots-dir the pictures are written there as projekt-auswahl.png and projekt-ergebnis.png.
#
# A LOCKED or blanked screen stops the frame clock (see frei-verfuegbar-e2e.sh); then run it on a private
# headless compositor: `dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11
# --virtual-monitor 1400x1100 --wayland-display e2e-wl & sleep 2; WAYLAND_DISPLAY=e2e-wl DISPLAY=
# app/dev/projekte-e2e.sh <shots-dir>; kill %1'`.
#
# PRIVACY: same isolation as splitbuchung-e2e.sh — a COPY of app/demo in a throwaway dir, an empty
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
  echo '{"name":"projekte-e2e","private":true}' > "$T/package.json"
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
  ui texts 2>/dev/null | grep -F "${1:0:10}" | head -5 | cat -A | cut -c1-200 >&2 || true
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
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/projekt-$1.png" >/dev/null || fail "screenshot $1"
}

# Read what the app persisted — the ledger rows, not what it drew.
links() {
  python3 -c '
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
try:
    rows = db.execute("SELECT tx_id, part_no, project_id FROM booking_projects ORDER BY tx_id, part_no").fetchall()
except sqlite3.OperationalError:
    rows = []
print(";".join("|".join(map(str, r)) for r in rows) or "none")
' "$T/demo/ledger.db"
}
actions() {
  python3 -c '
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
print(",".join(r[0] for r in db.execute("SELECT action FROM audit_log WHERE action LIKE ? ORDER BY id", ("projekt.%",)).fetchall()) or "none")
' "$T/demo/ledger.db"
}

LIZENZ_BILD="Bildagentur Küstenlicht"
LIZENZ_FONT="Schriftgießerei Nordtype"
DOMAIN="INWX GmbH"
PROJEKT="Website-Relaunch Wattküste"
BUCHUNGEN=(STEUER_APP_VIEW=transactions STEUER_APP_TAB=buchungen STEUER_APP_SEARCH=Wattküste)
BILD_ID="demo-qonto-161"
FONT_ID="demo-qonto-162"
DOMAIN_ID="demo-qonto-163"

# ── 1. Buchungen: „Auswählen", mark the two licences, „Projekt zuordnen" ───────────────────────────
launch "${BUCHUNGEN[@]}"
await "$LIZENZ_BILD"
await "$DOMAIN"
click "Auswählen" GtkButton
await "Projekt zuordnen"
click click-tip "Auswählen: $LIZENZ_BILD"
click click-tip "Auswählen: $LIZENZ_FONT"
await "Projekt zuordnen (2)"
step "„Auswählen“ turns the expenses into check rows; two marked → „Projekt zuordnen (2)“"
shot auswahl
click "Projekt zuordnen (2)" GtkButton
await "2 Ausgaben"
await "Als Regel merken"
await "$PROJEKT"
click "Zuordnen" GtkButton
for _ in $(seq 1 20); do [ "$(links)" != none ] && break; sleep 0.5; done
[ "$(links)" = "$BILD_ID|0|wattkueste-relaunch;$FONT_ID|0|wattkueste-relaunch" ] || fail "decisions not stored as expected: $(links)"
[ "$(actions)" = "projekt.assign,projekt.assign" ] || fail "decision log: $(actions)"
step "both licences are stored as decisions for the project and logged as projekt.assign"

# ── 2. After a restart: the project shows result, costs, origins ────────────────────────────────────
KEEP=1 launch STEUER_APP_VIEW=projekte
await "$PROJEKT"
await "Ergebnis 2026: 1.108,00"
click "$PROJEKT" AdwActionRow
await "Projektergebnis 2026"
await "Interne Auswertung, keine Steuerzahl"
await "1.200,00"
await "92,00"
await "1.108,00"
await "16,50 h erfasst"
await "67,15"
await "via Regel „Relaunch Wattküste“"
await "manuell"
await "RE-2026-0010"
await "RE-2026-0001"
ui texts | grep -F "RE-2026-0005" >&2 && fail "an invoice of another customer is in the project"
step "Projektergebnis: Umsatz 1.200 − Kosten 92 = 1.108 €, 16,5 h, 67,15 €/h; the domain comes via Regel, the licences by hand"
shot ergebnis

# ── 3. Take a decision back from the booking: the sentence, then the figures follow ─────────────────
KEEP=1 launch "${BUCHUNGEN[@]}"
await "$LIZENZ_BILD"
click "$LIZENZ_BILD" AdwActionRow
await "Zuordnung zurücknehmen"
await "Danach gilt: kein Projekt."
click click-tip "Zuordnung zurücknehmen: $LIZENZ_BILD"
for _ in $(seq 1 20); do [ "$(links)" = "$FONT_ID|0|wattkueste-relaunch" ] && break; sleep 0.5; done
[ "$(links)" = "$FONT_ID|0|wattkueste-relaunch" ] || fail "decision not taken back: $(links)"
[ "$(actions)" = "projekt.assign,projekt.assign,projekt.clear" ] || fail "decision log: $(actions)"
step "„Zuordnung zurücknehmen“ says „Danach gilt: kein Projekt.“ and removes only that decision"

KEEP=1 launch STEUER_APP_VIEW=projekte
await "Ergebnis 2026: 1.158,00"
step "the project result follows: Kosten 42 € → Ergebnis 1.158 €"

# ── 4. The rule's hit: „kein Projekt“ wins over the rule ────────────────────────────────────────────
click "$PROJEKT" AdwActionRow
await "via Regel „Relaunch Wattküste“"
click click-tip "Aus dem Projekt nehmen: $DOMAIN"
for _ in $(seq 1 20); do [ "$(links)" = "$FONT_ID|0|wattkueste-relaunch;$DOMAIN_ID|0|None" ] && break; sleep 0.5; done
[ "$(links)" = "$FONT_ID|0|wattkueste-relaunch;$DOMAIN_ID|0|None" ] || fail "exclusion not stored: $(links)"
[ "$(actions)" = "projekt.assign,projekt.assign,projekt.clear,projekt.exclude" ] || fail "decision log: $(actions)"
# Relaunch: ActivateWidget opens a row's dialog twice (activate() and the list box), so the second,
# stale dialog would still show the old figures — a rig artefact, a real click opens one.
KEEP=1 launch STEUER_APP_VIEW=projekte
await "Ergebnis 2026: 1.170,00"
click "$PROJEKT" AdwActionRow
await "ordnet 0 Ausgabe(n) zu"
ui texts | grep -F "via Regel „Relaunch Wattküste“" | grep -vF "ordnet" >&2 && fail "the rule still assigns the domain"
step "taking the rule's hit out stores „kein Projekt“ as a decision of its own; the rule stays but assigns nothing"

KEEP=1 launch "${BUCHUNGEN[@]}"
await "$DOMAIN"
click "$DOMAIN" AdwActionRow
await "manuell: kein Projekt"
await "Danach gilt: via Regel „Relaunch Wattküste“ → Projekt „$PROJEKT“."
step "the booking detail says „manuell: kein Projekt“ and what applies once that is taken back"

echo "projekte e2e: all steps passed"
