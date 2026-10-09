# @steuererklaerung/eric

ERiC (ELSTER Rich Client) binding for the steuererklaerung CLI, with **two runtimes
behind one facade**:

| Runtime | Implementation | Selected via |
|---------|----------------|--------------|
| Node.js | `koffi` FFI (`src/index.node.ts`, `src/ffi.ts`) | `exports` `node`/`default` |
| GJS     | native `gi://` typelib (`src/index.gjs.ts` → `SteuerEric`, built from `src/vala`) | `exports` `browser` |

Consumers just `import { validateXml, checkIBAN, … } from '@steuererklaerung/eric'`;
the right implementation is resolved automatically per runtime.

## ⚠️ The ERiC library is NOT included (and must not be redistributed)

This package ships **only our own wrapper** — the koffi signatures, the Vala
binding, and a hand-written ABI header (`src/vala/eric-extern.h`). It contains
**no ERiC source, headers, or binaries**.

The ERiC shared library (`libericapi.so` + `libotto.so` / `libeSigner.so` /
`libericxerces.so` + plugins) is provided by the **German tax authorities** under
the *Softwarehersteller-Lizenzvertrag* (Bayerisches Landesamt für Steuern). That
license forbids passing ERiC to third parties / sublicensing (§ 4 (3)) and
restricts use to electronic tax submission (§ 3 (2)). So:

- **Never commit or publish ERiC binaries/headers** with this package.
- Each user downloads ERiC themselves (developer registration + license
  acceptance) from <https://www.elster.de/eportal/infoseite/entwickler> and runs
  `steuererklaerung-cli elster setup`, or points `ERIC_HOME` at an existing install.
- ERiC versions **expire** — keep yours current (the Finanzamt rejects outdated
  ones).

`build/` and `prebuilds/` (our compiled `.so` + GIR + typelib) are gitignored —
they are built locally/in CI, not committed.

## Building the native GJS binding

Requires `meson`, `valac`, `g-ir-compiler`, and the GLib/GObject `-devel`
packages, plus a local ERiC install.

```bash
export ERIC_HOME=/path/to/eric/runtime          # dir containing lib/libericapi.so
gjsify run -w @steuererklaerung/eric build:meson         # → packages/eric/prebuilds/linux-x86_64/
```

This compiles `src/vala/eric.vala` against the user's `libericapi.so` and emits
`libsteuereric.so` + `SteuerEric-1.0.typelib`.

## Running on GJS

The gjsify CLI auto-injects this package's `prebuilds/` onto
`GI_TYPELIB_PATH`/`LD_LIBRARY_PATH` (via `gjsify.prebuilds`). You must **also** put
the user's ERiC libs on `LD_LIBRARY_PATH` so `libericapi.so` and its dependencies
resolve:

```bash
export ERIC_HOME=/path/to/eric/runtime
export LD_LIBRARY_PATH="$ERIC_HOME/lib:$ERIC_HOME/lib/plugins:$LD_LIBRARY_PATH"
```

## What's bound

`initializeEric`, `shutdownEric`, `getVersion`, `getErrorText`, `checkSteuernummer`,
`checkIBAN`, `checkXml` (schema), and `validateXml` (plausibility, via
`EricBearbeiteVorgang` in validate-only mode).

**Submission is intentionally not bound** — the steuererklaerung CLI only *validates*
the USt-VA; the generated XML is uploaded manually in *Mein ELSTER*. (Adding
`EricBearbeiteVorgang` with the certificate/PIN crypto parameters would be the
follow-up if automated submission is ever wanted.)

## Distribution strategy (private repo → open source → Flatpak)

ERiC is licensed to us by the Bayerisches Landesamt für Steuern under the
*Softwarehersteller-Lizenzvertrag*. Three clauses shape everything below:

- **§ 4 (3)** — ERiC may not be passed to third parties or sublicensed.
- **§ 3 (2)** — use is restricted to electronic tax submission.
- ERiC **versions expire** — the Finanzamt rejects outdated ones.

### Rule 1 — never put ERiC in git (not even now, not even encrypted)

A private repo eventually goes public **with its full history**, so anything ever
committed leaks the moment it flips. Keep ERiC out of git **today**.

**`git-secret` does not solve this.** Encrypting + committing still publishes the
ciphertext, and sharing the decryption key with a contributor *is* passing ERiC to a
third party (§ 4 (3)). `git-secret` is the right tool for **our own** secrets
(`.env`, the per-entity `elster-config-*.json` that hold real tax IDs) — never for a
third-party, expiring, non-redistributable binary. (For per-user tax config the
simpler answer is: don't commit it at all — ship `elster-config.example.json` and
gitignore the real ones, which is what we do.)

All ERiC paths are gitignored: `cli/elster/*` (runtime, JARs, schemas, generated
XML) and `packages/eric/{build,prebuilds}`, plus defensive `ERiC-*` / `libericapi.so*`
/ `**/prebuilds/` patterns in the repo-root `.gitignore`. The only tracked files are
**our wrapper** (`packages/eric/src` — Vala binding, koffi signatures, the
hand-written ABI header `src/vala/eric-extern.h`) and the two READMEs.

### Rule 2 — bring-your-own ERiC, per audience

ERiC reaches each machine via a download from elster.de where the user registers as
a developer and accepts the licence. We ship only our wrapper.

| Audience | How ERiC arrives | Notes |
|---|---|---|
| **Dev / contributor** | `steuer elster setup` (or `ERIC_HOME=…`) → gitignored `app/elster/runtime/`; then `gjsify run -w @steuererklaerung/eric build:meson` to compile the binding | **Optional.** App, EÜR/USt/GewSt/Feststellung compute, XML generation, Datenblätter and the full test suite run *without* ERiC; only `validate-eric`/submit need it, and the loader degrades to an actionable message (no crash). |
| **CI** | not needed for the default build/test; an ERiC-exercising job pulls it from a CI secret, never the repo | keep ERiC-dependent tests guarded by `isEricAvailable()` |
| **End user (Flatpak)** | in-app first-run setup — see below | |

### Rule 3 — Flatpak: don't bundle ERiC, fetch it on the user's machine

We can't put ERiC in a Flathub artifact (redistribution). Options, most-realistic first:

1. **In-app first-run setup (recommended).** The app ships and works without ERiC;
   the first time the user hits *Validieren/Übermitteln*, a guided flow opens the
   elster.de developer registration, has them accept the licence, and imports the
   downloaded ERiC into the per-user data dir (`~/.var/app/<app-id>/data/eric/`). Our
   binding then resolves `libericapi.so` from there at runtime via
   `GI_TYPELIB_PATH`/`LD_LIBRARY_PATH`. This also satisfies the **per-user licence
   acceptance** ERiC requires anyway.
2. **Flatpak `extra-data`.** The Flathub-blessed mechanism for non-redistributable
   deps (Steam, Spotify, MS fonts): the manifest carries only a URL + sha256, Flatpak
   downloads it on the *user's* machine at install. **Blocked for ERiC** — the
   download is behind a developer login, version-specific and expiring, so there is no
   stable anonymous URL, and it would bypass per-user licence acceptance. Revisit only
   if elster.de ever exposes a stable URL.
3. **Core-without-ERiC split (always true).** Everything except the final ELSTER
   transmission/validation works with no ERiC, so the Flatpak is useful out of the
   box; only the submit/validate action is gated behind option 1.

### Our binding vs. their library

`libsteuereric.so` + `SteuerEric-1.0.typelib` are **our** code (compiled
from `src/vala` against our hand-written ABI header, not ERiC's), so they are ours to
ship. They `dlopen` the user-provided `libericapi.so` at runtime. For Flatpak we can
prebuild and ship the binding (users need no `meson`/`valac`); for dev, contributors
build it locally into the gitignored `prebuilds/`.

## Licence

[LGPL-3.0-or-later](LICENSE) (see also [COPYING](COPYING)). This covers our wrapper only.
ERiC itself is proprietary and is never shipped with this package.
