# ERiC: validation and submission

Moved out of AGENTS.md. The one rule that stays there: ERiC is never committed to this repo.

- ERiC is the tax authority's native lib: **proprietary + version-expiring** → NEVER committed
  to this repo, even encrypted (git-secret is wrong for it — see
  [`packages/eric/README.md`](packages/eric/README.md)). The repo holds only our wrapper
  (`packages/eric/src` — Vala binding + koffi).
- The vendor licence (§ 4 (1)) allows shipping ERiC together with our own software as one
  product. Official release builds do: the release pipeline fetches a slim ERiC 44.3.6.0 from a
  private repo (secret `ERIC_DEPLOY_KEY`, a read-only deploy key; without it the build has no
  ERiC) and `app/dev/ship-eric.ts` adds it to the payload at `lib/steuererklaerung/eric/<platform>/`. Nothing of ERiC is ever in
  THIS repo. Forks and self-builds keep working with their own ERiC (`ERIC_HOME`). Sublicensing and
  passing the right on to third parties stay forbidden (§ 4 (3)); the app shows the
  Datenschutzschreiben before the first send (§ 5) and points at the local log files (§ 15).
  Lookup order: `ERIC_HOME`, bundled copy, per-user data dir. The slim runtime
  (`packages/eric/src/platform.ts`) has tax years ≥ 2024 only.
- **Setup:** download ERiC (developer registration at elster.de) into
  the per-user data dir via `elster setup` (or point `ERIC_HOME` at a runtime); build our GJS
  binding once with `gjsify run -w @steuererklaerung/eric build:meson` (needs `meson`/`valac`,
  NOT ERiC → gitignored `packages/eric/prebuilds/`). The binding dlopens ERiC by absolute path
  (`eric-shim.c`), so no `LD_LIBRARY_PATH` is needed.
- **ERiC is OPTIONAL** — everything except validate/submit works without it, and the
  loader degrades to an actionable message (no GI crash). Schemas/examples ship under
  `app/elster/ERiC-*` (gitignored); `app/elster/README.md` documents the local layout.

## Flathub build: user-provided ERiC in the sandbox (#172)

The Flathub build ships no ERiC and no Hersteller-ID (licence § 4). It does ship our GJS binding
(`libsteuereric.so` + typelib, built by the `steuererklaerung` module through `meson`; no ERiC is
needed to build it), otherwise a user-provided ERiC could never be loaded. The CI job `flatpak`
asserts that the binding is in the build and that no `libericapi*` is. Status of the checklist:

| Checkpoint | Evidence | Status |
|---|---|---|
| Binding is in the ERiC-less Flatpak | manifest builds it; CI step "The build carries the ERiC binding"; `meson install` into a prefix checked locally | ok (real Flatpak build not run here, CI is the gate) |
| `ericDataDir()` lands in `~/.var/app/<id>/data/steuererklaerung/eric` | `eric-sandbox.test.ts` with the sandbox's `XDG_DATA_HOME` | ok (path logic); filling it by `elster setup` in the sandbox: offen |
| Lookup order, source reported (`config`, `env`, `data`) | `eric-runtime.test.ts`, `eric-sandbox.test.ts` | ok |
| `ERIC_HOME` via `flatpak override --env --filesystem` | path logic as above; the override itself never ran | offen |
| Folder from the file-chooser portal (`/run/user/…/doc/…`) | source `config` and path handling tested; ERiC logs now fall back to the data dir when the folder's parent cannot take a `logs/` entry | `dlopen` of `libericapi.so` + `lib/plugins` and ERiC writing logs through the portal: offen |
| Own Hersteller-ID used; placeholder blocks before ERiC | `submit.test.ts` (`hasPlaceholderHerstellerId`, readiness blocker) | ok |
| No ERiC → "not available", no crash, XML export works | `eric-sandbox.test.ts` (`getEricStatus`), `eric-binding.test.ts`; XML export needs no ERiC | ok (in-app status text in the sandbox: offen) |
| Demo XML validates, privacy dialog before send, with a user-provided ERiC | needs a real ERiC in a running sandbox | offen |

The issue stays open until the offen rows ran in a real sandbox.
