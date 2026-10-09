#!/usr/bin/env bash
# End-to-end check of „Zu prüfen" + „Regel aus Auswahl" (Idee 6) against the demo workspace — drives the
# real desktop app over the devtools D-Bus plane, like hinweise-e2e.sh.
#
#   app/dev/zu-pruefen-e2e.sh [shots-dir]     (build first: gjsify run build:gjs build:app)
#
# The demo's rent is only classified by the generic keyword „Miete" — an Auffangregel — so every month
# of it is in the queue. The run confirms one (progress advances, the ledger holds a confirmation and
# no override), marks two more, builds a rule from them, deselects one hit in the preview and saves (the
# manifest holds the rule with that exception, the rest leave the queue), and checks the booking sheet:
# „via Regel …" for a rule-classified booking, „Umbuchung zurücknehmen" with „Danach gilt wieder: …"
# for one booked by hand. With a shots-dir the pictures are written there as zu-pruefen-tab.png,
# zu-pruefen-regel.png and zu-pruefen-buchung.png.
#
# A LOCKED or blanked screen stops the frame clock (see frei-verfuegbar-e2e.sh); then run it on a private
# headless compositor: `dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11
# --virtual-monitor 1400x1100 --wayland-display e2e-wl & sleep 2; WAYLAND_DISPLAY=e2e-wl DISPLAY=
# app/dev/zu-pruefen-e2e.sh <shots-dir>'`.
#
# PRIVACY: same isolation as hinweise-e2e.sh — a COPY of app/demo in a throwaway dir, an empty
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

fail() {
  echo "FAIL: $*" >&2
  [ -f "$T/log" ] && grep -v "^\$" "$T/log" | tail -5 >&2
  [ -n "${E2E_DUMP:-}" ] && [ -n "${ID:-}" ] && ui texts > "$E2E_DUMP" 2>&1
  exit 1
}
step() { echo "ok: $*"; }

# One demo copy for the whole run — the steps build on each other's writes.
cp -r "$APP/demo" "$T/demo"
rm -f "$T"/demo/ledger.db*
rm -rf "$T/demo/transactions-data/documents"
mkdir -p "$T/home" "$T/cfg" "$T/data"
: > "$T/empty.env"
echo '{"name":"zu-pruefen-e2e","private":true}' > "$T/package.json"

ENV=(PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data"
  DOTENV_CONFIG_PATH="$T/empty.env" PAPERLESS_BASE_URL=http://127.0.0.1:$STUB_PORT PAPERLESS_API_TOKEN=demo
  STEUER_DEMO=1 STEUER_WORKSPACE="$T/demo/steuererklaerung.json" TRANSACTIONS_DATA_DIR="$T/demo/transactions-data"
  LEDGER_DB_PATH="$T/demo/ledger.db")

cli() { ( cd "$T" && env -i "${ENV[@]}" "$GJSIFY" run "$APP/dist/steuer.gjs.mjs" "$@" ) 2>&1 | grep -v '^\$ GI_TYPELIB'; }

launch() {
  stop_app
  ID="eu.jumplink.Steuererklaerung.E2e$$x$RANDOM"
  OBJ="/$(printf '%s' "$ID" | tr . /)/devtools"
  ( cd "$T" && exec setsid env -i "${ENV[@]}" \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
      WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" DISPLAY="${DISPLAY:-:0}" \
      GJSIFY_DEVTOOLS=1 STEUER_APP_ID="$ID" STEUER_APP_SIZE="1400 1000" STEUER_APP_ENTITY=gbr STEUER_APP_YEAR=2025 "$@" \
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
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/zu-pruefen-$1.png" >/dev/null || fail "screenshot $1"
}

# Read what the app persisted — the ledger row and the manifest, not what it drew.
ledger_row() {
  python3 -c '
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
r = db.execute("SELECT source, status, category FROM classifications WHERE transaction_id = ?", (sys.argv[2],)).fetchone()
print("|".join(map(str, r)) if r else "none")
' "$T/demo/ledger.db" "$1"
}
regeln() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(JSON.stringify(m.entities.find((e) => e.id === "gbr").elster.klassifizierung?.aufwand_regeln ?? []));
  ' "$T/demo/steuererklaerung.json"
}
progress() { ui texts | grep -oE '[0-9]+ von [0-9]+ geprüft' | head -1; }

MIETE="Hausverwaltung Musterstadt"

# A booking booked by hand beforehand (the CLI's reclassify) — the sheet must offer to take it back.
cli elster reclassify --tx demo-qonto-8 --category "4940 Fortbildung/Fachliteratur" --by e2e >/dev/null \
  || fail "could not seed the manual decision"

# ── 1. The tab: the queue, confirm one → progress advances ─────────────────────────────────────────
launch STEUER_APP_VIEW=transactions STEUER_APP_TAB=zu-pruefen
await "Regel aus Auswahl"
await "nur Auffangregel"
START="$(progress)"
case "$START" in "0 von "*) ;; *) fail "unexpected start progress: $START" ;; esac
step "the Zu prüfen tab lists the queue ($START)"
# Newest first: the demo's newer unclassified bookings (Pixelkraft, Stripe, Cloud-Provider, Hetzner), then the
# December rent — step on until it shows rather than counting, so a new demo booking does not break the run.
for _ in $(seq 1 12); do
  ui has "via Regel „Stichwort miete“ (Auffangregel)" && break
  click click-tip "Nächste Buchung"
done
await "via Regel „Stichwort miete“ (Auffangregel)"
click "Bestätigen und weiter" GtkButton
await "1 von ${START#0 von }"
[ "$(ledger_row demo-qonto-12)" = "rule|confirmed|4210 Miete/Raumkosten" ] \
  || fail "confirmation not stored as expected: $(ledger_row demo-qonto-12)"
# The seeded Umbuchung is the only manual one — the confirmation must not have become a second.
# Into a file first: `cli … | grep -q` under pipefail fails with SIGPIPE once the report outgrows one pipe write.
cli elster euer report --entity gbr --year 2025 --by transactions > "$T/euer-report.txt"
grep -q "manuell: 1" "$T/euer-report.txt" || fail "a confirmation became a manual override"
step "Bestätigen advances the progress and stores a confirmation, not an override"
shot tab

# ── 2. Regel aus Auswahl: two rent bookings → preview → deselect one → save ────────────────────────
click click-tip "markieren: $MIETE · 01.11.2025"
click click-tip "markieren: $MIETE · 01.10.2025"
await "Regel aus Auswahl (2)"
click "Regel aus Auswahl (2)" GtkButton
await "Trifft "
await "4210 Miete/Raumkosten"
ui has "Erfassen: 01.08.2025" && fail "the manually booked rent must not be a hit"
click click-tip "Erfassen: 01.09.2025"
step "the preview lists the hits and a hit can be deselected"
shot regel
click "Regel speichern" GtkButton
absent "Regel speichern"
regeln | grep -q '"muster":"Hausverwaltung Musterstadt","kategorie":"4210 Miete/Raumkosten","ausnahmen":\["demo-qonto-9"\]' \
  || fail "rule not in the manifest as expected: $(regeln)"
cli buchungen zu-pruefen --entity gbr --year 2025 --json > "$T/queue.json"
node -e '
  const q = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ids = q.filter((r) => (r.counterparty ?? "").includes("Hausverwaltung")).map((r) => r.id);
  if (ids.join() !== "demo-qonto-9") { console.error("rent still queued: " + ids.join()); process.exit(1); }
' "$T/queue.json" || fail "the rule's hits did not leave the queue (only the exception may stay)"
step "the rule is saved with its exception and its hits left the queue"

# ── 3. The booking sheet: which rule, and taking an Umbuchung back ─────────────────────────────────
launch STEUER_APP_VIEW=transactions STEUER_APP_SEARCH="$MIETE" STEUER_APP_TX_DETAIL=1
await "via Regel „Hausverwaltung Musterstadt“"
step "the booking sheet names the rule that classified it"
launch STEUER_APP_VIEW=transactions STEUER_APP_SEARCH="Fortbildung" STEUER_APP_TX_DETAIL=1
await "Umbuchung zurücknehmen"
await "Danach gilt wieder: via Regel „Hausverwaltung Musterstadt“ → 4210 Miete/Raumkosten."
step "„Umbuchung zurücknehmen“ says what applies afterwards"
shot buchung
click click-tip "Umbuchung zurücknehmen:"
for _ in $(seq 1 20); do [ "$(ledger_row demo-qonto-8)" = "none" ] && break; sleep 0.5; done
[ "$(ledger_row demo-qonto-8)" = "none" ] || fail "decision not removed: $(ledger_row demo-qonto-8)"
step "taking it back removes the manual decision"

# ── 4. Als Nächstes: one task that opens the tab ───────────────────────────────────────────────────
launch STEUER_APP_VIEW=home
await "Als Nächstes"
await "Buchungen zu prüfen"
absent "unklassifizierte Buchung(en)"
click "Buchungen zu prüfen" AdwActionRow
await "Regel aus Auswahl"
step "Als Nächstes has one Zu-prüfen task (no separate unclassified one) and it opens the tab"

echo "zu-pruefen e2e: all steps passed"
