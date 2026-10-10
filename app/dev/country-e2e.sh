#!/usr/bin/env bash
# End-to-end check of the per-entity German tax switch (ADR 0001) against the demo workspace — drives
# the real desktop app over the devtools D-Bus plane, like projekte-e2e.sh.
#
#   app/dev/country-e2e.sh [shots-dir]     (build first: gjsify run build:gjs, then gjsify run build:app)
#
# The run, on the demo GbR:
#   1. opens Settings → Land & Steuern; the Steuer area is in the sidebar;
#   2. switches „Deutsche Steuerfunktionen" off, confirms the dialog; the Steuer area is gone at once,
#      Settings stays open, and the manifest differs from the start by `"taxModule": "none"` only;
#   3. restarts on Buchungen: still no Steuer area, and the bookings still carry their categories;
#   4. restarts on Settings, switches the features back on (no dialog): the Steuer area returns, and the manifest is byte
#      for byte what it was at the start.
# With a shots-dir the pictures are written there as country-switch.png and country-tax-off.png
# (`-en` appended under E2E_LANG=en_US.UTF-8).
#
# The demo manifest is not in the app's own write format (JSON.stringify, two spaces), so the copy
# is normalised to it first; otherwise the first write would reformat the whole file and the byte
# comparison in step 4 would compare formatting, not the switch.
#
# A LOCKED or blanked screen stops the frame clock (see frei-verfuegbar-e2e.sh); then run it on a private
# headless compositor: `dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11
# --virtual-monitor 1400x1100 --wayland-display e2e-wl & sleep 2; WAYLAND_DISPLAY=e2e-wl DISPLAY=
# app/dev/country-e2e.sh <shots-dir>; kill %1'`.
#
# PRIVACY: same isolation as projekte-e2e.sh — a COPY of app/demo in a throwaway dir, an empty
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

case "${E2E_LANG:-de_DE.UTF-8}" in
  en*)
    SUFFIX=-en GROUP="Country & taxes" SWITCH="German tax features" CONFIRM="Turn off German tax features?"
    OFF="Turn off" TAX_NAV="Return · EÜR · USt-VA · account" BOOKINGS="Transactions"
    ;;
  *)
    SUFFIX="" GROUP="Land & Steuern" SWITCH="Deutsche Steuerfunktionen" CONFIRM="Deutsche Steuerfunktionen ausschalten?"
    OFF="Ausschalten" TAX_NAV="Erklärung · EÜR · USt-VA · Konto" BOOKINGS="Buchungen"
    ;;
esac

launch() {
  stop_app
  if [ -z "${KEEP:-}" ]; then
    rm -rf "$T/demo" "$T/home"
    cp -r "$APP/demo" "$T/demo"
    rm -f "$T"/demo/ledger.db-*
    node -e 'const f=process.argv[1],fs=require("fs");fs.writeFileSync(f,JSON.stringify(JSON.parse(fs.readFileSync(f,"utf8")),null,2)+"\n")' \
      "$T/demo/steuererklaerung.json"
    cp "$T/demo/steuererklaerung.json" "$T/start.json"
  fi
  mkdir -p "$T/home" "$T/cfg" "$T/data"
  : > "$T/empty.env"
  echo '{"name":"country-e2e","private":true}' > "$T/package.json"
  ID="eu.jumplink.Steuererklaerung.E2e$$x$RANDOM"
  OBJ="/$(printf '%s' "$ID" | tr . /)/devtools"
  ( cd "$T" && exec setsid env -i LANG="${E2E_LANG:-de_DE.UTF-8}" PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data" \
      XDG_STATE_HOME="$T/home/.local/state" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
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
  ui texts 2>/dev/null | grep -F "${1:0:10}" | head -5 | cut -c1-200 >&2 || true
  fail "never saw \"$1\""
}
absent() {
  for _ in $(seq 1 40); do ui has "$1" || return 0; sleep 0.5; done
  fail "\"$1\" is still there"
}
click() {
  ui click "$@" >/dev/null || fail "cannot click \"$1\""
  sleep 1.5
}
shot() {
  [ -z "$SHOTS" ] && return 0
  mkdir -p "$SHOTS"
  sleep 1.5
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/country-$1$SUFFIX.png" >/dev/null || fail "screenshot $1"
}

# What the app persisted for the demo GbR — the file, not what it drew.
gbr_field() {
  python3 -c '
import json, sys
m = json.load(open(sys.argv[1]))
e = next(e for e in m["entities"] if e["id"] == "gbr")
print(e.get(sys.argv[2], "-"))
' "$T/demo/steuererklaerung.json" "$1"
}
# The current manifest equals the start once the switch field is dropped again.
only_switch_differs() {
  python3 -c '
import json, sys
now, start = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
for e in now["entities"]:
    if e["id"] == "gbr": e.pop("taxModule", None)
sys.exit(0 if now == start else 1)
' "$T/demo/steuererklaerung.json" "$T/start.json"
}

# ── 1. Settings → Land & Steuern; the Steuer area is there ──────────────────────────────────────────
launch STEUER_APP_VIEW=settings
await "$GROUP"
await "$TAX_NAV"
[ "$(gbr_field taxModule)" = "-" ] || fail "the demo GbR already carries taxModule"
step "settings show $GROUP, the Steuer area is in the sidebar"
shot switch

# ── 2. Switch off, confirm: the Steuer area goes, Settings stays, one field changes ─────────────────
click "$SWITCH" AdwSwitchRow
await "$CONFIRM"
click "$OFF" GtkButton
absent "$TAX_NAV"
await "$GROUP"
[ "$(gbr_field taxModule)" = "none" ] || fail "taxModule is \"$(gbr_field taxModule)\", want none"
only_switch_differs || fail "the manifest changed beyond taxModule"
step "tax off: Steuer area gone, Settings still open, manifest = start + taxModule none"

# ── 3. Restart on Buchungen: still off, categories still there ──────────────────────────────────────
KEEP=1 launch STEUER_APP_VIEW=transactions
await "$BOOKINGS"
absent "$TAX_NAV"
await "${CATEGORY:-Fremdleistungen}"
step "after restart: no Steuer area, bookings still categorised"
shot tax-off

# ── 4. Switch back on: no dialog, the Steuer area returns, the file is the start again ──────────────
KEEP=1 launch STEUER_APP_VIEW=settings
await "$GROUP"
click "$SWITCH" AdwSwitchRow
await "$TAX_NAV"
cmp -s "$T/demo/steuererklaerung.json" "$T/start.json" || fail "the manifest is not byte-identical to the start"
step "tax on again: Steuer area back, manifest byte-identical to the start"

grep -aiE "CRITICAL|TypeError|ReferenceError" "$T/log" | head -5 >&2 && fail "errors in the app log" || true
echo "country-e2e: all steps passed"
