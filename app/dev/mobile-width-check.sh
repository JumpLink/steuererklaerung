#!/usr/bin/env bash
# The phone-width guard is now the 360×760 slice of responsive-check.sh (one case list, not two).
#
#   app/dev/mobile-width-check.sh [case …]     case = view[:tab] or view@ENVVAR (default: all)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export HEADLESS_RUN="${HEADLESS_RUN:-$HERE/../../../../scripts/headless-run}"
[ -x "$HEADLESS_RUN" ] || HEADLESS_RUN="$(command -v headless-run || true)"
[ -x "$HEADLESS_RUN" ] || { echo "headless-run not found (set HEADLESS_RUN)" >&2; exit 2; }
export HEADLESS_RUN RESPONSIVE_SIZES=360x760
exec "$HERE/responsive-check.sh" "$@"
