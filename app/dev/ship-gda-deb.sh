#!/bin/sh
# Builds libgda 6 for the .deb and stages what `gjsify.ship.formats.deb` carries (#148).
#
# Why the deb carries it: Ubuntu 26.04 ships libgda 5 only, so `gir1.2-gda-6.0` does not exist there
# and the package could not be installed. The rpm keeps depending on Fedora's own libgda6.
#
# Run it where the deb's libraries live, i.e. in an ubuntu:26.04 container — libgda links
# libxml2.so.16 there, which is why the same build cannot ship in the rpm (Fedora has .so.2).
#
#   podman run --rm -v "$PWD":/w -w /w ubuntu:26.04 app/dev/ship-gda-deb.sh --install-deps
#
# Output (app/.gda-stage/, gitignored):
#   gi/    Gda-6.0.typelib and the library under the name the typelib records
#   tree/  the sqlite provider and libgda's data files at the prefix libgda was built for
#
# libgda finds its providers and DTDs under the prefix it was compiled with, so that prefix is
# the install path: /usr/lib/steuererklaerung/gda. No environment variable is involved.
set -eu

GDA_VERSION=6.0.0
GDA_SHA256=995f4b420e666da5c8bac9faf55e7aedbe3789c525d634720a53be3ccf27a670
PREFIX=/usr/lib/steuererklaerung/gda
HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT="$HERE/.gda-stage"

if [ "${1:-}" = "--install-deps" ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
        ca-certificates curl xz-utils meson ninja-build gcc pkg-config \
        libglib2.0-dev libxml2-dev libjson-glib-dev libsqlite3-dev \
        gobject-introspection libgirepository-2.0-dev gir1.2-freedesktop-dev \
        gettext intltool iso-codes libtool xsltproc valac
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/gda.tar.xz" "https://download.gnome.org/sources/libgda/6.0/libgda-${GDA_VERSION}.tar.xz"
echo "${GDA_SHA256}  $work/gda.tar.xz" | sha256sum -c -
tar -xJf "$work/gda.tar.xz" -C "$work"

# The same options as the Flatpak recipe, so the three packages agree on what libgda can do.
meson setup "$work/build" "$work/libgda-${GDA_VERSION}" --prefix="$PREFIX" --libdir=lib --buildtype=release \
    -Dui=false -Dhelp=false -Djson=true -Dsqlcipher=false -Dlibsoup=false -Dlibsecret=false \
    -Dexamples=false -Dtools=false -Ddoc=false -Dldap=false -Dweb=false >/dev/null
ninja -C "$work/build" >/dev/null
DESTDIR="$work/root" ninja -C "$work/build" install >/dev/null

rm -rf "$OUT"
mkdir -p "$OUT/gi" "$OUT/tree${PREFIX}/lib/libgda-6.0/providers" "$OUT/tree${PREFIX}/share"
root="$work/root$PREFIX"
# The typelib records `libgda-6.0.so.6.0.0`; the installed file is `.so.6` with the longer names as
# symlinks, which the staging step would drop. A real copy under the recorded name is what loads.
cp -L "$root/lib/libgda-6.0.so.6" "$OUT/gi/libgda-6.0.so.6.0.0"
cp "$root/lib/girepository-1.0/Gda-6.0.typelib" "$OUT/gi/"
# The provider stays out of gi/: everything with `.so` in that directory is staged flat into it.
cp "$root/lib/libgda-6.0/providers/libgda-sqlite-6.0.so" "$OUT/tree${PREFIX}/lib/libgda-6.0/providers/"
cp -r "$root/share/libgda-6.0" "$OUT/tree${PREFIX}/share/"
strip --strip-unneeded "$OUT/gi/libgda-6.0.so.6.0.0" "$OUT/tree${PREFIX}/lib/libgda-6.0/providers/libgda-sqlite-6.0.so"
echo "staged:"
( cd "$OUT" && find . -type f | sort )
