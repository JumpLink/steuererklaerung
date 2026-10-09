#!/usr/bin/env bash
# End-to-end check of „Belege aus Mail" (Idee 15) against the demo workspace — drives the real desktop app
# over the devtools D-Bus plane, like projekte-e2e.sh, with a REAL IMAP conversation: a small Python stub
# speaks the subset of IMAP the app uses and logs every command it receives.
#
#   app/dev/belege-mail-e2e.sh [shots-dir]     (build first: gjsify run build)
#
# The stub holds one invented message (sender „Anna Beispiel", a PDF invoice and an inline logo). The run
#   1. configures the mail folder with the CLI (`belege mail-konfig setzen`; the desktop has no text-entry
#      driver) and checks that `mail-abruf --dry-run` counts one receipt and stores nothing;
#   2. opens Einstellungen → „Belege aus Mail", presses „Jetzt abrufen": one receipt, one result line;
#   3. checks the ledger: one document with the mail origin, the cursor (UIDVALIDITY 777, last UID 1);
#   4. presses „Jetzt abrufen" again: nothing new, still one document;
#   5. opens the Beleg-Eingang: „1 neuer Beleg aus Mail" and „aus Mail von Anna Beispiel, 12.05.2026";
#   6. reads the stub's command log: EXAMINE and BODY.PEEK only — never SELECT, STORE, EXPUNGE, COPY, …
# With a shots-dir the Beleg-Eingang picture is written there as belege-mail-eingang.png.
#
# KEYRING: the password reaches the app through STEUER_MAIL_EINGANG_PASSWORD (the documented headless seam,
# same shape as ELSTER_PIN) — a private `dbus-run-session` has no keyring daemon. The keyring path itself is
# `secret-tool`, covered by the unit tests only in its absence.
#
# A LOCKED or blanked screen stops the frame clock; run on a private headless compositor:
# `dbus-run-session -- sh -c 'mutter --headless --wayland --no-x11 --virtual-monitor 1400x1100
# --wayland-display e2e-wl & sleep 2; WAYLAND_DISPLAY=e2e-wl DISPLAY= app/dev/belege-mail-e2e.sh <shots>; kill %1'`.
#
# PRIVACY: a COPY of app/demo in a throwaway dir, an empty environment (no credentials, no LLM), HOME/XDG and
# cwd inside it, a Paperless stub that answers with an empty list, an IMAP stub on 127.0.0.1. Nothing real.
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
IMAP_PID=""
trap 'stop_app; [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; [ -n "$IMAP_PID" ] && kill "$IMAP_PID" 2>/dev/null; rm -rf "$T"' EXIT

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

# A minimal IMAP server: LOGIN (checks the password), EXAMINE, UID SEARCH, UID FETCH, LOGOUT. Anything else
# is answered BAD — and logged, which is what the run asserts on.
cat > "$T/imap.py" <<'PY'
import re, socketserver, sys
from email.message import EmailMessage

PASSWORD = "e2e-geheim-4711"
LOG = sys.argv[1]
PDF = b"%PDF-1.4\n% e2e demo invoice\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"
msg = EmailMessage()
msg["From"] = "Anna Beispiel <anna@lieferant.example>"
msg["To"] = "belege@firma.invalid"
msg["Subject"] = "Rechnung Mai"
msg["Date"] = "Tue, 12 May 2026 09:30:00 +0200"
msg.set_content("Anbei die Rechnung.")
msg.add_attachment(b"\x89PNG\r\n\x1a\n", maintype="image", subtype="png", disposition="inline", filename="logo.png")
msg.add_attachment(PDF, maintype="application", subtype="pdf", filename="Rechnung-2026-05.pdf")
RAW = msg.as_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
MESSAGES = {1: RAW}

class H(socketserver.StreamRequestHandler):
    def log(self, text):
        with open(LOG, "a") as f:
            f.write(text + "\n")
    def reply(self, data):
        self.wfile.write(data if isinstance(data, bytes) else data.encode()); self.wfile.flush()
    def handle(self):
        self.log("-- connect")
        self.reply("* OK IMAP stub ready\r\n")
        authed = False
        while True:
            line = self.rfile.readline()
            if not line: return
            text = line.decode("latin1").rstrip("\r\n")
            tag, _, rest = text.partition(" ")
            cmd = rest.split(" ")[0].upper()
            if cmd == "LOGIN":
                ok = ('"%s"' % PASSWORD) in rest
                self.log("LOGIN " + ("ok" if ok else "refused"))
                authed = ok
                self.reply(f"{tag} OK angemeldet\r\n" if ok else f"{tag} NO [AUTHENTICATIONFAILED] refused\r\n")
                continue
            self.log(re.sub(r"\s+", " ", rest))
            if cmd == "LOGOUT":
                self.reply(f"* BYE\r\n{tag} OK\r\n"); return
            if not authed:
                self.reply(f"{tag} NO login first\r\n")
            elif cmd == "EXAMINE":
                self.reply(f"* {len(MESSAGES)} EXISTS\r\n* OK [UIDVALIDITY 777] ok\r\n* OK [UIDNEXT {max(MESSAGES) + 1}] ok\r\n{tag} OK [READ-ONLY] fertig\r\n")
            elif rest.upper().startswith("UID SEARCH"):
                m = re.search(r"UID (\d+):\*", rest)
                lo = int(m.group(1)) if m else 1
                uids = [u for u in MESSAGES if u >= lo] or [max(MESSAGES)]
                self.reply("* SEARCH " + " ".join(map(str, uids)) + f"\r\n{tag} OK fertig\r\n")
            elif rest.upper().startswith("UID FETCH"):
                uid = int(rest.split(" ")[2])
                if "RFC822.SIZE" in rest.upper():
                    self.reply(f"* 1 FETCH (UID {uid} RFC822.SIZE {len(MESSAGES[uid])})\r\n{tag} OK fertig\r\n")
                else:
                    body = MESSAGES[uid]
                    self.reply(f"* 1 FETCH (UID {uid} BODY[] {{{len(body)}}}\r\n".encode() + body + f")\r\n{tag} OK fertig\r\n".encode())
            else:
                self.reply(f"{tag} BAD nicht erlaubt\r\n")

class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

srv = S(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
PY
python3 "$T/imap.py" "$T/imap.log" > "$T/imap.port" &
IMAP_PID=$!
for _ in $(seq 1 20); do [ -s "$T/stub.port" ] && [ -s "$T/imap.port" ] && break; sleep 0.2; done
STUB_PORT="$(cat "$T/stub.port")"
IMAP_PORT="$(cat "$T/imap.port")"

fail() { echo "FAIL: $*" >&2; [ -f "$T/log" ] && grep -v "^\$" "$T/log" | tail -5 >&2; exit 1; }
step() { echo "ok: $*"; }

# The one environment both the CLI and the app run in.
RUN_ENV=(env -i LANG="${E2E_LANG:-de_DE.UTF-8}" PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" XDG_DATA_HOME="$T/data"
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}"
  WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" DISPLAY="${DISPLAY:-:0}"
  DOTENV_CONFIG_PATH="$T/empty.env" PAPERLESS_BASE_URL=http://127.0.0.1:$STUB_PORT PAPERLESS_API_TOKEN=demo
  STEUER_MAIL_EINGANG_PASSWORD=e2e-geheim-4711 STEUER_DEMO=1
  STEUER_WORKSPACE="$T/demo/steuererklaerung.json" TRANSACTIONS_DATA_DIR="$T/demo/transactions-data"
  LEDGER_DB_PATH="$T/demo/ledger.db")
cli() { ( cd "$T" && "${RUN_ENV[@]}" "$GJSIFY" run "$APP/dist/steuer.gjs.mjs" "$@" ); }

rm -rf "$T/demo" "$T/home"
cp -r "$APP/demo" "$T/demo"
rm -f "$T"/demo/ledger.db*
rm -rf "$T/demo/transactions-data/documents"
mkdir -p "$T/home" "$T/cfg" "$T/data"
: > "$T/empty.env"
echo '{"name":"belege-mail-e2e","private":true}' > "$T/package.json"

launch() {
  stop_app
  ID="eu.jumplink.Steuererklaerung.E2e$$x$RANDOM"
  OBJ="/$(printf '%s' "$ID" | tr . /)/devtools"
  ( cd "$T" && exec setsid "${RUN_ENV[@]}" GJSIFY_DEVTOOLS=1 STEUER_APP_ID="$ID" STEUER_APP_SIZE="1280 900" \
      STEUER_APP_ENTITY=gbr STEUER_APP_YEAR=2026 "$@" \
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
click() { ui click "$@" >/dev/null || fail "cannot click \"$1\""; sleep 1.5; }
shot() {
  [ -z "$SHOTS" ] && return 0
  mkdir -p "$SHOTS"
  sleep 1.5
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/belege-mail-$1.png" >/dev/null || fail "screenshot $1"
}

sql() { python3 -c '
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
print(db.execute(sys.argv[2]).fetchone()[0])
' "$T/demo/ledger.db" "$1"; }

# ── 1. Configure with the CLI; a dry run counts and stores nothing ───────────────────────────────────
cli belege mail-konfig setzen --entity gbr --server 127.0.0.1 --port "$IMAP_PORT" --sicherheit none \
  --benutzer belege@firma.invalid --ordner Belege > "$T/konfig.out" 2>&1 || { cat "$T/konfig.out" >&2; fail "mail-konfig setzen"; }
grep -q "Postfach: 127.0.0.1" "$T/konfig.out" || fail "mail-konfig shows no Postfach: $(cat "$T/konfig.out")"
grep -q "e2e-geheim" "$T/demo/steuererklaerung.json" && fail "the password is in the manifest"
cli belege mail-abruf --entity gbr --dry-run > "$T/dry.out" 2>&1 || { cat "$T/dry.out" >&2; fail "mail-abruf --dry-run"; }
grep -q "würde" "$T/dry.out" || fail "dry run said: $(cat "$T/dry.out")"
[ "$(sql "SELECT COUNT(*) FROM documents WHERE origin IS NOT NULL")" = 0 ] || fail "the dry run stored a document"
step "mail-konfig setzen writes the folder without the password; mail-abruf --dry-run counts one receipt and stores nothing"

# ── 2. Einstellungen: „Jetzt abrufen" ────────────────────────────────────────────────────────────────
launch STEUER_APP_VIEW=settings
await "Belege aus Mail"
await "Jetzt abrufen"
await "Noch nie abgerufen."
click "Jetzt abrufen" AdwButtonRow
await "1 Nachricht geprüft · 1 neuer Beleg"
step "„Jetzt abrufen“ imports one receipt and the settings show the one-line result"

# ── 3. The ledger holds the receipt, its origin and the cursor ──────────────────────────────────────
[ "$(sql "SELECT COUNT(*) FROM documents WHERE origin IS NOT NULL")" = 1 ] || fail "expected one mail receipt"
sql "SELECT origin FROM documents WHERE origin IS NOT NULL" | grep -q '"from":"Anna Beispiel <anna@lieferant.example>"' || fail "origin has no sender"
sql "SELECT origin FROM documents WHERE origin IS NOT NULL" | grep -q '"date":"2026-05-12"' || fail "origin has no date"
sql "SELECT origin FROM documents WHERE origin IS NOT NULL" | grep -qi "Rechnung Mai\|Anbei" && fail "subject or text was stored"
[ "$(sql "SELECT uid_validity || '/' || last_uid FROM mail_eingang_state")" = "777/1" ] || fail "cursor: $(sql "SELECT uid_validity || '/' || last_uid FROM mail_eingang_state")"
step "the receipt carries sender + date only; the cursor is UIDVALIDITY 777, last UID 1"

# ── 4. A second fetch finds nothing new ─────────────────────────────────────────────────────────────
click "Jetzt abrufen" AdwButtonRow
await "Keine neuen Nachrichten"
[ "$(sql "SELECT COUNT(*) FROM documents WHERE origin IS NOT NULL")" = 1 ] || fail "second fetch stored again"
grep -q "UID SEARCH UID 2:\*" "$T/imap.log" || fail "second fetch did not resume above UID 1"
step "the second fetch asks for UIDs from 2 and stores nothing"

# ── 5. Beleg-Eingang: count and origin ──────────────────────────────────────────────────────────────
launch STEUER_APP_VIEW=review
await "1 neuer Beleg aus Mail"
await "aus Mail von Anna Beispiel, 12.05.2026"
step "the Beleg-Eingang says „1 neuer Beleg aus Mail“ and „aus Mail von Anna Beispiel, 12.05.2026“"
shot eingang

# ── 6. The server was only read ─────────────────────────────────────────────────────────────────────
grep -q "EXAMINE" "$T/imap.log" || fail "the folder was not opened with EXAMINE"
grep -q "BODY.PEEK" "$T/imap.log" || fail "the body was not fetched with PEEK"
grep -Eiq "^(SELECT|STORE|EXPUNGE|COPY|MOVE|APPEND|DELETE|CREATE|RENAME)|UID STORE|UID COPY|UID MOVE|UID EXPUNGE" "$T/imap.log" && fail "the server was written to: $(grep -Ei 'STORE|EXPUNGE|COPY|MOVE|SELECT' "$T/imap.log")"
grep -E "BODY\[\]" "$T/imap.log" | grep -v PEEK >/dev/null && fail "a body was fetched without PEEK"
step "the stub saw EXAMINE and BODY.PEEK only — no flag, move or delete"

echo "belege-mail e2e: all steps passed"
