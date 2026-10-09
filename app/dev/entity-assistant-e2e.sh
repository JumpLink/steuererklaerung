#!/usr/bin/env bash
# End-to-end check of the new-entity assistant and the add-account dialog — drives the real desktop
# app over the devtools D-Bus plane, like welcome-e2e.sh.
#
#   app/dev/entity-assistant-e2e.sh [shots-dir]     (build first: gjsify run build)
#
#   1. On an existing workspace the assistant opens in new-entity mode: the kind page, no welcome and
#      no "where your data will be stored". Closing it writes nothing.
#   2. The entity switcher's „Neue Entität …" opens it again; Private → income tax → bank accounts →
#      receipts → „Entität anlegen" adds a private entity, which the switcher then lists.
#   3. Konten → „Konto hinzufügen" asks for the source first; walking to the FinTS form and closing
#      the dialog leaves the manifest byte-identical and writes no credentials.
# With a shots-dir the assistant's kind/business pages and every add-account page are written there,
# as entity-assistant-*.png and bank-account-*.png in the language of E2E_LANG (default de_DE.UTF-8).
#
# PRIVACY: a COPY of app/demo in a throwaway dir (STEUER_DEMO_DIR points demo mode at it), an empty
# environment (no credentials, no LLM), HOME/XDG, cwd, TRANSACTIONS_DATA_DIR and LEDGER_DB_PATH inside it.
# The entity name and tax number come from the STEUER_APP_SETUP_PAGE placeholders — dbus-ui can click,
# not type.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
SHOTS="${1:-}"
GJSIFY="$APP/../node_modules/.bin/gjsify"
[ -x "$GJSIFY" ] || GJSIFY="$(command -v gjsify)"
LANG_E2E="${E2E_LANG:-de_DE.UTF-8}"
SUFFIX=""
[ "${LANG_E2E:0:2}" = de ] || SUFFIX="-en"

T="$(mktemp -d)"
APP_PID=""
stop_app() {
  if [ -n "$APP_PID" ]; then
    kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true
    APP_PID=""
  fi
  return 0
}
trap 'stop_app; rm -rf "$T"' EXIT

fail() { echo "FAIL: $*" >&2; [ -f "$T/log" ] && grep -v "^\$" "$T/log" | tail -8 >&2; exit 1; }
step() { echo "ok: $*"; }

cp -r "$APP/demo" "$T/demo"
rm -f "$T"/demo/ledger.db*
rm -rf "$T/demo/transactions-data/documents"
mkdir -p "$T/run" "$T/home" "$T/cfg" "$T/data" "$T/state" "$T/own-data"
: > "$T/empty.env"
ID="eu.jumplink.Steuererklaerung.E2e$$x$RANDOM"
OBJ="/$(printf '%s' "$ID" | tr . /)/devtools"
MANIFEST="$T/demo/steuererklaerung.json"

# launch [VAR=value …]
launch() {
  stop_app
  ( cd "$T/run" && exec setsid env -i LANG="$LANG_E2E" PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" \
      XDG_DATA_HOME="$T/data" XDG_STATE_HOME="$T/state" \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
      WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" DISPLAY="${DISPLAY:-:0}" \
      DOTENV_CONFIG_PATH="$T/empty.env" GJSIFY_DEVTOOLS=1 STEUER_APP_ID="$ID" STEUER_DEMO=1 \
      STEUER_DEMO_DIR="$T/demo" \
      TRANSACTIONS_DATA_DIR="$T/own-data/transactions-data" LEDGER_DB_PATH="$T/own-data/ledger.db" \
      STEUER_APP_SIZE="1100 860" "$@" \
      "$GJSIFY" run "$APP/dist/app/steuer-app.gjs.mjs" >"$T/log" 2>&1 ) &
  APP_PID=$!
  for _ in $(seq 1 80); do
    gdbus call --session --dest "$ID" --object-path "$OBJ" --method org.gjsify.Devtools.GetStatus >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  fail "the app never came up on D-Bus"
}

ui() { gjs -m "$HERE/dbus-ui.js" "$ID" "$OBJ" "$@" 2>/dev/null; }
await() {
  for _ in $(seq 1 40); do ui has "$1" && return 0; sleep 0.5; done
  ui texts | tail -12 >&2
  fail "never saw \"$1\""
}
absent() {
  for _ in $(seq 1 6); do ui has "$1" && fail "\"$1\" is shown"; sleep 0.5; done
  return 0
}
click() {
  ui click "$@" >/dev/null || fail "cannot click \"$1\""
  sleep 1.5
}
# Activate the first widget matching a dbus-find selector — for widgets without text of their own.
activate() {
  local path
  path="$(gjs -m "$HERE/dbus-find.js" "$ID" "$OBJ" "$1" 2>/dev/null)" || fail "no widget \"$1\""
  gdbus call --session --dest "$ID" --object-path "$OBJ" --method org.gjsify.Devtools.ActivateWidget "$path" \
    >/dev/null || fail "cannot activate \"$1\""
  sleep 1.5
}
shot() {
  [ -z "$SHOTS" ] && return 0
  mkdir -p "$SHOTS"
  sleep 1.5
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/$1$SUFFIX.png" >/dev/null || fail "screenshot $1"
}
# Close the top dialog with its own header button. Not dbus-find: the FIRST `GtkButton:close` is the
# main window's, and activating that ends the app instead of cancelling the dialog.
close_dialog() {
  local path
  path="$(gdbus call --session --dest "$ID" --object-path "$OBJ" --method org.gjsify.Devtools.DumpTree window 64 |
    python3 -c '
import ast, json, sys
hits = []
def walk(n, in_sheet):
    in_sheet = in_sheet or n.get("type") == "AdwSheetControls"
    if in_sheet and n.get("type") == "GtkButton" and "close" in (n.get("cssClasses") or []) and n.get("mapped"):
        hits.append(n["path"])
    for c in n.get("children", []):
        walk(c, in_sheet)
walk(json.loads(ast.literal_eval(sys.stdin.read().strip())[0]), False)
print(hits[-1] if hits else "")')"
  [ -n "$path" ] || fail "no dialog close button"
  gdbus call --session --dest "$ID" --object-path "$OBJ" --method org.gjsify.Devtools.ActivateWidget "$path" \
    >/dev/null || fail "cannot close the dialog"
  sleep 1.5
}
entities() { python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["entities"]))' "$MANIFEST"; }

if [ "$SUFFIX" = "" ]; then
  L_KIND="Privat oder Betrieb?"; L_WELCOME="Willkommen bei Steuererklärung"; L_WHERE="Wo die Daten liegen werden"
  L_PRIVATE="Privat"; L_NEXT="Weiter"; L_INCOME="Einkommensteuer"; L_ACCOUNTS="Welche Bankkonten gehören dazu?"
  L_RECEIPTS="Woher kommen die Belege?"; L_SUMMARY="Zusammenfassung"; L_ADD="Entität anlegen"
  L_NEW="Neue Entität …"; L_VAT="Umsatzsteuer"; L_GBR="Personengesellschaft (GbR)"
  L_ADD_ACCOUNT="Konto hinzufügen"; L_SOURCE="Woher kommen die Buchungen?"; L_FILE="Datei importieren (CAMT oder CSV)"
  L_QONTO="Qonto verbinden"; L_FINTS="Bank über FinTS/HBCI"; L_WHICH="Zu welcher Entität gehört das Konto?"
else
  L_KIND="Private or business?"; L_WELCOME="Welcome to Steuererklärung"; L_WHERE="Where your data will be stored"
  L_PRIVATE="Private"; L_NEXT="Next"; L_INCOME="Income tax"; L_ACCOUNTS="Which bank accounts belong to it?"
  L_RECEIPTS="Where do the receipts come from?"; L_SUMMARY="Summary"; L_ADD="Add entity"
  L_NEW="New entity …"; L_VAT="VAT"; L_GBR="Partnership (GbR)"
  L_ADD_ACCOUNT="Add account"; L_SOURCE="Where do the transactions come from?"; L_FILE="Import a file (CAMT or CSV)"
  L_QONTO="Connect Qonto"; L_FINTS="Bank via FinTS/HBCI"; L_WHICH="Which entity does the account belong to?"
fi
NAME="Erika Muster"

# ── 1. New-entity mode: kind page first, no welcome; closing writes nothing ──────────────────────────
cp "$MANIFEST" "$T/manifest.before"
BEFORE="$(entities)"
launch STEUER_APP_SETUP_PAGE=kind
await "$L_KIND"
absent "$L_WELCOME"
absent "$L_WHERE"
step "on a workspace the assistant opens on „$L_KIND“ — no welcome, no data-location page"
shot entity-assistant-kind
click "$L_GBR" AdwActionRow
click "$L_NEXT" GtkButton
await "$L_VAT"
shot entity-assistant-business
close_dialog
absent "$L_VAT"
cmp -s "$MANIFEST" "$T/manifest.before" || fail "closing the assistant changed the manifest"
step "closing the assistant after two pages leaves the manifest byte-identical"

# ── 2. Switcher → „Neue Entität …" → a private entity ───────────────────────────────────────────────
activate "GtkMenuButton:flat"
await "$L_NEW"
click "$L_NEW" AdwActionRow
await "$L_KIND"
click "$L_PRIVATE" AdwActionRow
click "$L_NEXT" GtkButton
await "$L_INCOME"
click "$L_NEXT" GtkButton
await "$L_ACCOUNTS"
click "$L_NEXT" GtkButton
await "$L_RECEIPTS"
click "$L_NEXT" GtkButton
await "$L_SUMMARY"
click "$L_ADD" GtkButton
absent "$L_SUMMARY"
[ "$(entities)" = "$((BEFORE + 1))" ] || fail "expected $((BEFORE + 1)) entities, manifest has $(entities)"
python3 - "$MANIFEST" "$NAME" <<'EOF' || fail "the new entity is not a private „$NAME“"
import json, sys
e = json.load(open(sys.argv[1]))["entities"][-1]
assert e["name"] == sys.argv[2] and e["kind"] == "privat", e
EOF
activate "GtkMenuButton:flat"
await "$NAME"
step "„$L_NEW“ → $L_PRIVATE → „$L_ADD“ writes one private entity, and the switcher lists „$NAME“"

# ── 3. Add-account dialog: source first; cancelling writes nothing ──────────────────────────────────
cp "$MANIFEST" "$T/manifest.before"
launch STEUER_APP_VIEW=konten STEUER_APP_ADD_ACCOUNT=choose
await "$L_SOURCE"
await "$L_FILE"
await "$L_QONTO"
await "$L_FINTS"
step "„$L_ADD_ACCOUNT“ asks for the source first: file, Qonto, FinTS"
shot bank-account-choose
for page in file qonto fints assign; do
  [ -z "$SHOTS" ] && break
  launch STEUER_APP_VIEW=konten STEUER_APP_ADD_ACCOUNT="$page"
  sleep 3
  shot "bank-account-$page"
done
launch STEUER_APP_VIEW=konten STEUER_APP_ADD_ACCOUNT=choose
await "$L_SOURCE"
click "$L_FINTS" AdwActionRow
await "$L_NEXT"
click "$L_NEXT" GtkButton
await "BLZ"
close_dialog
absent "$L_SOURCE"
cmp -s "$MANIFEST" "$T/manifest.before" || fail "cancelling the add-account dialog changed the manifest"
[ -s "$T/empty.env" ] && fail "cancelling the add-account dialog wrote credentials"
step "walking to the FinTS form and closing the dialog leaves the manifest byte-identical, .env empty"

echo "entity-assistant e2e: all steps passed"
