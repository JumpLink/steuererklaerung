# AGENTS.md — steuererklaerung

Operating guide for AI agents working in the **steuererklaerung** repo. Compressed on
purpose; follows the [agents.md](https://agents.md/) convention. The werkstatt-level
[AGENTS.md](../../AGENTS.md) has the broader workspace rules + the API-client
conventions; this file is the steuererklaerung-specific layer. Command reference:
[`app/README.md`](app/README.md).

## What this is

A TypeScript CLI that **runs on GJS** (via the gjsify toolchain, not Node) for
Qonto · Paperless-NGX · FinTS · **ELSTER** (USt-VA, Anlage EÜR,
USt-Jahres, GewSt 1 A, gesonderte+einheitliche Feststellung). The same actions back
three frontends: the CLI, an **MCP server** (`app/src/index.ts mcp`), and a read-only
**Hono-on-GJS web review UI** (`steuer web`).

## Repo topology & commits

- **One git repo, two gjsify workspaces:** `app/` (the app) + `packages/eric/` (our ERiC
  wrapper). They are plain DIRECTORIES of this repo — NOT nested submodules. The only
  submodules are `refs/*` (vendored reference sources). Install with `gjsify install`
  (never `npm install` — it prunes the gjsify-managed deps).
- This repo is itself a **submodule of werkstatt** → commit here on `main`, then bump
  the pointer in the werkstatt parent (`chore: bump steuererklaerung (…)`). Never stage
  across that boundary in one commit.
- Conventional commits (`feat(scope): …`, `fix(eric): …`). Run check + test + format
  before committing. Never `--no-verify`.

## Run / build / test (it runs on GJS via gjsify)

- **Run a command:** `gjsify run start <args>`. `gjsify run` forwards args straight to
  the gjs bundle, so **no `--` separator is needed** (unlike npm). Named options as
  `--opt=value` or `--opt value` reach the script directly — e.g.
  `gjsify run start paperless documents --query="…"`, `gjsify run start paperless document 2889`.
- `gjsify run start` (the `start` script) sets `GI_TYPELIB_PATH`/`LD_LIBRARY_PATH` for the
  native bridges; a bare `gjs -m dist/…` won't find them.
- **Rebuild after source changes:** `gjsify run build` (→ `dist/steuer.gjs.mjs`).
  Paperless/read commands run off the existing bundle, but **elster/tax-logic changes
  need a rebuild** before the CLI reflects them.
- `gjsify run check` (tsc + `check:glossary` + `check:fields` + `check:ai`, covers the web client too) ·
  `gjsify run lint` · `gjsify run format` (write) / `format:check` · `gjsify run test` (700+ tests,
  built+run on the GJS bundle; register a new `*.test.ts` in `tests/test.mts`).
- **`check:fields`** listet jedes schreibbare Schema-Feld ohne Oberfläche im Desktop-Frontend.
  Neues Feld im Manifest-Schema → entweder eine Zeile dafür bauen oder es in
  `app/dev/field-coverage.allow.json` mit Begründung eintragen; die Liste soll schrumpfen. Sie ist
  entstanden, weil jede bis dahin gefundene Lücke (Steuernummer, Klassifizierungsregeln,
  Gewerbesteuer, Kinder) dadurch gefunden wurde, dass jemand darüber gestolpert ist.
- **`check:ai`** listet jede Datei, die die KI erreicht (`getLLMProvider`, Agent-SDK), und verlangt je einen
  Weg ohne KI in `app/dev/ai-boundary.allow.json` (`ohneKi`, ggf. `idee`); veraltete Einträge sind rot.
- Most read commands print JSON → pipe through `jq`.
- **MCP tools may be absent** in a given session (not surfaced as deferred tools) —
  then drive the CLI directly.

## ELSTER config & the 2025 GbR

- Entity commands pick the firm with `--entity <id>` (e.g.
  `gjsify run start elster euer report --entity gbr --year 2025`) — fail-loud with the
  known-id list on an unknown id, defaulting to the first business entity when omitted. The
  per-file `ELSTER_CONFIG=…` override and the `--config` flag are **gone**. Each entity's tax
  data is the inline `elster` section of the consolidated **`steuererklaerung.json`** (v1 manifest,
  **gitignored** — real Steuernummern + partner IdNrn); NEVER git-add it. Template:
  `app/steuererklaerung.example.json`. First-time upgrade from the old split configs:
  `gjsify run start config migrate` (writes a `.bak`, keeps the originals).
- **The rename fallback is load-bearing — do not "simplify" it away.** The project was `buchhaltung`
  before it was `steuererklaerung`. `getManifestPath()` prefers `steuererklaerung.json`, falls back
  to `buchhaltung.json`, and prints ONE notice on the fallback; `BUCHHALTUNG_WORKSPACE` and
  `BH_DEMO` still work, and the ELSTER-PIN keyring lookup reads the old libsecret schema too. The
  manifest is resolved from `process.cwd()`, so nothing may auto-move it: a write must land in the
  file that was READ, never fork a second one. Covered by `tests/unit/config/rename-fallback.test.ts`
  — the Altbestand case, not just a fresh install.
- The setup this was built against — worth knowing because it shapes the code paths: a
  **dissolved GbR** (Betriebsaufgabe mid-year, its bank account closed, history imported as
  `camt:` accounts) whose business continued as a **successor Einzelunternehmen** on a live
  `qonto:` account, plus one or more `privat` ESt entities. Names, Steuernummern and account
  keys all live in the gitignored `steuererklaerung.json` — never in code, docs or commits.
- The **EÜR is transaction-driven** (`src/core/elster/euer-transactions.ts`): each `camt:`
  bank tx is classified by its linked Paperless receipt or by a rule. **Non-cash items
  come from the config `adjustments` block** (Bruttomethode): AfA via
  `src/core/elster/afa.ts` (Anlageverzeichnis, linear, pro-rata to a Betriebsaufgabe),
  Privatanteile (deemed income + USt), per-partner Sonderbetriebsausgaben (Feststellung
  level), and Betriebsaufgabe → Aufgabegewinn/-verlust (`src/core/elster/betriebsaufgabe.ts`,
  §16/§34, GewSt-frei). USt/GewSt/Feststellung all derive from the same EÜR aggregate.
  The last Steuerberater-prepared return is the reference the rules are validated against.
- Reports: `elster euer report --year 2025 --by transactions [--detail]`,
  `elster {uste,gewst,feststellung} report`, `elster euer generate-xml` + `validate-eric`.

## Steuerrechtliche Quellen & Konstanten — IMMER zentral belegen

Diese App ist self-service (kein Steuerberater) → jede Zahl muss **gegenprüfbar** sein.
- **Jede** steuerrechtliche Konstante / Formel / Annahme im Code (Tarif, Grundfreibetrag,
  Pauschbeträge, §35a-Deckel, Fristen, Umrechnungskurse, …) wird **zentral** in
  [`docs/references/tax-sources.md`](docs/references/tax-sources.md) mit **Quelle + Abrufdatum +
  Veranlagungszeitraum** hinterlegt; der Code verweist per Kommentar dorthin. **Nie** eine
  steuerliche Zahl ungequellt hardcoden.
- **Viele Werte ändern sich jährlich** — Konstanten pro VZ führen, vor jeder Abgabe eines Jahres
  die verlinkten Quellen gegen den aktuellen Stand prüfen und die Registry **aktuell halten**.
- **Prüf-Reihenfolge:** Gesetzestext (gesetze-im-internet.de) → amtliches BMF-Handbuch
  (EStH/LStH, jahresgenau) → seriöser Spiegel (nwb/haufe/dejure/finanz-tools) zur Bestätigung.
  ELSTER/ERiC ist die verbindliche Validierung; App-Zahlen sind Schätzung/Vorbereitung.

## ERiC (validation/submission) — bring-your-own, never bundled

- ERiC is the tax authority's native lib: **non-redistributable + version-expiring** →
  NEVER committed, even encrypted (git-secret is wrong for it — see
  [`packages/eric/README.md`](packages/eric/README.md)). We ship only our wrapper
  (`packages/eric/src` — Vala binding + koffi).
- **Setup:** download ERiC (developer registration at elster.de) into
  `app/elster/runtime/` (= default `ERIC_HOME`) via `elster setup`; build our GJS
  binding once with `gjsify run -w @steuererklaerung/eric build:meson` (needs `ERIC_HOME` +
  `meson`/`valac` → gitignored `packages/eric/prebuilds/`). To run a validate, also
  `export LD_LIBRARY_PATH="$ERIC_HOME/lib:$ERIC_HOME/lib/plugins:$LD_LIBRARY_PATH"`.
- **ERiC is OPTIONAL** — everything except validate/submit works without it, and the
  loader degrades to an actionable message (no GI crash). Schemas/examples ship under
  `app/elster/ERiC-*` (gitignored); `app/elster/README.md` documents the local layout.

## Privacy / never commit

`.env`, `steuererklaerung.json` **and `buchhaltung.json`** (the v1 manifest — real account keys +
tax IDs; the second is its pre-rename filename, still live on existing installs and still read)
plus any legacy `*-config*.json` and `*.json.bak-*` migration backups, `app/elster/**`
(ERiC binaries/JAR/schemas + generated `*.xml` with real tax data), `dist/`,
`transactions-data/`, `fints-data/`, `docs/documents/` (scanned Belege). All
gitignored, with defensive ERiC patterns in the repo-root `.gitignore`. Never leak
client names, financial figures, tax IDs or IBANs into commits/PRs/issues.

## Licence

Apps (`app/`, repo root) are AGPL-3.0-or-later; every package under `packages/*` is
LGPL-3.0-or-later with its own `LICENSE` + `COPYING`. A package must never depend on
`app/`. No SPDX headers in sources.

## Where things live

| Area | Path |
|---|---|
| API clients (hand-rolled REST) | `app/src/core/clients/{qonto,fints,inwx,camt,paypal,amazon,…}` (the Paperless + store clients are workspace packages under `packages/`) |
| Actions (business logic; shared by CLI/MCP/web/app) | `app/src/core/actions/**` |
| ELSTER core (pure) | `app/src/core/elster/**` (euer-transactions, euer-aggregate, afa, betriebsaufgabe, feststellung, gewst, uste, *-xml, eds-envelope) |
| Config (Zod, one `steuererklaerung.json` v1 manifest) | `app/src/core/config/` = `schema/*` (section schemas) + `manifest.ts` (load/mutate) + `accessors.ts` + `entities.ts` + `migrate.ts` |
| CLI commands (yargs) | `app/src/frontends/cli/**` |
| MCP tools | `app/src/frontends/mcp/tools/**` |
| Web review UI (Hono + Adwaita-web) | `app/src/frontends/web/**` |
| Native GNOME/Adwaita app | `app/src/frontends/desktop/**` |
| ERiC wrapper (Vala + koffi) | `packages/eric/` |

## API client conventions

The REST clients are hand-rolled and share one shape — follow the matching rule, do not invent a
new pattern per client.

[Qonto]|dir: `app/src/core/clients/qonto/`
|auth: Login+SecretKey env `QONTO_SIGN_IN` / `QONTO_SECRET_KEY`; `QONTO_PRODUCTION_*` /
`QONTO_STAGING_*` override per `QONTO_ENV`; opt: `QONTO_BASE_URL`, `QONTO_STAGING_TOKEN`
|structure: `request.ts` (`get/post/patch/deleteRequest/postMultipart/listAll`) + one module per
resource (`transactions.ts`, `attachments.ts`, …) + shared `types.ts` + `index.ts` re-exports
|paths relative to `baseUrl/v2/`
|refs: 1) `n8n-nodes-qonto-api` → `nodes/Qonto/Qonto.node.ts` (paths/query/body) + `helpers.ts`
(date formats, pagination) 2) https://docs.qonto.com/ 3) `@qonto/embed-sdk` = types only, do NOT
depend on it for endpoints (OAuth-only; we use Login:SecretKey)

[New endpoint]|1 look up the exact path + params in the ref source |2 add/reuse types in
`types.ts` |3 implement via the shared `request.ts` helpers (`listAll()` for paginated Qonto
lists) |4 export from `index.ts` |5 JSDoc: purpose, params, return, required env vars |6 update
the CLI README if you exposed a new command

## AI document enrichment — one prompt source + a recorded rationale

The Paperless AI-enrichment workflow is unified: it is driven from **one** prompt
source and every AI metadata decision records **why** it was made.

- **Prompt source of truth = `src/core/lib/prompts.ts`.** All enrichment prompt text
  (invoice extraction, classification, metadata-review system rules, and the MCP
  prompt text) lives here — never duplicate prompt strings into a frontend.
- **`ai_note` (KI-Hinweis) convention.** Every AI-made metadata decision records a
  short rationale into the Paperless custom field `ai_note`: **what** the review
  changed/resolved + **provenance** (model), as ONE concise German line (< 200
  chars), overwriting any prior note (fresh each review). The
  `paperless review-metadata` action writes it automatically (deterministic
  post-step in `src/core/actions/paperless/review-metadata.ts` —
  `buildAiNoteRationale` + `applyAiNoteToPayload`, gated by `--dry-run`); external
  agents must set the same field via `paperless_update_document`.
- **Two AI-usage modes, both drawing from `prompts.ts`:**
  - **External** — Claude Code (or another MCP client) drives the workflow through
    the `paperless_*` + `document-workflow` MCP tools, guided by the MCP **prompts**
    below; and the headless `paperless review-metadata` CLI runs the same rules.
  - **Internal** — the app assistant runs the same review in-process via
    `reviewMetadata()`, consuming `REVIEW_METADATA_SYSTEM_PROMPT_*` directly.
- **Registered MCP prompts** (`src/frontends/mcp/prompts.ts`, read-only, exposed
  regardless of `mcp.allowWrite`; text sourced from `src/core/lib/prompts.ts`):
  - `review_document_metadata` — per-document metadata-review rules + how to drive
    it via the `paperless_*` tools and record the rationale into `ai_note`
    (`getReviewDocumentMetadataPromptText` + `REVIEW_METADATA_MCP_USAGE_NOTE`).
  - `enrich_paperless_documents` — the higher-level batch workflow (select →
    analyze → classify `data_scope` → find related → validate → update + link →
    record `ai_note`; private vs business closing steps)
    (`ENRICH_PAPERLESS_DOCUMENTS_PROMPT`).
