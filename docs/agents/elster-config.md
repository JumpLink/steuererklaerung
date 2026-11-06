# ELSTER config, rename fallback and the EÜR model

Moved out of AGENTS.md. The two rules that stay there: never git-add the manifest, never remove the rename fallback.

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
