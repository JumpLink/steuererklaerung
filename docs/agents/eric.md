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
