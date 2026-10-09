#!/usr/bin/env bash
# End-to-end check of „Dokumentregeln ohne KI" (Idee 11) against the demo workspace — drives the real
# desktop app over the devtools D-Bus plane, like erstattungen-e2e.sh.
#
#   app/dev/dokumentregel-e2e.sh [shots-dir]     (build first: gjsify run build)
#
# Opens the demo Beleg of Deutsche Telekom AG (category 4921 Telefon/Internet) in „Beleg bearbeiten",
# turns on „Als Regel merken" and saves → the rule is written to the manifest (elster.klassifizierung.
# beleg_regeln). A second Beleg of the same sender is then stored through the CLI (`belege hinzufuegen`,
# the upload path of every surface): its sender, type, category and direction are set by the rule, the
# ledger row names the rule, and the Belege list reads „via Regel …". „Zurücknehmen" clears the values
# again. Screenshot: dokumentregel-herkunft.png.
#
# Same isolation as erstattungen-e2e.sh (copy of app/demo in a throwaway dir, empty environment, Paperless
# stub, HOME/XDG inside it); the committed demo is never modified. On a locked screen run it on a private
# headless mutter (see erstattungen-e2e.sh).
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
  echo '{"name":"dokumentregel-e2e","private":true}' > "$T/package.json"
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
  ui texts 2>/dev/null | grep -i "telekom\|Regel" | head -8 >&2 || true
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
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/dokumentregel-$1.png" >/dev/null || fail "screenshot $1"
}


# The CLI against the same isolated demo copy as the app.
cli() {
  ( cd "$T" && env -i LANG="${E2E_LANG:-de_DE.UTF-8}" PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data" \
      DOTENV_CONFIG_PATH="$T/empty.env" STEUER_DEMO=1 STEUER_WORKSPACE="$T/demo/steuererklaerung.json" \
      TRANSACTIONS_DATA_DIR="$T/demo/transactions-data" LEDGER_DB_PATH="$T/demo/ledger.db" \
      "$GJSIFY" run "$APP/dist/steuer.gjs.mjs" "$@" )
}
rules() {
  python3 -c '
import json, sys
m = json.load(open(sys.argv[1]))
e = [x for x in m["entities"] if x["id"] == "gbr"][0]
print(json.dumps(e.get("elster", {}).get("klassifizierung", {}).get("beleg_regeln", []), sort_keys=True))
' "$T/demo/steuererklaerung.json"
}
docrow() {
  python3 -c '
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
r = db.execute("SELECT correspondent, document_type, category, direction, rule_origin FROM documents WHERE filename LIKE ?", (sys.argv[2],)).fetchone()
print("|".join(map(str, r)) if r else "none")
' "$T/demo/ledger.db" "$1"
}

# ── 1. „Als Regel merken" in the Beleg-Metadaten dialog ───────────────────────────────────────────────
launch STEUER_APP_VIEW=review STEUER_APP_TAB=alle
await "TK-2026-01"
click "TK-2026-01" AdwActionRow
await "Als Regel merken"
await "Dokumenttyp"
step "the Beleg dialog offers „Als Regel merken“ next to Dokumenttyp and Kategorie"
click "Als Regel merken" AdwSwitchRow
click "Speichern"
for _ in $(seq 1 20); do [ "$(rules)" != "[]" ] && break; sleep 0.5; done
[ "$(rules)" = '[{"dokumenttyp": "Rechnung", "kategorie": "4921 Telefon/Internet", "korrespondent": "Deutsche Telekom AG", "muster": "Deutsche Telekom AG", "richtung": "incoming"}]' ] \
  || fail "rule not written as expected: $(rules)"
step "„Als Regel merken“ wrote the rule into elster.klassifizierung.beleg_regeln"
stop_app

# ── 2. A second Beleg of the same sender arrives → the rule sets its fields ───────────────────────────
printf '%%PDF-1.4\ndemo\n' > "$T/Deutsche Telekom AG 2026-02.pdf"
cli belege hinzufuegen "$T/Deutsche Telekom AG 2026-02.pdf" --entity gbr --year 2026 > "$T/cli.out" 2>"$T/cli.err" \
  || { cat "$T/cli.err" >&2; fail "belege hinzufuegen"; }
grep -q 'via Regel „Deutsche Telekom AG“ gesetzt' "$T/cli.out" || { cat "$T/cli.out" >&2; fail "CLI does not report the rule"; }
ROW="$(docrow 'Deutsche Telekom AG 2026-02.pdf')"
case "$ROW" in
  "Deutsche Telekom AG|Rechnung|4921 Telefon/Internet|incoming|"*'beleg:regeln:deutsche telekom ag'*) ;;
  *) fail "ledger row not set by the rule: $ROW" ;;
esac
step "the upload path set sender, type, category and direction via the rule (ledger row names it)"

# ── 3. The Belege list shows the origin ────────────────────────────────────────────────────────────────
KEEP=1 launch STEUER_APP_VIEW=review STEUER_APP_TAB=alle
await "via Regel „Deutsche Telekom AG“"
step "the Belege list reads „via Regel „Deutsche Telekom AG““"
click "Deutsche Telekom AG 2026-02" AdwActionRow
await "via Regel „Deutsche Telekom AG“ gesetzt: Korrespondent, Dokumenttyp, Kategorie und Richtung"
await "Zurücknehmen"
shot herkunft

# ── 4. Zurücknehmen → values gone, receipt left out of the rule ───────────────────────────────────────
click "Zurücknehmen"
for _ in $(seq 1 20); do case "$(docrow 'Deutsche Telekom AG 2026-02.pdf')" in *"|None") break ;; esac; sleep 0.5; done
ROW="$(docrow 'Deutsche Telekom AG 2026-02.pdf')"
[ "$ROW" = "None|None|None|None|None" ] || fail "values not taken back: $ROW"
rules | grep -q '"ausnahmen"' || fail "receipt not added to the rule's ausnahmen"
step "„Zurücknehmen“ cleared the rule's values and left the receipt out of the rule"

echo "dokumentregel e2e: all steps passed"
