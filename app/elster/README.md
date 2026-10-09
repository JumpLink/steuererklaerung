# `cli/elster/` — local ELSTER working directory

Everything in this folder is **machine-local and gitignored** (this README is the
only tracked file). It holds two kinds of non-committable things:

| Path | What | Why ignored |
|------|------|-------------|
| `runtime/` | the **user-provided ERiC runtime** (`lib/libericapi.so` + `lib/plugins/…`) — the default `ERIC_HOME` | ERiC is **not redistributable** (see below) |
| `downloads/` | the ERiC `.jar` you downloaded from elster.de, consumed by `elster setup` | same |
| `ERiC-*`, `*.jar`, `*.zip` | the extracted ERiC distribution + its docs/schemas | same |
| `*.xml` | generated ELSTER submission files (Anlage EÜR / USt / GewSt / Feststellung) | contain **real tax data** |

## You only need ERiC for `validate-eric` / submission

Bookkeeping, the EÜR/USt/GewSt/Feststellung computation, **XML generation**, the
Datenblätter and the whole test suite all run **without** ERiC. Only
`elster … validate-eric` (ERiC plausibility checks) and electronic submission need
the native library — and the loader degrades to an actionable message if it's absent.

## Getting ERiC (bring your own)

1. Register as a developer and accept the licence at
   <https://www.elster.de/elsterweb/entwickler/infoseite/eric>.
2. Put the downloaded `.jar` in `downloads/` and run `steuererklaerung-cli elster setup`
   (extracts into `runtime/`), **or** point `ERIC_HOME` at an existing install
   (the directory containing `lib/libericapi.so`).
3. Build the GJS binding once: `gjsify run -w @steuererklaerung/eric build:meson`
   (needs `ERIC_HOME` + `meson`/`valac`; outputs the gitignored
   `packages/eric/prebuilds/`).
4. To run a command that uses ERiC, also put the ERiC libs on the loader path:
   `export LD_LIBRARY_PATH="$ERIC_HOME/lib:$ERIC_HOME/lib/plugins:$LD_LIBRARY_PATH"`.

## ERiC-Prüfung der Demodaten

`app/dev/eric-demo-check.sh` runs every return the app builds from the demo workspace (`app/demo/`, invented
data) through ERiC — **validate only, nothing is sent**: Anlage EÜR, USt-Jahreserklärung, GewSt 1 A and
Feststellung for 2024–2026, the private ESt, and USt-VA quarters 2024–2026. It works on a throwaway copy of
the demo, adds what the E2Es add by hand (the two Erstattungen linked, the Bewirtungen split 70/30), and
keeps ERiC's log in that copy instead of `logs/`:

```sh
cd app && gjsify run build:gjs && dev/eric-demo-check.sh [out-dir]
```

Each return prints `pass`, `FAIL` (exit 1) or `n/a` with ERiC's first message. `n/a` today: EÜR, GewSt,
Feststellung and ESt 2026 (ERiC 43.4.6.0 has no plugin for them yet), the Feststellung before 2025 (Anlage
FE 1, not built) and ESt years the demo has no Lohnsteuerbescheinigung for. The remaining Hinweise (W-IdNr,
Entnahmen/Einlagen in FE-G Zeile 191/192) do not fail a return. The demo's IdNrn are ERiC test numbers (leading
`0`, valid check digit — ERiC-Entwicklerhandbuch, „Test-Steueridentifikationsnummer"); ERiC accepts them with
the Testmerker the demo sets.

The full **licensing + distribution strategy** (private repo → open source →
Flatpak, and why `git-secret` is the wrong tool for ERiC) lives in
[`packages/eric/README.md`](../../packages/eric/README.md#distribution-strategy-private-repo--open-source--flatpak).
