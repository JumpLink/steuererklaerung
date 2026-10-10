#!/usr/bin/env bash
# End-to-end check of the welcome flow and the demo/own switch — drives the real desktop app over the
# devtools D-Bus plane, like projekte-e2e.sh.
#
#   app/dev/welcome-e2e.sh [shots-dir]     (build first: gjsify run build)
#
#   1. A fresh HOME without any manifest opens the welcome. „Demo ausprobieren" → „Demo starten" restarts
#      the app, which comes back in demo mode; settings.json records the choice.
#   2. A plain relaunch (no STEUER_DEMO) stays in the demo, because the person chose it; Settings →
#      „Einführung erneut anzeigen" reopens the welcome and „Später" closes it again.
#   3. The banner's „Eigene Daten verwenden" asks first, then restarts into own data, where the setup
#      assistant takes over — the welcome is not shown twice.
#   4. An existing installation (a pre-rename buchhaltung.json in cwd, no settings file) never sees the
#      welcome, and the launch writes no settings file.
#   5. „Später" is remembered: the relaunch shows neither the welcome nor the setup assistant but the
#      setup banner; closing it keeps it closed across a relaunch, and a NEW gap (an entity without a
#      bank account) brings it back.
#   6. Settings keep the assistant and the MCP server apart; „Externen Agenten verbinden …" shows the
#      client config; „Jetzt sichern" runs in a child process while the window shows „Wird gesichert …".
# With a shots-dir the welcome pages and the Settings groups are written there, as welcome-*.png in the
# language of E2E_LANG (default de_DE.UTF-8).
#
# PRIVACY: a COPY of app/demo in a throwaway dir (STEUER_DEMO_DIR points demo mode at it), an empty
# environment (no credentials, no LLM), HOME/XDG, cwd, TRANSACTIONS_DATA_DIR and LEDGER_DB_PATH inside it.
# Without the last two the dev tree's own store would be found by walking up from the bundle.
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
SETTINGS="$T/cfg/eu.jumplink.Steuererklaerung/settings.json"

# launch <cwd> [VAR=value …]
launch() {
  stop_app
  local cwd="$1"
  shift
  ( cd "$cwd" && exec setsid env -i LANG="$LANG_E2E" PATH="$PATH" HOME="$T/home" XDG_CONFIG_HOME="$T/cfg" \
      XDG_DATA_HOME="$T/data" XDG_STATE_HOME="$T/state" \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
      WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" DISPLAY="${DISPLAY:-:0}" \
      DOTENV_CONFIG_PATH="$T/empty.env" GJSIFY_DEVTOOLS=1 STEUER_APP_ID="$ID" STEUER_DEMO_DIR="$T/demo" \
      TRANSACTIONS_DATA_DIR="$T/own-data/transactions-data" LEDGER_DB_PATH="$T/own-data/ledger.db" \
      STEUER_APP_SIZE="1100 860" "$@" \
      "$GJSIFY" run "$APP/dist/app/steuer-app.gjs.mjs" >"$T/log" 2>&1 ) &
  APP_PID=$!
  wait_bus
}
wait_bus() {
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
shot() {
  [ -z "$SHOTS" ] && return 0
  mkdir -p "$SHOTS"
  sleep 1.5
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/welcome-$1$SUFFIX.png" >/dev/null || fail "screenshot $1"
}
# shot_as <file name without .png> — for the screenshots under docs/screenshots/.
shot_as() {
  [ -z "$SHOTS" ] && return 0
  mkdir -p "$SHOTS"
  sleep 1.5
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/$1$SUFFIX.png" >/dev/null || fail "screenshot $1"
}
setting() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]))' "$SETTINGS" "$1"; }

if [ "$SUFFIX" = "" ]; then
  L_TITLE="Willkommen bei Steuererklärung"; L_NEXT="Weiter"; L_OK="Verstanden"; L_DEMO="Demo ausprobieren"
  L_START="Demo starten"; L_BANNER="Demodaten"; L_OWN="Eigene Daten verwenden"; L_RESTART="Neu starten"
  L_SETUP="Wo die Daten liegen werden"; L_GENERAL="Allgemein"; L_BACKUP="Jetzt sichern"
  L_AGAIN="Einführung erneut anzeigen"; L_LATER="Später"
  L_GAP="Die Einrichtung ist nicht abgeschlossen"; L_CLOSE="Schließen"
  L_MCP="MCP-Server für externe Agenten"; L_ENGINE="KI-Engine"; L_CONNECT="Externen Agenten verbinden …"
  L_BUSY="Wird gesichert …"
else
  L_TITLE="Welcome to Steuererklärung"; L_NEXT="Next"; L_OK="Understood"; L_DEMO="Try the demo"
  L_START="Start the demo"; L_BANNER="Demo data"; L_OWN="Use my own data"; L_RESTART="Restart"
  L_SETUP="Where your data will be stored"; L_GENERAL="General"; L_BACKUP="Back up now"
  L_AGAIN="Show welcome again"; L_LATER="Later"
  L_GAP="Setup is not finished"; L_CLOSE="Close"
  L_MCP="MCP server for external agents"; L_ENGINE="AI engine"; L_CONNECT="Connect an external agent …"
  L_BUSY="Backing up …"
fi

# ── 1. Fresh HOME → welcome → demo → restart in demo ─────────────────────────────────────────────────
launch "$T/run"
await "$L_TITLE"
[ -e "$SETTINGS" ] && fail "the welcome wrote settings before the person chose anything"
step "fresh HOME without a manifest opens the welcome"
shot start
click "$L_NEXT" GtkButton
await "$L_OK"
click "$L_OK" GtkButton
await "$L_DEMO"
shot choice
click "$L_DEMO" AdwActionRow
await "$L_START"
click "$L_START" GtkButton
sleep 2
wait_bus
await "$L_BANNER"
[ "$(setting welcomeCompleted)" = True ] || fail "welcomeCompleted not recorded"
[ "$(setting preferredMode)" = demo ] || fail "preferredMode: $(setting preferredMode)"
[ "$(setting aiAssistant)" = False ] || fail "aiAssistant must default to off: $(setting aiAssistant)"
[ -e "$T/cfg/steuererklaerung/steuererklaerung.json" ] && fail "the welcome wrote a manifest"
step "„$L_DEMO“ → „$L_START“ restarts the app in demo mode; the choice is in settings.json, no manifest written"

# ── 2. A plain relaunch stays in the demo ────────────────────────────────────────────────────────────
launch "$T/run" STEUER_APP_VIEW=settings
await "$L_BANNER"
absent "$L_TITLE"
await "$L_GENERAL"
await "$L_BACKUP"
step "relaunch without STEUER_DEMO stays in the demo; Settings show „$L_GENERAL“ and the backup group"
shot settings
click "$L_AGAIN" AdwButtonRow
await "$L_TITLE"
click "$L_LATER" GtkButton
absent "$L_TITLE"
step "„$L_AGAIN“ reopens the welcome, „$L_LATER“ closes it"

# ── 3. Banner → own data → setup assistant ───────────────────────────────────────────────────────────
click "$L_OWN" GtkButton
await "$L_RESTART"
click "$L_RESTART"
sleep 2
wait_bus
await "$L_SETUP"
absent "$L_TITLE"
[ "$(setting preferredMode)" = own ] || fail "preferredMode after the switch: $(setting preferredMode)"
step "„$L_OWN“ confirms, restarts into own data and hands over to the setup assistant"

# ── 4. Existing installation: no welcome, no settings file ───────────────────────────────────────────
stop_app
rm -rf "$T/cfg"
mkdir -p "$T/legacy" "$T/cfg"
cp "$T/demo/steuererklaerung.json" "$T/legacy/buchhaltung.json"
launch "$T/legacy"
sleep 4
absent "$L_TITLE"
absent "$L_SETUP"
[ -e "$SETTINGS" ] && fail "an existing installation got a settings file just by starting"
step "an existing installation (buchhaltung.json in cwd) never sees the welcome"

# ── 5. „Later" → setup banner → close → a new gap brings it back ─────────────────────────────────────
stop_app
rm -rf "$T/cfg"
mkdir -p "$T/later" "$T/cfg"
launch "$T/later"
await "$L_TITLE"
click "$L_LATER" GtkButton
absent "$L_TITLE"
[ "$(setting welcomeDeferred)" = True ] || fail "„$L_LATER“ was not remembered: $(setting welcomeDeferred)"
[ "$(setting welcomeCompleted)" = False ] || fail "„$L_LATER“ must not complete the welcome"
launch "$T/later"
await "$L_GAP"
absent "$L_TITLE"
absent "$L_SETUP"
step "„$L_LATER“ is remembered: the relaunch shows the setup banner, not the welcome or the assistant"
shot_as setup-banner
ui click-tip "$L_CLOSE" >/dev/null || fail "cannot close the setup banner"
sleep 1.5
absent "$L_GAP"
[ "$(setting setupBannerDismissed)" = "['no-entity']" ] || fail "dismissal: $(setting setupBannerDismissed)"
launch "$T/later"
sleep 3
absent "$L_GAP"
step "a closed setup banner stays closed across a relaunch"
cat > "$T/later/steuererklaerung.json" <<'JSON'
{ "version": 1, "entities": [{ "id": "eu", "name": "Erika Muster", "kind": "einzelunternehmen", "accounts": [] }] }
JSON
launch "$T/later"
await "$L_GAP"
await "Erika Muster"
step "an entity without a bank account is a new gap and brings the banner back"

# ── 6. Settings: AI and MCP apart, the agent config, a backup in the background ──────────────────────
launch "$T/run" STEUER_DEMO=1 STEUER_APP_VIEW=settings STEUER_APP_SIZE="1100 1500" STEUER_APP_SCROLL=end
await "$L_ENGINE"
await "$L_MCP"
step "Settings show the assistant and the MCP server as separate groups"
shot_as ai-mcp-settings
click "$L_CONNECT" AdwButtonRow
await "Claude Desktop"
await "STEUER_WORKSPACE"
step "„$L_CONNECT“ shows a ready-to-copy config per client"
shot_as mcp-clients
launch "$T/run" STEUER_DEMO=1 STEUER_APP_VIEW=settings
await "$L_BACKUP"
ui click "$L_BACKUP" AdwButtonRow >/dev/null || fail "cannot click „$L_BACKUP“"
await "$L_BUSY"
# No shot_as: its pause would outlast the backup.
if [ -n "$SHOTS" ]; then
  gjs -m "$HERE/dbus-shot.js" "$ID" "$OBJ" "$SHOTS/backup-running$SUFFIX.png" >/dev/null || fail "screenshot backup-running"
fi
await "$L_BACKUP"
ls "$T/data/eu.jumplink.Steuererklaerung/backups/"* >/dev/null 2>&1 || fail "the background backup wrote nothing"
step "„$L_BACKUP“ runs in a child process: the window shows „$L_BUSY“, then the backup exists"

echo "welcome e2e: all steps passed"
