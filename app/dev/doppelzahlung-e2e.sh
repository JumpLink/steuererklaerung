#!/usr/bin/env bash
# End-to-end check of the Doppelzahlung dialogs against the demo workspace — drives the real desktop
# app over the devtools D-Bus plane and asserts on widget text and on the config it wrote.
#
#   app/dev/doppelzahlung-e2e.sh [shots-dir]     (build first: gjsify run build:app)
#
# Flow, on the demo's two invented cases (full duplicate on RE-2025-0004, partial overpayment of
# 100 € on RE-2026-0003):
#   1. Steuer → Zusammenfassung 2025 shows "Vor der Abgabe klären"
#   2. Übersicht 2025/2026: the "Als Nächstes" task is listed and opens the invoice (warning group there)
#   3. "Ist eine Doppelzahlung" → "Rückzahlung offen"; "Außerhalb zurückgezahlt" → refund closed
#   4. Übersicht 2026: on the partial case "Ist eine Doppelzahlung" is refused with a German error
#      dialog; "Ist in Ordnung" makes the suspicion disappear
# The decisions run through the dialog opened by STEUER_APP_INVOICE_DETAIL, not through the home task:
# devtools' ActivateWidget fires an AdwActionRow's `activated` TWICE (the row's own activate() and then
# the list box's row-activated fallback), which stacks two dialogs — a rig artifact, so the task is only
# proven to open the warning and then the flow restarts on a single dialog.
# With a shots-dir the documentation screenshots are written there (doppelzahlung-*.png).
#
# PRIVACY: the app runs on a COPY of app/demo in a throwaway dir, with an empty environment (no
# credentials), HOME/XDG and cwd pointed into that dir, and dotenv aimed at an empty file — it cannot
# read the real steuererklaerung.json / buchhaltung.json / .env, and the committed demo is never
# modified. The demo accounts are files, so nothing reaches Qonto. The Steuer view asks Paperless even
# for the built-in DMS, so PAPERLESS_BASE_URL points at a local stub that answers every request with an
# empty result list — a real Paperless is unreachable.
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

# Empty-Paperless stub on a free local port.
cat > "$T/stub.py" <<'PY'
import http.server, json, sys
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

# launch <STEUER_APP_* env…> — a fresh copy of the demo per launch, so each flow starts from the seed.
launch() {
  stop_app
  rm -rf "$T/demo" "$T/home"
  cp -r "$APP/demo" "$T/demo"
  mkdir -p "$T/home" "$T/cfg" "$T/data"
  : > "$T/empty.env"
  echo '{"name":"doppelzahlung-e2e","private":true}' > "$T/package.json"
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

# await <text> — poll until a mapped widget shows it (a fixed sleep is how this rig lies).
await() {
  for _ in $(seq 1 40); do ui has "$1" && return 0; sleep 0.5; done
  fail "never saw \"$1\""
}
absent() {
  for _ in $(seq 1 40); do ui has "$1" || return 0; sleep 0.5; done
  ui texts | grep -F "$1" >&2; fail "\"$1\" is still there"
}
click() { ui click "$@" >/dev/null || fail "cannot click \"$1\""; sleep 1.5; }

shot() {
  [ -z "$SHOTS" ] && return 0
  mkdir -p "$SHOTS"
  sleep 1.5
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/doppelzahlung-$1.png" >/dev/null || fail "screenshot $1"
}

# Read what the app persisted — the config it wrote, not what it drew.
adjustments() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const a = m.entities.find((e) => e.id === "gbr").elster?.adjustments ?? {};
    console.log(JSON.stringify(a[process.argv[2]] ?? []));
  ' "$T/demo/steuererklaerung.json" "$1"
}

# ── 1. Absenden ────────────────────────────────────────────────────────────────────────────────
# A taller window: the group sits under the fold of an 860 px one.
launch STEUER_APP_VIEW=steuer STEUER_APP_YEAR=2025 STEUER_APP_STEP=zusammenfassung STEUER_APP_SIZE="1280 1100"
await "Vor der Abgabe klären"
step "Absenden warns before filing 2025"
shot absenden

# ── 2./3. Full duplicate on RE-2025-0004 ───────────────────────────────────────────────────────
launch STEUER_APP_VIEW=home STEUER_APP_YEAR=2025
await "Rechnung RE-2025-0004 doppelt bezahlt?"
step "home lists the task for RE-2025-0004"
shot home
click "Rechnung RE-2025-0004 doppelt bezahlt?" AdwActionRow
await "1 Zahlung zu viel eingegangen — 285,60 €"
step "task opens the invoice dialog with the warning"

launch STEUER_APP_VIEW=rechnungen STEUER_APP_YEAR=2025 STEUER_APP_INVOICE_DETAIL=RE-2025-0004
await "1 Zahlung zu viel eingegangen — 285,60 €"
click "03.12.2025 · 285,60 €" AdwExpanderRow
await "Ist eine Doppelzahlung"
await "Gehört zu einer anderen Rechnung"
await "Ist in Ordnung"
step "expander offers the three decisions"
shot rechnung
click "Ist eine Doppelzahlung" AdwButtonRow
await "Rückzahlung offen"
absent "Zahlung zu viel eingegangen —"
[ "$(adjustments doppelzahlungen)" != "[]" ] || fail "no doppelzahlung recorded in the config"
step "Doppelzahlung recorded → Rückzahlung offen"
click "03.12.2025 · 285,60 €" AdwExpanderRow
await "Rückzahlung verknüpfen"
await "Außerhalb zurückgezahlt"
shot rueckzahlung
click "Außerhalb zurückgezahlt" AdwButtonRow
await "Datum der Rückzahlung"
await "Speichern"
click "Speichern" GtkButton
absent "Rückzahlung offen"
adjustments doppelzahlungen | grep -q 'rueckzahlung' || fail "refund not recorded in the config"
step "external refund recorded → nothing open"

# ── 4. Partial overpayment on RE-2026-0003 ─────────────────────────────────────────────────────
launch STEUER_APP_VIEW=home STEUER_APP_YEAR=2026
await "Rechnung RE-2026-0003 doppelt bezahlt?"
click "Rechnung RE-2026-0003 doppelt bezahlt?" AdwActionRow
await "1 Zahlung zu viel eingegangen — 100,00 €"
step "task for the partial case opens the invoice dialog"

launch STEUER_APP_VIEW=rechnungen STEUER_APP_YEAR=2026 STEUER_APP_INVOICE_DETAIL=RE-2026-0003
await "1 Zahlung zu viel eingegangen — 100,00 €"
click "15.07.2026 · 695,00 €" AdwExpanderRow
await "Ist eine Doppelzahlung"
click "Ist eine Doppelzahlung" AdwButtonRow
await "Entscheidung nicht gespeichert"
[ "$(adjustments doppelzahlungen)" = "[]" ] || fail "a refused decision was written anyway"
step "partial case: Doppelzahlung refused with an error dialog, nothing written"
shot teilweise
await "OK"
click "OK" GtkButton
absent "Entscheidung nicht gespeichert"
await "Ist in Ordnung"
click "Ist in Ordnung" AdwButtonRow
absent "Zahlung zu viel eingegangen —"
[ "$(adjustments zahlungen_geprueft)" != "[]" ] || fail "in-ordnung not recorded in the config"
step "Ist in Ordnung → suspicion gone, recorded"

echo "doppelzahlung e2e: all steps passed"
