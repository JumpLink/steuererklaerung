#!/usr/bin/env bash
# End-to-end check of the E-Rechnung badge against the demo workspace — drives the real desktop app
# over the devtools D-Bus plane, like doppelzahlung-e2e.sh.
#
#   app/dev/e-rechnung-e2e.sh [shots-dir]     (build first: gjsify run build:app)
#
# The demo's built-in DMS holds one hybrid-PDF Beleg (invented "Büro Nordlicht GmbH") whose XRechnung is
# read on seeding without any AI, plus plain PDFs that are classified "sonstige Rechnung". The Beleg-
# Eingang detail must name both kinds with their reason line. With a shots-dir the picture is written
# there as e-rechnung-beleg-eingang.png.
#
# PRIVACY: same isolation as doppelzahlung-e2e.sh — a COPY of app/demo in a throwaway dir, an empty
# environment (no credentials, no LLM), HOME/XDG and cwd inside it, and a Paperless stub that answers
# every request with an empty list. The copy's ledger and Beleg files are deleted first, so the seed
# runs fresh and picks up the e-invoice Beleg; the committed demo is never modified.
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
  rm -rf "$T/demo" "$T/home"
  cp -r "$APP/demo" "$T/demo"
  rm -f "$T"/demo/ledger.db*
  rm -rf "$T/demo/transactions-data/documents"
  mkdir -p "$T/home" "$T/cfg" "$T/data"
  : > "$T/empty.env"
  echo '{"name":"e-rechnung-e2e","private":true}' > "$T/package.json"
  ID="eu.jumplink.Steuererklaerung.E2e$$x$RANDOM"
  OBJ="/$(printf '%s' "$ID" | tr . /)/devtools"
  ( cd "$T" && exec setsid env -i PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data" \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
      WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" DISPLAY="${DISPLAY:-:0}" \
      DOTENV_CONFIG_PATH="$T/empty.env" PAPERLESS_BASE_URL=http://127.0.0.1:$STUB_PORT PAPERLESS_API_TOKEN=demo GJSIFY_DEVTOOLS=1 STEUER_APP_ID="$ID" STEUER_DEMO=1 \
      STEUER_WORKSPACE="$T/demo/steuererklaerung.json" TRANSACTIONS_DATA_DIR="$T/demo/transactions-data" \
      LEDGER_DB_PATH="$T/demo/ledger.db" STEUER_APP_SIZE="1280 860" STEUER_APP_ENTITY=gbr "$@" \
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

launch STEUER_APP_VIEW=review STEUER_APP_TAB=eingang STEUER_APP_YEAR=2026 STEUER_APP_SIZE="1280 1000"
await "Büro Nordlicht GmbH"
await "XRechnung-Datensatz im PDF — gilt als E-Rechnung."
step "Beleg-Eingang shows the hybrid PDF as E-Rechnung with its reason"
if [ -n "$SHOTS" ]; then
  mkdir -p "$SHOTS"
  sleep 1.5
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/e-rechnung-beleg-eingang.png" >/dev/null || fail "screenshot"
fi

echo "e-rechnung e2e: all steps passed"
