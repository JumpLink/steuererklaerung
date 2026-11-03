#!/usr/bin/env bash
# Phone-width guard: opens every sidebar page, the hub tabs and the main dialogs at 360×760 on the
# demo data and FAILS when libadwaita reports "exceeds … width" — the window's minimum width is the
# maximum over all stack pages, so one rigid widget anywhere makes the whole app wider than a phone.
#
#   app/dev/mobile-width-check.sh [case …]     case = view[:tab] or view@ENVVAR (default: all)
#
# Runs under headless-run (private compositor, never the real desktop) and demo data only
# (screenshot.sh sets STEUER_DEMO=1). Not part of `gjsify run check`: it needs a compositor.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HEADLESS="${HEADLESS_RUN:-$HERE/../../../../scripts/headless-run}"
[ -x "$HEADLESS" ] || HEADLESS="$(command -v headless-run || true)"
[ -x "$HEADLESS" ] || { echo "headless-run not found (set HEADLESS_RUN)" >&2; exit 2; }

CASES=("$@")
[ ${#CASES[@]} -gt 0 ] || CASES=(home review review:offen review:alle transactions rechnungen zeiten kontakte
  auswertungen fristen steuer steuer:euer steuer:anlagen steuer:ustva steuer:steuerkonto projekte vertraege konten settings
  transactions@STEUER_APP_TX_DETAIL rechnungen@STEUER_APP_INVOICE_DETAIL=RE-2025-0004
  review@STEUER_APP_EDIT_DOC review@STEUER_APP_LINK_DIALOG settings@STEUER_APP_ADD_ACCOUNT=choose)

fail=0
out="$(mktemp -d)"
for c in "${CASES[@]}"; do
  env_kv=""; spec="$c"
  if [[ "$c" == *@* ]]; then spec="${c%%@*}"; env_kv="${c#*@}"; [[ "$env_kv" == *=* ]] || env_kv="$env_kv=1"; fi
  view="${spec%%:*}"; tab=""; [[ "$spec" == *:* ]] && tab="${spec#*:}"
  rm -f /tmp/steuer-shot.log
  ( [ -n "$env_kv" ] && export "$env_kv"
    STEUER_SHOT_SIZE="360 760" STEUER_SHOT_SETTLE=4 "$HEADLESS" --size 1000x1800 -- \
      "$HERE/screenshot.sh" "$view" "$out/${c//[:@=]/_}.png" ${tab:+"$tab"} >"$out/run.log" 2>&1 )
  hits="$(grep -E 'exceeds .* width' /tmp/steuer-shot.log 2>/dev/null | sed -E 's/^.*Adwaita-WARNING \*\*: [0-9:.]+: //' | sort -u)"
  if [ -n "$hits" ]; then echo "FAIL $c"; echo "$hits" | sed 's/^/     /'; fail=1
  elif [ ! -s "$out/${c//[:@=]/_}.png" ]; then echo "FAIL $c (no screenshot — view did not open)"; fail=1
  else echo "ok   $c"; fi
done
rm -rf "$out"
exit $fail
