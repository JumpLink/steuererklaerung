#!/usr/bin/env bash
# Extract translatable strings and compile the catalogues.
#
#   dev/i18n.sh extract    refresh po/<domain>.pot and merge it into every po/*.po
#   dev/i18n.sh compile    build dist/locale/<lang>/LC_MESSAGES/<domain>.mo
#
# ONE xgettext invocation covers TypeScript and Blueprint, which is not obvious: xgettext has no
# Blueprint parser at all (0.26 rejects `--language=Blueprint` outright), but Blueprint's `_("…")`
# and `C_("ctx", "…")` are lexically function calls -- exactly what the JavaScript scanner collects.
# Measured on a .blp holding both forms plus one unmarked literal: the marked strings come out and
# the unmarked one stays out.
set -euo pipefail

cd "$(dirname "$0")/.."
DOMAIN='eu.jumplink.Steuererklaerung'
POT="po/$DOMAIN.pot"

case "${1:-}" in
extract)
    # `--from-code` matters: without it xgettext refuses any non-ASCII msgid, and German source
    # strings that have not been converted yet are full of them.
    find src -type f \( -name '*.ts' -o -name '*.blp' \) -not -name '*.spec.ts' | sort > po/POTFILES.in
    xgettext \
        --files-from=po/POTFILES.in \
        --output="$POT" \
        --from-code=UTF-8 \
        --language=JavaScript \
        --keyword=_ \
        --keyword=_n:1,2 \
        --keyword=_p:1c,2 \
        --keyword=C_:1c,2 \
        --add-comments=TRANSLATORS \
        --package-name="$DOMAIN" \
        --msgid-bugs-address='https://github.com/JumpLink/steuererklaerung/issues'
    while read -r lang; do
        [ -n "$lang" ] || continue
        # `--previous` keeps the old msgid next to a fuzzy match, which is the only thing that makes
        # a reworded string reviewable instead of guesswork.
        msgmerge --update --previous --backup=none "po/$lang.po" "$POT"
    done < po/LINGUAS
    printf 'extracted %s msgids\n' "$(grep -c '^msgid "' "$POT")"
    ;;
compile)
    while read -r lang; do
        [ -n "$lang" ] || continue
        out="dist/locale/$lang/LC_MESSAGES"
        mkdir -p "$out"
        # `--check` refuses a catalogue whose format specifiers do not match its msgid: a `%s`
        # dropped in translation is a crash at the call site, not a cosmetic defect.
        msgfmt --check --output-file="$out/$DOMAIN.mo" "po/$lang.po"
        printf 'compiled %-6s -> %s\n' "$lang" "$out/$DOMAIN.mo"
    done < po/LINGUAS
    ;;
*)
    printf 'usage: %s <extract|compile>\n' "$0" >&2
    exit 2
    ;;
esac
