#!/usr/bin/env bash
# ERiC-Prüfung der Demodaten: every return the app builds from the demo workspace, through the local
# ERiC plausibility check — validate only, NOTHING is sent (`validate-eric` calls ERiC without the send
# flag; there is no `submit` in here).
#
#   app/dev/eric-demo-check.sh [out-dir]     (build first: gjsify run build:gjs; needs ERiC, see
#                                             app/elster/README.md — without it the script says so and exits 0)
#
# Per return it prints pass / FAIL / n/a with ERiC's first message. n/a is a year ERiC 43.4.6.0 has no
# plugin for (EUER/GewSt/FEIN/ESt 2026), the Feststellung before 2025 (Anlage FE 1, not built) and
# the ESt years the demo has no Lohnsteuerbescheinigung for. Exit 1 on any FAIL.
#
# Beyond the shipped demo, the copy gets what the E2Es add by hand: both Erstattungen linked, the
# Bewirtung of June 2026 split 70/30 (Q2/2026 is filed, hence --trotz-abgabe), and one extra Bewirtung
# in November 2025 — the Anlage EÜR 2026 has no ERiC plugin yet, so the Bewirtung lines (Zeile 63)
# can only be checked in 2025.
#
# PRIVACY: a COPY of app/demo in a throwaway dir, an empty environment (no credentials), HOME/XDG and
# cwd inside it, a Paperless stub that answers every request with an empty list. ERiC writes its log
# next to a symlinked runtime inside the throwaway dir, not into app/elster/logs. The committed demo is
# never modified.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
OUT="${1:-}"
GJSIFY="$APP/../node_modules/.bin/gjsify"
[ -x "$GJSIFY" ] || GJSIFY="$(command -v gjsify)"
ERIC_SRC="${ERIC_HOME:-$APP/elster/runtime}"
if [ ! -f "$ERIC_SRC/lib/libericapi.so" ]; then
  echo "ERiC not found under $ERIC_SRC — nothing to check (see app/elster/README.md)."
  exit 0
fi

T="$(mktemp -d)"
STUB_PID=""
trap '[ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$T"' EXIT

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

cp -r "$APP/demo" "$T/demo"
rm -f "$T"/demo/ledger.db*
rm -rf "$T/demo/transactions-data/documents"
mkdir -p "$T/home" "$T/cfg" "$T/data" "$T/eric/runtime" "$T/xml"
ln -s "$ERIC_SRC/lib" "$T/eric/runtime/lib"
: > "$T/empty.env"
echo '{"name":"eric-demo-check","private":true}' > "$T/package.json"
EH="$T/eric/runtime"

ENV=(PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data"
  DOTENV_CONFIG_PATH="$T/empty.env" PAPERLESS_BASE_URL=http://127.0.0.1:$STUB_PORT PAPERLESS_API_TOKEN=demo
  STEUER_DEMO=1 STEUER_WORKSPACE="$T/demo/steuererklaerung.json" TRANSACTIONS_DATA_DIR="$T/demo/transactions-data"
  LEDGER_DB_PATH="$T/demo/ledger.db" ERIC_HOME="$EH" LD_LIBRARY_PATH="$EH/lib:$EH/lib/plugins")
cli() { ( cd "$T" && env -i "${ENV[@]}" "$GJSIFY" run "$APP/dist/steuer.gjs.mjs" "$@" ) 2>&1 | grep -v '^\$ GI_TYPELIB'; }

# The extra Bewirtung of 2025 (invented, like everything in the demo).
echo '{"id":"demo-qonto-eric-1","source":"qonto","accountKey":"qonto:demo-fw-geschaeft","iban":"DE89370400440532013000","bookingDate":"2025-11-14","valueDate":"2025-11-14","amount":-119,"currency":"EUR","counterparty":"Restaurant Kombüse","purpose":"Bewirtung Projektabschluss Hafenkontor","category":"Bewirtung"}' \
  >> "$T/demo/transactions-data/qonto_demo-fw-geschaeft.ndjson"
cli demo seed > "$T/seed.log" || { tail -5 "$T/seed.log"; exit 1; }
cli buchungen erstattung demo-qonto-153 --ja demo-qonto-152 --entity gbr --year 2026 > /dev/null
cli buchungen erstattung demo-qonto-151 --ja demo-qonto-150 --entity gbr --year 2026 > /dev/null
cli buchungen aufteilen demo-qonto-160 --bewirtung --trotz-abgabe --entity gbr --year 2026 > /dev/null
cli buchungen aufteilen demo-qonto-eric-1 --bewirtung --entity gbr --year 2025 > /dev/null

FAILS=0
check() {
  local label="$1"; shift
  local log="$T/$(echo "$label" | tr ' /' '__').log"
  cli "$@" > "$log" || true
  local msg
  msg="$( (grep -oE '<Text>[^<]*' "$log" || true) | head -1 | sed 's/<Text>//' | cut -c1-110)"
  if grep -q 'ERiC validation passed' "$log"; then
    printf '%-24s pass  %s\n' "$label" "$msg"
  elif grep -qE 'Datenartversion ist unbekannt|Anlage FE 1|fehlende/nicht abbildbare|Keine privaten ESt-Konstanten' "$log"; then
    printf '%-24s n/a   %s\n' "$label" "$(grep -m1 -oE 'Datenartversion ist unbekannt|Anlage FE 1[^.]*|Keine privaten ESt-Konstanten für VZ [0-9]+|jahre\[[0-9]+\][^)]*' "$log" || true)"
  else
    printf '%-24s FAIL  %s\n' "$label" "${msg:-$( (grep -v '^\s*$' "$log" || true) | tail -2 | tr '\n' ' ' | cut -c1-160)}"
    FAILS=$((FAILS + 1))
  fi
  [ -n "$OUT" ] && mkdir -p "$OUT" && cp "$log" "$OUT/"
  return 0
}

for y in 2024 2025 2026; do
  check "EÜR $y" elster euer validate-eric --entity gbr --year "$y"
  check "USt-Jahr $y" elster uste validate-eric --entity gbr --year "$y"
  check "GewSt $y" elster gewst validate-eric --entity gbr --year "$y"
  check "Feststellung $y" elster feststellung validate-eric --entity gbr --year "$y"
  check "ESt privat $y" elster est validate-eric --entity privat --year "$y"
done
for yq in 2024:1 2024:4 2025:1 2025:2 2025:3 2025:4 2026:1 2026:2 2026:3; do
  check "USt-VA ${yq%:*} Q${yq#*:}" elster ustva validate-eric --entity gbr --year "${yq%:*}" --quarter "${yq#*:}"
done

[ "$FAILS" -eq 0 ] && echo "eric-demo-check: no return failed" || echo "eric-demo-check: $FAILS return(s) failed"
[ "$FAILS" -eq 0 ]
