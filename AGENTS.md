# AGENTS.md — steuererklaerung

Operating guide for AI agents in the **steuererklaerung** repo ([agents.md](https://agents.md/)
convention). The werkstatt-level [AGENTS.md](../../AGENTS.md) has the broader workspace rules;
this file is the steuererklaerung layer. Command reference: [`app/README.md`](app/README.md).

A TypeScript CLI that **runs on GJS** (gjsify toolchain, not Node) for Qonto · Paperless-NGX ·
FinTS · **ELSTER** (USt-VA, Anlage EÜR, USt-Jahres, GewSt 1 A, gesonderte+einheitliche
Feststellung). The same actions back three frontends: the CLI, an **MCP server**
(`app/src/index.ts mcp`), and a read-only **Hono-on-GJS web review UI** (`steuer web`).

## Repo topology & commits

|**One git repo, two gjsify workspaces:** `app/` + `packages/eric/` (our ERiC wrapper) are plain
DIRECTORIES, NOT nested submodules; the only submodules are `refs/*`
|install with `gjsify install`, never `npm install` (it prunes the gjsify-managed deps)
|`@lotse/*` comes from npm (`^0.3.0`, `gjsify-lock.json`): `gjsify install --immutable` works, in
CI too; for UNRELEASED lotse only `gjsify link ../lotse`, and `gjsify unlink` +
`gjsify install --immutable` before committing (`--immutable` refuses while `.gjsify-link.json`
exists) — traps: [`docs/app/lotse-entwicklung.md`](docs/app/lotse-entwicklung.md)
|this repo is a **submodule of werkstatt**: commit here on `main`, then bump the pointer in the
parent (`chore: bump steuererklaerung (…)`); never stage across that boundary in one commit
|conventional commits (`feat(scope): …`, `fix(eric): …`); check + test + format first; never
`--no-verify`

## Run / build / test

|run: `gjsify run start <args>` — args are forwarded, **no `--` separator**
(`gjsify run start paperless documents --query="…"`); the `start` script sets
`GI_TYPELIB_PATH`/`LD_LIBRARY_PATH`, a bare `gjs -m dist/…` won't find the native bridges
|rebuild: `gjsify run build` (→ `dist/steuer.gjs.mjs`); Paperless/read commands run off the
existing bundle, **elster/tax-logic changes need a rebuild**
|gates: `gjsify run check` (tsc + `check:glossary` + `check:fields` + `check:ai`, incl. the web
client) · `lint` · `format` / `format:check` · `test` (700+ tests on the GJS bundle; register a
new `*.test.ts` in `tests/test.mts`) |`check:fields` / `check:ai` rules:
[docs/agents/check-gates.md](docs/agents/check-gates.md)
|read commands print JSON → pipe through `jq`
|MCP tools may be absent in a session (not surfaced as deferred tools) — then drive the CLI

## ELSTER config

|entity commands pick the firm with `--entity <id>` (fail-loud on an unknown id, default: first
business entity); each entity's tax data is the inline `elster` section of the consolidated
**`steuererklaerung.json`** (v1 manifest, **gitignored**: real Steuernummern + partner IdNrn) —
NEVER git-add it; template `app/steuererklaerung.example.json`
|**the rename fallback is load-bearing — do not "simplify" it away.** The project was
`buchhaltung`: `getManifestPath()` prefers `steuererklaerung.json`, falls back to
`buchhaltung.json`, ONE notice line; the manifest resolves from `process.cwd()`, so nothing may
auto-move it, and a write lands in the file that was READ, never a second one. Test:
`tests/unit/config/rename-fallback.test.ts` (the Altbestand case)
|names, Steuernummern and account keys live only in the gitignored manifest — never in code, docs
or commits
|the EÜR is transaction-driven; non-cash items come from the config `adjustments` block
|details (setup the code was built against, AfA, Betriebsaufgabe, reports):
[docs/agents/elster-config.md](docs/agents/elster-config.md)

## Steuerrechtliche Quellen & Konstanten — IMMER zentral belegen

Self-service app (kein Steuerberater) → jede Zahl muss **gegenprüfbar** sein.
- **Jede** steuerrechtliche Konstante / Formel / Annahme im Code (Tarif, Grundfreibetrag,
  Pauschbeträge, §35a-Deckel, Fristen, Umrechnungskurse, …) steht **zentral** in
  [`docs/references/tax-sources.md`](docs/references/tax-sources.md) mit **Quelle + Abrufdatum +
  Veranlagungszeitraum**; der Code verweist per Kommentar dorthin. **Nie** eine steuerliche Zahl
  ungequellt hardcoden.
- Viele Werte ändern sich jährlich: Konstanten pro VZ führen, vor jeder Abgabe die Quellen
  prüfen, die Registry aktuell halten.
- Prüf-Reihenfolge: Gesetzestext (gesetze-im-internet.de) → BMF-Handbuch (EStH/LStH, jahresgenau)
  → seriöser Spiegel (nwb/haufe/dejure/finanz-tools). ELSTER/ERiC ist die verbindliche
  Validierung; App-Zahlen sind Schätzung/Vorbereitung.

## ERiC

|the tax authority's native lib: **proprietary + version-expiring** → NEVER committed to this
repo, even encrypted (git-secret is wrong for it — [`packages/eric/README.md`](packages/eric/README.md));
the repo holds only our wrapper (`packages/eric/src`, Vala + koffi)
|**optional**: everything except validate/submit works without it; the loader degrades to an
actionable message
|official release builds ship ERiC via a private repo (`ERIC_DEPLOY_KEY`), never THIS repo;
sublicensing stays forbidden (§ 4 (3)). Licence details, setup, lookup order:
[docs/agents/eric.md](docs/agents/eric.md)

## Privacy / never commit

`.env`, `steuererklaerung.json` **and `buchhaltung.json`** (the v1 manifest — real account keys +
tax IDs; the second is its pre-rename filename, still live on existing installs and still read)
plus any legacy `*-config*.json` and `*.json.bak-*` migration backups, `app/elster/**` (ERiC
binaries/JAR/schemas + generated `*.xml` with real tax data), `dist/`, `transactions-data/`,
`fints-data/`, `docs/documents/` (scanned Belege). All gitignored, with defensive ERiC patterns in
the repo-root `.gitignore`. Never leak client names, financial figures, tax IDs or IBANs into
commits/PRs/issues.

## Licence

Apps (`app/`, repo root) AGPL-3.0-or-later; every package under `packages/*` LGPL-3.0-or-later
with its own `LICENSE` + `COPYING`. A package never depends on `app/`. No SPDX headers in sources.

## Where things live

| Area | Path |
|---|---|
| API clients (hand-rolled REST) | `app/src/core/clients/{qonto,fints,inwx,camt,paypal,amazon,…}` (Paperless + store clients are workspace packages under `packages/`) |
| Actions (business logic; shared by CLI/MCP/web/app) | `app/src/core/actions/**` |
| ELSTER core (pure) | `app/src/core/elster/**` |
| Config (Zod, one v1 manifest) | `app/src/core/config/` = `schema/*` + `manifest.ts` + `accessors.ts` + `entities.ts` + `migrate.ts` |
| CLI commands (yargs) | `app/src/frontends/cli/**` |
| MCP tools | `app/src/frontends/mcp/tools/**` |
| Web review UI (Hono + Adwaita-web) | `app/src/frontends/web/**` |
| Native GNOME/Adwaita app | `app/src/frontends/desktop/**` |
| ERiC wrapper (Vala + koffi) | `packages/eric/` |

## Conventions with their own doc

|**API clients** (Qonto auth, `request.ts` shape, adding an endpoint, refs — one shape, do not
invent a pattern per client): [docs/agents/api-clients.md](docs/agents/api-clients.md)
|**AI document enrichment**: prompt text lives ONLY in `src/core/lib/prompts.ts` (never copy
strings into a frontend); every AI metadata decision records a one-line German rationale in the
Paperless custom field `ai_note`; `dms_*` / `contracts_*` MCP tools and registered prompts:
[docs/agents/ai-enrichment.md](docs/agents/ai-enrichment.md)
