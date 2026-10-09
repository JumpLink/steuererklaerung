#!/usr/bin/env bash
# End-to-end check of the "Frei verfügbar" and "Steuerrücklage" cards on the Übersicht against the demo
# workspace — drives the real desktop app over the devtools D-Bus plane, like doppelzahlung-e2e.sh.
#
#   app/dev/frei-verfuegbar-e2e.sh [shots-dir]     (build first: gjsify run build:app)
#
# The demo register holds Q1/2026 filed and paid and Q2/2026 filed but unpaid, so the Herleitung must
# count the USt from Q3 on and deduct the overdue Q2 Zahllast. The GbR's Einkommensteuer belongs to the
# partners, so the Rücklage names that term as "entfällt". With a shots-dir the pictures are written
# there as frei-verfuegbar-home.png and frei-verfuegbar-herleitung.png.
#
# A LOCKED or blanked screen stops the frame clock: the dialog is built but never mapped, and the run
# fails at "Zusammensetzung" (doppelzahlung-e2e.sh fails the same way). Then run it on a private
# headless compositor: `dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11
# --virtual-monitor 1400x1100 --wayland-display e2e-wl & sleep 2; WAYLAND_DISPLAY=e2e-wl DISPLAY=
# app/dev/frei-verfuegbar-e2e.sh <shots-dir>'`.
#
# PRIVACY: same isolation as doppelzahlung-e2e.sh — a COPY of app/demo in a throwaway dir, an empty
# environment (no credentials, no LLM), HOME/XDG and cwd inside it, and a Paperless stub that answers
# every request with an empty list. The copy's ledger and Beleg files are deleted first, so the seed
# runs fresh and writes the demo filings; the committed demo is never modified.
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
  echo '{"name":"frei-verfuegbar-e2e","private":true}' > "$T/package.json"
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
click() { ui click "$@" >/dev/null || fail "cannot click \"$1\""; sleep 1.5; }
shot() {
  [ -z "$SHOTS" ] && return 0
  mkdir -p "$SHOTS"
  sleep 1.5
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/frei-verfuegbar-$1.png" >/dev/null || fail "screenshot $1"
}

# ── 1. Übersicht: both cards, with the Lernmodus "?" ──────────────────────────────────────────────
# 1000 px tall: the Herleitung dialog then leaves the "Demodaten" banner visible in the screenshot.
launch STEUER_APP_VIEW=home STEUER_APP_YEAR=2026 STEUER_APP_LERNMODUS=1 STEUER_APP_SIZE="1280 1000"
await "Frei verfügbar"
await "Steuerrücklage 2026 (Schätzung)"
await "eine Rechnung, keine Empfehlung"
step "home shows Frei verfügbar and the Steuerrücklage"
shot home

# ── 2. Frei verfügbar → Herleitung with all four terms → one term's lines ──────────────────────────
click "Herleitung: Frei verfügbar" GtkButton
await "Zusammensetzung"
await "Kontostand"
await "USt seit der letzten Voranmeldung"
await "Fällige Steuerzahlungen (30 Tage)"
await "Offene Eingangsrechnungen"
step "the card opens the Herleitung with every term"
shot herleitung
# The formula in the header row names every term too — match the term row by its title + subtitle.
click "USt seit der letzten Voranmeldung | Vereinnahmte" AdwActionRow
await "Letzte Voranmeldung im Register: Q2/2026"
step "the USt is counted from the day after the last filed Voranmeldung"

launch STEUER_APP_VIEW=home STEUER_APP_YEAR=2026
await "Frei verfügbar"
click "Herleitung: Frei verfügbar" GtkButton
click "Fällige Steuerzahlungen (30 Tage)" AdwActionRow
await "USt-VA Q2/2026 — Zahllast"
await "überfällig seit"
step "the overdue Q2 Zahllast is deducted, with its due date"

# ── 3. Steuerrücklage → Herleitung ─────────────────────────────────────────────────────────────────
launch STEUER_APP_VIEW=home STEUER_APP_YEAR=2026
await "Steuerrücklage 2026 (Schätzung)"
click "Herleitung: Steuerrücklage 2026 (Schätzung)" GtkButton
await "Entfällt, weil die Gesellschafter ihre Einkommensteuer persönlich zahlen"
await "Gewerbesteuer 2026 (Schätzung)"
step "the Rücklage names the partners' ESt as not applicable and shows the GewSt estimate"

echo "frei-verfuegbar e2e: all steps passed"
