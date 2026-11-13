#!/usr/bin/env bash
# Build the CURRENT working tree as a Flatpak and install it for this user, branch `dev`.
#
#   app/dev/flatpak-dev.sh [--run] [--clean]
#
#   --run    start the app after the install
#   --clean  drop the build cache first (a full rebuild; the default reuses it)
#
# The release manifest builds `git HEAD`, so uncommitted work would never reach the Flatpak, and
# the repository itself would have to be cloned on every try. This script swaps that one source
# for a copy of the tracked files as they are on disk (new files need `git add`; ignored files and
# untracked logs stay out) and leaves the manifest in the repo alone.
#
# Everything it creates lives under ~/.cache/steuererklaerung-flatpak-dev, outside every repo: a
# local remote that points into a worktree breaks as soon as the worktree is removed, and
# GNOME Software then reports "Remote listing … not available; server has no summary file".
# Branch `dev` installs next to a release (`master`/`stable`) instead of replacing it. Both use
# ~/.var/app/eu.jumplink.Steuererklaerung for their data, so a dev build sees the release's data.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(git rev-parse --show-toplevel)"
ID='eu.jumplink.Steuererklaerung'
BASE="${XDG_CACHE_HOME:-$HOME/.cache}/steuererklaerung-flatpak-dev"
STAGE="$BASE/src"

RUN=0
for arg in "$@"; do
    case "$arg" in
    --run) RUN=1 ;;
    --clean) rm -rf "$BASE/state" "$BASE/build" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

for tool in flatpak flatpak-builder jq rsync git; do
    command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done

rm -rf "$STAGE"
mkdir -p "$STAGE" "$BASE/state" "$BASE/repo"
cd "$ROOT"
# Submodule entries (refs/*) are directories in the file list: rsync copies only the empty folder
# for them, which is what `disable-submodules` gives the release build too.
git ls-files -z --cached | rsync -a --from0 --files-from=- --ignore-missing-args ./ "$STAGE/"

# The module's git source becomes the staged copy; the manifest sits inside it so the other
# sources' relative paths (build-aux/…, gjsify-sources.json) keep working.
jq '(.modules[] | select(.name == "steuererklaerung") | .sources[] | select(type == "object" and .type == "git"))
      |= {type: "dir", path: "."}' "$ROOT/$ID.json" > "$STAGE/$ID.dev.json"

flatpak-builder --user --install --install-deps-from=flathub --force-clean \
    --default-branch=dev --state-dir="$BASE/state" --repo="$BASE/repo" \
    "$BASE/build" "$STAGE/$ID.dev.json"

echo "installed: $ID//dev   (run: flatpak run $ID//dev)"
[ "$RUN" = 1 ] && exec flatpak run "$ID//dev"
exit 0
