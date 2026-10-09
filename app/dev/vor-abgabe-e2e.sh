#!/usr/bin/env bash
# End-to-end check of the „Prüfungen vor der Abgabe" (Idee 10) against the demo workspace — drives the
# real desktop app over the devtools D-Bus plane, like erstattungen-e2e.sh.
#
#   app/dev/vor-abgabe-e2e.sh [shots-dir]     (build first: gjsify run build:gjs build:app)
#
# The demo GbR has three cases in 2026: a debit to Nordlys Analytics ApS (Danish IBAN, no VAT, not booked
# as § 13b), a workstation from Technikhaus Nord GmbH for 1.200 € net that is not in the Anlageverzeichnis,
# and two receipts (Copyshop Möwe, Fotostudio Kranz) that name no VAT. The run checks that the Absenden
# step shows them under „Vor der Abgabe klären" with their bookings and actions; that Als Nächstes and the
# Einblicke carry them; that „Als in Ordnung markieren" on the § 13b hint is stored in the manifest and
# survives a restart; and that „Ins Anlageverzeichnis" opens the pre-filled dialog, whose „Erfassen"
# stores the asset with its booking — after which the hint is gone. With a shots-dir the pictures are
# written there as vor-abgabe-absenden.png and vor-abgabe-anlagegut.png.
#
# A LOCKED or blanked screen stops the frame clock (see frei-verfuegbar-e2e.sh); then run it on a private
# headless compositor: `dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11
# --virtual-monitor 1400x1100 --wayland-display e2e-wl & sleep 2; WAYLAND_DISPLAY=e2e-wl DISPLAY=
# app/dev/vor-abgabe-e2e.sh <shots-dir>; kill %1'`.
#
# PRIVACY: same isolation as erstattungen-e2e.sh — a COPY of app/demo in a throwaway dir, an empty
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
  echo '{"name":"vor-abgabe-e2e","private":true}' > "$T/package.json"
  ID="eu.jumplink.Steuererklaerung.E2e$$x$RANDOM"
  OBJ="/$(printf '%s' "$ID" | tr . /)/devtools"
  ( cd "$T" && exec setsid env -i LANG="${E2E_LANG:-de_DE.UTF-8}" PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data" \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
      WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" DISPLAY="${DISPLAY:-:0}" \
      DOTENV_CONFIG_PATH="$T/empty.env" PAPERLESS_BASE_URL=http://127.0.0.1:$STUB_PORT PAPERLESS_API_TOKEN=demo GJSIFY_DEVTOOLS=1 STEUER_APP_ID="$ID" STEUER_DEMO=1 \
      STEUER_WORKSPACE="$T/demo/steuererklaerung.json" TRANSACTIONS_DATA_DIR="$T/demo/transactions-data" \
      LEDGER_DB_PATH="$T/demo/ledger.db" STEUER_APP_SIZE="1280 1100" STEUER_APP_ENTITY=gbr STEUER_APP_YEAR=2026 "$@" \
      "$GJSIFY" run "$APP/dist/app/steuer-app.gjs.mjs" >"$T/log" 2>&1 ) &
  APP_PID=$!
  for _ in $(seq 1 80); do
    gdbus call --session --dest "$ID" --object-path "$OBJ" --method org.gjsify.Devtools.GetStatus >/dev/null 2>&1 && break
    sleep 0.5
  done
}

ui() { gjs -m "$HERE/dbus-ui.js" "$ID" "$OBJ" "$@"; }
await() {
  for _ in $(seq 1 60); do ui has "$1" && return 0; sleep 0.5; done
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
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/vor-abgabe-$1.png" >/dev/null || fail "screenshot $1"
}

# Read what the app persisted — the manifest it wrote, not what it drew.
gbr() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const e = m.entities.find((x) => x.id === "gbr");
    console.log(JSON.stringify(process.argv[2] === "anlagen" ? e.elster.adjustments.anlageverzeichnis : e.hinweise_geprueft ?? []));
  ' "$T/demo/steuererklaerung.json" "$1"
}

RC="§ 13b nicht erkannt? Nordlys Analytics ApS"
ANLAGE="Anlagegut? Technikhaus Nord GmbH, 1.200,00 €"
OHNE_UST="2 Buchung(en) ohne USt-Angabe auf dem Beleg"
ABSENDEN=(STEUER_APP_VIEW=steuer STEUER_APP_STEP=zusammenfassung STEUER_APP_SCROLL=vor-abgabe)

# ── 1. Absenden: „Vor der Abgabe klären" with bookings and actions ─────────────────────────────────────
launch "${ABSENDEN[@]}"
await "Vor der Abgabe klären"
await "$RC"
await "08.05.2026 · -59,00 € · Nordlys Analytics ApS"
await "$ANLAGE"
await "20.05.2026 · -1.428,00 € · Technikhaus Nord GmbH"
await "$OHNE_UST"
await "16.04.2026 · -89,25 € · Copyshop Möwe"
await "Ins Anlageverzeichnis"
await "Beleg zuordnen"
step "the Absenden step lists § 13b, Anlagegut and ohne USt with their bookings and actions"
shot absenden

# ── 2. Als Nächstes and the Einblicke carry them too ───────────────────────────────────────────────────
KEEP=1 launch STEUER_APP_VIEW=home
await "Als Nächstes"
await "$ANLAGE"
await "$RC"
step "Als Nächstes has the findings as tasks"
KEEP=1 launch STEUER_APP_VIEW=auswertungen STEUER_APP_SCROLL=end
await "$OHNE_UST"
await "USt-Zahllast weicht ab: Q3/2026"
step "the Einblicke show them, the USt-Abweichung included"

# ── 3. „Als in Ordnung markieren" persists ─────────────────────────────────────────────────────────────
KEEP=1 launch "${ABSENDEN[@]}"
await "$RC"
click click-tip "Als in Ordnung markieren: $RC"
for _ in $(seq 1 20); do gbr geprueft | grep -q "reverse-charge-kandidat:nordlysanalyticsaps" && break; sleep 0.5; done
gbr geprueft | grep -q '"hinweis":"reverse-charge-kandidat:nordlysanalyticsaps","jahr":2026' \
  || fail "dismissal not in the manifest: $(gbr geprueft)"
absent "$RC"
KEEP=1 launch "${ABSENDEN[@]}"
await "$ANLAGE"
sleep 2
ui texts | grep -qF "$RC" && fail "the dismissed § 13b hint is back after a restart"
step "„Als in Ordnung markieren“ is stored and holds after a restart"

# ── 4. „Ins Anlageverzeichnis" → pre-filled dialog → stored with its booking ───────────────────────────
click click-tip "Ins Anlageverzeichnis: $ANLAGE"
await "Wirtschaftsgut erfassen"
await "Vorbelegt aus der Buchung — Nutzungsdauer und Bezeichnung prüfen."
step "„Ins Anlageverzeichnis“ opens the dialog"
shot anlagegut
# Nothing is typed: whatever the stored asset says came from the pre-filled fields.
click "Erfassen" AdwButtonRow
for _ in $(seq 1 20); do gbr anlagen | grep -q "demo-qonto-155" && break; sleep 0.5; done
gbr anlagen | node -e '
  const a = JSON.parse(require("fs").readFileSync(0, "utf8")).find((x) => (x.buchung_ids ?? []).includes("demo-qonto-155"));
  const ok = a && a.bezeichnung === "Bürobedarf Grafik-Workstation TN-2026-0520" && a.anschaffung === "2026-05-20" &&
    a.ahk === 1200 && a.restbuchwert_anfang === 1200;
  process.exit(ok ? 0 : 1);
' || fail "asset not stored pre-filled with its booking: $(gbr anlagen)"
absent "$ANLAGE"
step "„Erfassen“ stores the asset with its booking and the hint is gone"

echo "vor-abgabe e2e: all steps passed"
