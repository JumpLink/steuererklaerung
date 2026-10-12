#!/usr/bin/env bash
# Write data/<app-id>.metainfo.xml, the AppStream file the website reads.
#
# `gjsify ship` renders the metainfo from `gjsify.ship` in package.json and has no input for a
# hand-written one, so package.json stays the single source and this file is a snapshot of it:
# English text only, German comes from po/de.po. Re-run after editing `gjsify.ship` and commit the
# result. `appstreamcli validate --no-net data/*.metainfo.xml` checks it.
set -euo pipefail

cd "$(dirname "$0")/.."
ID='eu.jumplink.Steuererklaerung'
BUNDLE='dist/app/steuer-app.gjs.mjs'
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"; [ -z "${PLACEHOLDER:-}" ] || rm -f "$BUNDLE"' EXIT

# Staging only needs a bundle to exist; the metainfo does not depend on its contents.
if [ ! -f "$BUNDLE" ]; then
    mkdir -p "$(dirname "$BUNDLE")"
    echo 'print("placeholder");' > "$BUNDLE"
    PLACEHOLDER=1
fi
mkdir -p dist/locale
gjsify ship --stage --skip-build --out "$STAGE" > /dev/null

# `localeDir` makes ship fold the German catalogue into the file as xml:lang elements; the source
# file keeps the English text and lets the catalogue translate, so drop those.
grep -v 'xml:lang=' "$STAGE/stage/share/metainfo/$ID.metainfo.xml" > "data/$ID.metainfo.xml"
printf 'wrote data/%s.metainfo.xml\n' "$ID"
