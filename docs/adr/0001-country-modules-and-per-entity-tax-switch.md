# 1. Country modules and a per-entity switch for German tax features

- Status: **Accepted** for steps 1–3; steps 4–6 planned, not implemented
- Date: 2026-10-09
- Deciders: Pascal Garber
- Related: [Country / tax-module inventory](../architecture/country-inventory.md),
  [Austria feasibility](../research/austria.md)

## Context

The app grew around one German setup: a GbR, its successor Einzelunternehmen and private
ESt entities. German tax law sits everywhere — nav, dashboard KPIs, settings, deadlines, CLI,
MCP tools, web routes — and the [inventory](../architecture/country-inventory.md) maps each spot.
The manifest has no field that says where an entity is taxed; every manifest written so far
means Germany.

Two needs follow from shipping the app as a product. Someone outside Germany, or a German user
who only wants bookkeeping, must be able to turn the German tax features off for one entity
without losing data. And Austria is the next country worth a module.

The existing seam, `hasElster = !!entity.elster`, is presence-based. Turning tax off by dropping
the `elster` section would also drop the classification rules (`elster.klassifizierung`) and the
adjustments the bookkeeping reports read. So the switch has to be a separate field.

## Decision

1. **Two optional fields on each manifest entity.** `country` (ISO 3166-1 alpha-2) and
   `taxModule` (`'de'` | `'none'`). The accessors resolve them as
   `countryOf(e) = e.country ?? 'DE'` and
   `taxModuleOf(e) = e.taxModule ?? (countryOf(e) === 'DE' ? 'de' : 'none')`. A missing field
   means Germany with the tax module on, which is how every existing manifest behaves today.
   The fields are `.optional()`, not `.default()`, so a re-serialised manifest stays
   byte-identical; nothing writes them unless the user changes the switch. No manifest version
   bump, no migration. `country` is the jurisdiction; it is not the invoice issuer's postal
   `countryCode`, and `kind` stays the legal form.
2. **A country registry answers capability questions.** `core/countries/` holds one module per
   tax module (`de`, `none`). `capabilities(entity)` returns booleans — tax filing, VAT return,
   income tax, trade tax, ELSTER, tax forecast, tax deadlines, … — and `EntityModel` carries
   them. `hasElster` and `hasEst` are redefined through the capabilities, so the nav, the tab hub,
   the home dashboard and the web nav follow without per-view edits.
3. **Tax off hides tax, never bookkeeping.** With `taxModule: 'none'` the Tax nav and hub, tax
   KPIs (forecast, reserve), ELSTER/ERiC settings and tax deadlines disappear. Transactions,
   categorisation, receipts, invoices, projects, contacts, time, the EÜR-based bookkeeping
   reports and accounts keep working, because the `elster` section stays loaded.
4. **The edges refuse instead of hiding silently.**
   - CLI: the `elster` group and `zve` fail with a message naming the entity and how to turn the
     module back on. `elster euer report`, `explain`, `reclassify` and `setup` stay available:
     they are the bookkeeping view and categorisation, or touch no entity. `umsatz-aufstellung`
     (a revenue listing) and `bmf-kurse` (global exchange rates, no entity) are not guarded.
   - MCP: tools stay registered and refuse **per call** when the resolved entity has the module
     off — `entity` from the call, else the same default the tool uses (privat for
     `elster_zve`). One server serves a mixed workspace, so filtering at registration would hide
     a tool from the German entity next door. The tax-only list is `TAX_ONLY_TOOLS` in
     `frontends/mcp/tax-guard.ts`; a new German-filing tool goes there. Mixed tools (EÜR report,
     classification, the filing register, `frei_verfuegbar`, `hinweise_*`) keep working and
     report the tax parts as not applicable.
   - Web: the `/api` tax routes (`uste`, `gewst`, `feststellung`, `est`, `wizard`,
     `steuerkonto` and their PDFs) answer 403 with the same message for such an entity.
5. **The switch has a UI.** The setup assistant asks for country and the German tax features
   when it creates an entity; Settings offers the same two controls for an existing entity and
   confirms before switching off ("Tax views will be hidden; your data stays").

## Order of work

1. Schema fields and accessors, with tests that an old manifest resolves to DE/`de`. — done
2. Country registry and `capabilities(entity)` on `EntityModel`; the desktop and web UI follow. —
   done
3. Guards on CLI, MCP and web routes; the switch in the setup assistant and Settings.
4. **Planned, not implemented:** take bookkeeping out of the `elster` section. Classification
   and `klassifizierung`, `adjustments` and the `euer-transactions` engine move to a neutral
   place (classification and ledger) with a read fallback to the old keys; only the EÜR
   aggregation stays in the German module.
5. **Planned, not implemented:** country data hooks — VAT rates, the §14/§19 invoice texts and
   issuer checks, the chart of accounts (SKR03 for Germany), glossary term sets.
6. **Planned, not implemented:** the Austria module, per [research/austria.md](../research/austria.md).

Step 4 must come before step 6. Without it, an Austrian module would have to copy
`euer-transactions` — the classification engine every view uses — and two copies would drift.

## Consequences

- Existing manifests and their behaviour are unchanged; the new fields appear only after a user
  changes the switch.
- An entity with the module off still has its `elster` section, because classification reads it.
  "Off" is a view and guard decision until step 4 separates the data.
- A tool or command that a German-tax-off entity reaches returns a clear refusal, never a
  half-computed German figure.
- The German module is still the code in `core/elster/**`; nothing moved. Steps 4–5 are the
  refactor that makes a second country cheap, and both need golden tests first: filed years
  depend on classification output.
- `docs/references/tax-sources.md` is German. A second module needs its own sources file.
