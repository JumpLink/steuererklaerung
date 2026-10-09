#!/usr/bin/env bash
# End-to-end check of the Geld-Prüfungen (Idee 7) against the demo workspace — drives the real desktop
# app over the devtools D-Bus plane, like hinweise-e2e.sh.
#
#   app/dev/geld-pruefungen-e2e.sh [shots-dir]     (build first: gjsify run build:app)
#
# The demo has one case per check in 2025: Hetzner, paid monthly to one IBAN, once paid to a new one
# (IBAN-Wechsel); two Druckerei Hafenblick invoices over the same amount two weeks apart (Doppelte
# Rechnung); the Werbetechnik Nordwind invoice paid twice (Lieferant doppelt bezahlt). The run checks the
# three Einblicke cards with their affected rows and masked IBANs, that IBAN-Wechsel is the first card and
# the first task in „Als Nächstes", that a Beleg row opens the Beleg, and that „Als in Ordnung markieren"
# removes the IBAN-Wechsel — and keeps it removed after a restart, read back from the manifest the app
# wrote. With a shots-dir the pictures are written there as geld-pruefungen-einblicke.png and
# geld-pruefungen-home.png.
#
# A LOCKED or blanked screen stops the frame clock (see frei-verfuegbar-e2e.sh); then run it on a private
# headless compositor: `dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11
# --virtual-monitor 1400x1100 --wayland-display e2e-wl & sleep 2; WAYLAND_DISPLAY=e2e-wl DISPLAY=
# app/dev/hinweise-e2e.sh <shots-dir>'`.
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
  echo '{"name":"geld-pruefungen-e2e","private":true}' > "$T/package.json"
  ID="eu.jumplink.Steuererklaerung.E2e$$x$RANDOM"
  OBJ="/$(printf '%s' "$ID" | tr . /)/devtools"
  ( cd "$T" && exec setsid env -i LANG="${E2E_LANG:-de_DE.UTF-8}" PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data" \
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
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/geld-pruefungen-$1.png" >/dev/null || fail "screenshot $1"
}

IBAN="IBAN-Wechsel bei Hetzner Online GmbH: vermutlich neue Bankverbindung"
DOPPELT="Doppelte Rechnung von Druckerei Hafenblick?"
LIEFERANT="Lieferant doppelt bezahlt? Werbetechnik Nordwind, Rechnung WN-2025-0812"

# Read what the app persisted — the manifest it wrote, not what it drew.
geprueft() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(JSON.stringify(m.entities.find((e) => e.id === "gbr").hinweise_geprueft ?? []));
  ' "$T/demo/steuererklaerung.json"
}

# Line of the first mapped widget showing $1 in `texts` (tree order = the order the cards are drawn).
line_of() { ui texts | grep -n -F -- "$1" | head -1 | cut -d: -f1; }
first_of() {
  local a b
  a="$(line_of "$1")"; [ -n "$a" ] || fail "\"$1\" not drawn"
  shift
  for other in "$@"; do
    b="$(line_of "$other")"
    [ -z "$b" ] || [ "$a" -lt "$b" ] || fail "\"$other\" is drawn before the IBAN-Wechsel"
  done
}

# ── 1. Einblicke: the three findings, IBAN-Wechsel first, IBANs masked ─────────────────────────────
launch STEUER_APP_VIEW=auswertungen STEUER_APP_YEAR=2025 STEUER_APP_SCROLL=end STEUER_APP_SIZE="1280 1400"
await "$IBAN"
await "17.10.2025 · -149,00 € · Hetzner Online GmbH · an DE…4711"
await "bisher bekannten"
await "$DOPPELT"
await "06.10.2025 · 476,00 € · Druckerei Hafenblick · Nr. DH-2025-311"
await "$LIEFERANT"
await "26.08.2025 · -595,00 € · Werbetechnik Nordwind"
ui texts | grep -qE "DE00990000000000004711|DE00100000000000006819" && fail "an unmasked IBAN is drawn"
first_of "$IBAN" "USt-Vorauszahlungen noch nicht erfasst" "Kontoauszug Qonto: vermutlich lückenhaft" "$DOPPELT" "$LIEFERANT"
step "Einblicke show the three findings with their rows; IBAN-Wechsel is first, IBANs masked"
if [ -n "$SHOTS" ]; then
  # The picture starts at the first Einblicke card, not at the end of the list.
  launch STEUER_APP_VIEW=auswertungen STEUER_APP_YEAR=2025 STEUER_APP_SCROLL="${SHOT_SCROLL:-0.24}" STEUER_APP_SIZE="1280 1000"
  await "$IBAN"
  shot einblicke
fi

# A Beleg row opens the Beleg.
click "06.10.2025 · 476,00 € · Druckerei Hafenblick · Nr. DH-2025-311" AdwActionRow
await "Rechnungsnummer"
await "Brutto"
step "an affected Beleg row opens the Beleg"

# ── 2. Als Nächstes: IBAN-Wechsel is the first task ───────────────────────────────────────────────
launch STEUER_APP_VIEW=home STEUER_APP_YEAR=2025 STEUER_APP_SIZE="1280 1000"
await "Als Nächstes"
await "$IBAN"
first_of "$IBAN" "Rechnung RE-2025-0004 doppelt bezahlt?" "$DOPPELT" "$LIEFERANT"
step "IBAN-Wechsel leads Als Nächstes, ahead of the double payment"
shot home

# ── 3. Als in Ordnung markieren → gone, and stays gone ─────────────────────────────────────────────
launch STEUER_APP_VIEW=auswertungen STEUER_APP_YEAR=2025 STEUER_APP_SCROLL=end
await "$IBAN"
click click-tip "Als in Ordnung markieren: $IBAN"
absent "$IBAN"
await "$DOPPELT"
geprueft | grep -q '"hinweis":"iban-wechsel:hetzneronlinegmbh","jahr":2025' || fail "dismissal not in the manifest: $(geprueft)"
step "„Als in Ordnung markieren“ removes the IBAN-Wechsel and stores it with its fingerprint"
KEEP=1 launch STEUER_APP_VIEW=home STEUER_APP_YEAR=2025
await "Als Nächstes"
await "$DOPPELT"
absent "$IBAN"
step "after a restart the IBAN-Wechsel is gone from Als Nächstes too"

echo "geld-pruefungen e2e: all steps passed"
