#!/usr/bin/env bash
# End-to-end check of „Rechnung ↔ Projekt" against the demo workspace — drives the real desktop app over the
# devtools D-Bus plane, like projekte-e2e.sh.
#
#   app/dev/rechnung-projekt-e2e.sh [shots-dir]     (build first: gjsify run build:gjs, then gjsify run build:app)
#
# The demo GbR has a second project „Buchungssystem Segelschule" for the customer „Segelschule Nordwind": a
# paid flat-fee invoice (600 € net, no hours behind it) and 6,75 tracked hours, none billed. The run
#   1. creates a DRAFT from the project's open hours with the CLI (`invoices self create --projekt --zeiten`;
#      the form's customer/rate fields cannot be typed over the devtools plane): the lines are there, the
#      three entries are only reserved (time_entries.invoice_id still empty);
#   2. opens the draft: the project row says „direkt zugeordnet"; „Festschreiben" bills the entries — only now;
#   3. opens the flat-fee invoice (no project), assigns it with „Zuordnen …" and checks the ledger + log;
#   4. opens the project: Umsatz 600 + 607,50 = 1.207,50 €, both invoices listed with their origin.
#
# PRIVACY: a COPY of app/demo in a throwaway dir, an empty environment (no credentials, no LLM),
# HOME/XDG and cwd inside it, a Paperless stub. The committed demo is never modified.
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
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/rechnung-projekt-$1.png" >/dev/null || fail "screenshot $1"
}


T_DB() { echo "$T/demo/ledger.db"; }
sql() { python3 -c '
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
print(";".join("|".join(map(str, r)) for r in db.execute(sys.argv[2]).fetchall()) or "none")
' "$(T_DB)" "$1"; }
cli() { ( cd "$T" && env -i LANG="${E2E_LANG:-de_DE.UTF-8}" PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data" \
    DOTENV_CONFIG_PATH="$T/empty.env" PAPERLESS_BASE_URL=http://127.0.0.1:$STUB_PORT PAPERLESS_API_TOKEN=demo \
    STEUER_DEMO=1 STEUER_WORKSPACE="$T/demo/steuererklaerung.json" TRANSACTIONS_DATA_DIR="$T/demo/transactions-data" \
    LEDGER_DB_PATH="$T/demo/ledger.db" "$GJSIFY" run "$APP/dist/steuer.gjs.mjs" "$@" ) 2>&1 | grep -v '^\$ GI_TYPELIB'; }

PROJEKT="Buchungssystem Segelschule"
PID="segelschule-buchung"
ENTRIES="'demo-t-6','demo-t-7','demo-t-8'"

mkdir -p "$T/home" "$T/cfg" "$T/data"
: > "$T/empty.env"
echo '{"name":"rechnung-projekt-e2e","private":true}' > "$T/package.json"
cp -r "$APP/demo" "$T/demo"
rm -f "$T"/demo/ledger.db*
rm -rf "$T/demo/transactions-data/documents"
cli demo seed > "$T/seed.log" || { tail -5 "$T/seed.log"; fail "demo seed"; }

# ── 1. A draft from the project's open hours ────────────────────────────────────────────────────────
cat > "$T/spec.json" <<'JSON'
{"contactId":"demo-c-segelschule","issueDate":"2026-10-09","dueDate":"2026-10-23","currency":"EUR","iban":"DE89370400440532013000","items":[]}
JSON
cli invoices self create "$T/spec.json" --entity gbr --projekt "$PID" --zeiten --stundensatz 90 --ust 0.19 > "$T/create.log" \
  || { tail -5 "$T/create.log"; fail "create draft from hours"; }
DRAFT="$(sql "SELECT id FROM invoices WHERE status='draft' AND contact_id='demo-c-segelschule'")"
[ "$DRAFT" != none ] || fail "no draft was created"
[ "$(sql "SELECT title||'='||quantity||'x'||unit_price_net||'/'||unit FROM invoice_items WHERE invoice_id='$DRAFT' ORDER BY position")" = "Konzept=4.25x90.0/Stunde;Umsetzung=2.5x90.0/Stunde" ] \
  || fail "lines: $(sql "SELECT title,quantity,unit_price_net FROM invoice_items WHERE invoice_id='$DRAFT'")"
[ "$(sql "SELECT performance_start||'..'||performance_end FROM invoices WHERE id='$DRAFT'")" = "2026-09-14..2026-09-16" ] || fail "Leistungszeitraum"
[ "$(sql "SELECT COUNT(*) FROM time_entries WHERE id IN ($ENTRIES) AND invoice_id IS NULL")" = "3" ] || fail "entries must stay open on a draft"
[ "$(sql "SELECT COUNT(*) FROM invoice_time_links WHERE invoice_id='$DRAFT'")" = "3" ] || fail "entries not reserved"
[ "$(sql "SELECT project_id FROM invoice_projects WHERE invoice_id='$DRAFT'")" = "$PID" ] || fail "draft not assigned to the project"
step "the draft has two hour lines (4,25 h + 2,5 h at 90 €), Leistungszeitraum 14.–16.9.; the entries are reserved but still open"

# ── 2. Finalize bills the hours — and only finalize ──────────────────────────────────────────────────
launch STEUER_APP_VIEW=rechnungen
await "Segelschule Nordwind"
click "ausgestellt 09.10.2026" AdwActionRow
await "Konzept"
await "Umsetzung"
await "$PROJEKT"
await "direkt zugeordnet"
step "the draft's detail shows the hour lines and the project row „direkt zugeordnet“"
shot detail
[ "$(sql "SELECT COUNT(*) FROM time_entries WHERE id IN ($ENTRIES) AND invoice_id IS NULL")" = "3" ] || fail "opening must not bill"
click "Festschreiben" AdwButtonRow
await "Rechnung festschreiben"
click "Festschreiben" GtkButton
for _ in $(seq 1 30); do [ "$(sql "SELECT COUNT(*) FROM time_entries WHERE id IN ($ENTRIES) AND invoice_id='$DRAFT'")" = "3" ] && break; sleep 0.5; done
[ "$(sql "SELECT COUNT(*) FROM time_entries WHERE id IN ($ENTRIES) AND invoice_id='$DRAFT'")" = "3" ] || fail "entries not billed after finalize: $(sql "SELECT id,invoice_id FROM time_entries WHERE id IN ($ENTRIES)")"
[ "$(sql "SELECT COUNT(*) FROM invoice_time_links WHERE invoice_id='$DRAFT'")" = "0" ] || fail "reservation not cleared"
[ "$(sql "SELECT status FROM invoices WHERE id='$DRAFT'")" = "open" ] || fail "invoice not finalized"
step "„Festschreiben“ bills the three entries on the invoice and drops the reservation"
stop_app

# ── 3. Assign the flat-fee invoice ───────────────────────────────────────────────────────────────────
FLAT="$(sql "SELECT number FROM invoices i JOIN invoice_items t ON t.invoice_id=i.id WHERE t.title='Pauschale Einrichtung Buchungssystem'")"
[ "$FLAT" != none ] || fail "no flat-fee invoice in the demo"
[ "$(sql "SELECT COUNT(*) FROM invoice_projects")" = "1" ] || fail "only the draft should be assigned so far"
launch STEUER_APP_VIEW=rechnungen STEUER_APP_INVOICE_DETAIL="$FLAT"
await "Pauschale Einrichtung Buchungssystem"
await "Kein Projekt"
click "Zuordnen …" GtkButton
await "Projekt wählen"
click "$PROJEKT" AdwActionRow
for _ in $(seq 1 20); do [ "$(sql "SELECT COUNT(*) FROM invoice_projects")" = "2" ] && break; sleep 0.5; done
[ "$(sql "SELECT project_id FROM invoice_projects i JOIN invoices v ON v.id=i.invoice_id WHERE v.number='$FLAT'")" = "$PID" ] || fail "flat fee not assigned"
[ "$(sql "SELECT group_concat(action) FROM audit_log WHERE action LIKE 'rechnung_projekt.%'")" = "rechnung_projekt.assign,rechnung_projekt.assign" ] || fail "log: $(sql "SELECT action FROM audit_log WHERE action LIKE 'rechnung_projekt.%'")"
await "direkt zugeordnet"
await "Zuordnung aufheben"
step "the flat-fee invoice is assigned from its detail; the decision is stored and logged as rechnung_projekt.assign"

# ── 4. The project counts it ─────────────────────────────────────────────────────────────────────────
KEEP=1 launch STEUER_APP_VIEW=projekte
await "$PROJEKT"
await "Ergebnis 2026: 1.207,50"
click "$PROJEKT" AdwActionRow
await "Projektergebnis 2026"
await "1.207,50"
await "6,75 h erfasst"
await "$FLAT"
ui texts | grep -F "über Zeiten" >&2 && fail "both invoices are assigned directly"
[ "$(ui texts | grep "^AdwActionRow.*direkt zugeordnet" | sort -u | wc -l)" = 2 ] || fail "expected two directly assigned invoices"
step "Projektergebnis: Umsatz 600 + 607,50 = 1.207,50 €, the flat fee counts although no hour is behind it; 6,75 h"
shot ergebnis

echo "rechnung-projekt e2e: all steps passed"
