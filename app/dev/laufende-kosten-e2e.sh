#!/usr/bin/env bash
# End-to-end check of „Laufende Kosten erkennen" (Idee 8) against the demo workspace — drives the real
# desktop app over the devtools D-Bus plane, like geld-pruefungen-e2e.sh.
#
#   app/dev/laufende-kosten-e2e.sh [shots-dir]     (build first: gjsify run build:gjs build:app)
#
# The demo GbR has nine series: monthly rent, hosting, telephone, cloud and bank fee, the Pixelkraft
# design suite that got dearer in 2026, the yearly Hanse Betriebshaftpflicht over three years, and two
# half-yearly ones that stopped („beendet?"). The run checks the tab lists them; confirms the rent → it
# leaves the proposals and shows under „Bestätigt" with its next date; rejects KI-Labs → gone from the
# proposals, kept after a restart, read back from the manifest the app wrote; opens a payment from a
# series; then Frei verfügbar's Herleitung shows the new term with the first-version figure, and Als
# Nächstes the one counting task. With a shots-dir the pictures are written there as
# laufende-kosten-review.png and laufende-kosten-frei-verfuegbar.png.
#
# A LOCKED or blanked screen stops the frame clock (see frei-verfuegbar-e2e.sh); then run it on a private
# headless compositor: `dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11
# --virtual-monitor 1400x1100 --wayland-display e2e-wl & sleep 2; WAYLAND_DISPLAY=e2e-wl DISPLAY=
# app/dev/laufende-kosten-e2e.sh <shots-dir>; kill %1'`.
#
# PRIVACY: same isolation as geld-pruefungen-e2e.sh — a COPY of app/demo in a throwaway dir, an empty
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
  echo '{"name":"laufende-kosten-e2e","private":true}' > "$T/package.json"
  ID="eu.jumplink.Steuererklaerung.E2e$$x$RANDOM"
  OBJ="/$(printf '%s' "$ID" | tr . /)/devtools"
  ( cd "$T" && exec setsid env -i LANG="${E2E_LANG:-de_DE.UTF-8}" PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data" \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
      WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" DISPLAY="${DISPLAY:-:0}" \
      DOTENV_CONFIG_PATH="$T/empty.env" PAPERLESS_BASE_URL=http://127.0.0.1:$STUB_PORT PAPERLESS_API_TOKEN=demo GJSIFY_DEVTOOLS=1 STEUER_APP_ID="$ID" STEUER_DEMO=1 \
      STEUER_WORKSPACE="$T/demo/steuererklaerung.json" TRANSACTIONS_DATA_DIR="$T/demo/transactions-data" \
      LEDGER_DB_PATH="$T/demo/ledger.db" STEUER_APP_SIZE="1280 900" STEUER_APP_ENTITY=gbr "$@" \
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
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/laufende-kosten-$1.png" >/dev/null || fail "screenshot $1"
}

# Read what the app persisted — the manifest it wrote, not what it drew.
decisions() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(JSON.stringify(m.entities.find((e) => e.id === "gbr").laufende_kosten ?? []));
  ' "$T/demo/steuererklaerung.json"
}

MIETE="Hausverwaltung Musterstadt"
TAB=(STEUER_APP_VIEW=transactions STEUER_APP_TAB=laufende-kosten STEUER_APP_YEAR=2026)

# ── 1. The tab lists the proposals ───────────────────────────────────────────────────────────────────
launch "${TAB[@]}"
await "9 laufende Kosten zu bestätigen"
await "$MIETE"
await "Pixelkraft Software GmbH"
await "Preisänderung am 14.01.2026: 29,75"
await "Hanse Versicherung AG"
await "jährlich · zuletzt 02.03.2026 · nächste 02.03.2027"
await "beendet? — seit über 1,5 Abständen keine Zahlung"
step "the tab lists nine series with interval, last and next payment, the price change and the stopped ones"
shot review

# ── 2. Confirm the rent → leaves the proposals, shows under „Bestätigt" with its next date ────────────
click click-tip "Bestätigen: $MIETE"
await "8 laufende Kosten zu bestätigen"
await "Bestätigt"
await "monatlich · zuletzt 01.06.2026 · nächste 01.07.2026"
decisions | grep -q '"key":"hausverwaltungmusterstadt:monatlich","status":"bestaetigt"' \
  || fail "confirmation not in the manifest: $(decisions)"
step "„Bestätigen“ moves the rent to Bestätigt with its next date and stores it"

# A series unfolds into its payments; a payment opens the booking.
click "$MIETE" AdwActionRow
await "01.06.2026"
click "01.06.2026 | $MIETE" AdwActionRow
await "Verwendungszweck"
await "Miete Büro Musterstraße 1"
step "a series shows its payments, and a payment opens the booking"

# ── 3. „Keine laufenden Kosten" → gone from the proposals, and stays gone ──────────────────────────────
KEEP=1 launch "${TAB[@]}"
await "8 laufende Kosten zu bestätigen"
click click-tip "Keine laufenden Kosten: KI-Labs LLC"
await "7 laufende Kosten zu bestätigen"
await "Keine laufenden Kosten"
decisions | grep -q '"key":"kilabsllc:halbjaehrlich","status":"abgelehnt"' || fail "rejection not in the manifest: $(decisions)"
click click-tip "Bestätigen: Pixelkraft Software GmbH"
await "6 laufende Kosten zu bestätigen"
KEEP=1 launch "${TAB[@]}"
await "6 laufende Kosten zu bestätigen"
ui texts | grep -F "Bestätigen: KI-Labs" && fail "KI-Labs is a proposal again after the restart"
step "„Keine laufenden Kosten“ removes KI-Labs from the proposals, also after a restart"

# ── 4. Frei verfügbar: the new term with the first-version figure ─────────────────────────────────────
KEEP=1 launch STEUER_APP_VIEW=home STEUER_APP_YEAR=2026 STEUER_APP_SIZE="1280 1000"
await "Frei verfügbar"
await "6 laufende Kosten zu bestätigen"
step "Als Nächstes counts the open series in one task"
click "Herleitung: Frei verfügbar" GtkButton
await "Zusammensetzung"
await "Laufende Kosten (nächste 30 Tage)"
click "Laufende Kosten (nächste 30 Tage) | Bestätigte" AdwActionRow
await "Frei verfügbar ohne laufende Kosten (erste Fassung)"
await "$MIETE"
await "Pixelkraft Software GmbH"
await "6 erkannte Serien noch nicht bestätigt"
await "nach dem letzten Import"
await "Umsätze nur bis 15.07.2026 importiert"
step "the Herleitung shows the laufende Kosten term with each expected payment and the first-version figure"
shot frei-verfuegbar

# ── 5. The task opens the tab ───────────────────────────────────────────────────────────────────────
KEEP=1 launch STEUER_APP_VIEW=home STEUER_APP_YEAR=2026
await "6 laufende Kosten zu bestätigen"
click "6 laufende Kosten zu bestätigen" AdwActionRow
await "Bestätigt"
await "Keine laufenden Kosten"
step "the Als-Nächstes task opens the Laufende-Kosten tab"

echo "laufende-kosten e2e: all steps passed"
