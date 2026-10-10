# Country / tax-module inventory

Every place in the code that assumes German tax law, taken before the country switch was built
(commit b16da1e). Paths are relative to `app/` unless stated. Line numbers are from that commit
and drift; search for the symbol instead.

Goal: a per-entity switch "German tax features on/off", so the app also works as plain
bookkeeping and can later get further country modules (Austria next, see
[research/austria.md](../research/austria.md)). The decision and its order of work:
[ADR 0001](../adr/0001-country-modules-and-per-entity-tax-switch.md). Steps 1–3 of §5c are
implemented; the tables below describe the code as it was before them.

## 0. Headline findings

* **No entity-level country/jurisdiction field exists.** The only `countryCode` is the postal country of the invoice issuer (`core/config/schema/entity.ts:54`, default `'DE'` in `core/invoices/issuer.ts:52`, `core/invoices/cii-xml.ts:185,209`). `supplier_country` in `core/config/schema/paperless.ts:52` is a Paperless custom field, not a jurisdiction.
* **A de-facto capability seam already exists, but it is presence-based:** `hasElster = !!entity.elster`, `hasEst = !!entity.est` (`core/presenters/workspace.ts:95-96`). 44 references to `hasElster|hasEst`, 146 to `hasElster|hasEst|kind ===/!== 'privat'`. Nav, tab hub, Home dashboard, Settings, assistant tools already branch on them. "Tax off" for the German module is therefore *mostly* "do not load `elster`/`est`" — but that deletes data, it is not a switch, and it does not stop the bookkeeping core from speaking German tax (see §2 "entangled").
* The `elster` section is the **single container for both German tax config and bookkeeping-relevant config** (`klassifizierung`, `adjustments`, `taxation_basis`, `betrieb`). Turning off ELSTER by omitting the section would also drop classification rules. That is the main schema problem.
* Missing field today = Germany (everything is hardcoded DE). So `country` default `'DE'` keeps all manifests unchanged.

## 1. Desktop UI (`src/frontends/desktop`)

Counts: ~34 files are DE-tax-specific (own the whole file), ~12 contain a DE-tax fragment, ~14 are only touched via terminology.

### 1a. Whole views / nav (hide when tax module off)

| Item | Path | Gate today |
|---|---|---|
| Nav entry "Tax" (`steuer`, Ctrl+n slot!) | `nav.ts:70-76`, `visibleNavItems` `nav.ts:99` | `hasElster \|\| hasEst` |
| Tab hub Steuer: Tax return / Assistant / EÜR / Annexes / USt-VA / Tax account | `views/tab-hub.ts:120-128` (`estOnly`, `businessOnly` flags) | per-tab flags |
| EÜR view | `views/steuer-view.ts` (74 hits), `.blp` | businessOnly |
| Anlagen (Anlage EÜR/AVEÜR/…) | `views/anlagen-view.ts` | businessOnly |
| USt-VA view | `views/ustva-view.ts`, `data/ustva.ts` | businessOnly |
| Steuerkonto | `views/steuerkonto-view.ts`, `.blp` | businessOnly |
| Steuererklärung (Return, Kz lines, Vordruck) | `views/steuererklaerung-view.ts`, `.blp` | always in hub |
| ESt Assistent | `views/steuer-assistent-view.ts`, `assistent-panel.ts` (EST_EXAMPLES) | estOnly |
| Absenden (submit to ELSTER) | `views/absenden-section.ts`, `absenden-dialog.ts`, `data/submission.ts` | – |
| Vor-Abgabe checklist, Herleitung drill-down, Frist-erledigen | `views/vor-abgabe-group.ts`, `views/herleitung-dialog.ts`, `views/frist-erledigen-dialog.ts` | – |
| Fristen view (tax deadlines + open items) | `views/fristen-view.ts`, `data/fristen.ts` | **explicitly not entity-scoped** (nav.ts:67 comment). Mixed: open items are country-neutral, Steuertermine are DE |

### 1b. Settings rows (`views/einstellungen-view.ts:310-380`, `views/einstellungen/*`)

| Group | File | Notes |
|---|---|---|
| Betrieb (Stammdaten, **Steuernummer** row, Finanzamt, Rechtsform) | `einstellungen/betrieb-ust.ts` (50 hits) | `buildBetriebGroup`, `steuernummerRow:164` |
| Umsatzsteuer (**Kleinunternehmer §19**, Ist/Soll, Dauerfristverlängerung) | `einstellungen/betrieb-ust.ts:222 buildUstGroup` | feeds invoices too |
| Gewerbesteuer | `einstellungen/gewerbe-aufgabe.ts:58` | |
| Betriebsaufgabe | `einstellungen/gewerbe-aufgabe.ts:137` | |
| Anlageverzeichnis (AfA), Privatanteile, Sonderbetriebsausgaben | `einstellungen/abschluss.ts:63,162,226` | |
| Klassifizierung (counterparty rules) | `einstellungen/klassifizierung.ts` | **bookkeeping** (lives under `elster.klassifizierung`) |
| Person / Lohn / Vorsorge / Werbung / Abzüge / Entlastung §24b / Kinder / Religion / Steuer-ID | `einstellungen/privat.ts`, `einstellungen/kinder.ts` | est section; all DE |
| ERiC card (ERIC_HOME, status) | `views/konten-view.ts:109-160` | per-entity `eric_home` |
| ELSTER PIN keyring | `data/elster-secret.ts`, `data/eric.ts` | |
| Setup assistant: "Steuernummer" entry | `views/setup-assistant.ts:14-16,220,298` | optional already |
| Learning-mode blurb names "USt-VA" | `einstellungen-view.ts:197` | text only |

### 1c. KPIs / widgets / fragments inside neutral views

| Item | Path |
|---|---|
| KPI "Tax forecast {year}" | `views/home-view.ts:163` (from `core/presenters/home.ts` → `loadDashboard`, `core/elster/home.ts`) |
| KPI/card "Tax reserve {year} (estimate)" | `views/home-view.ts:207`, `core/presenters/frei-verfuegbar.ts`, `core/elster/frei-verfuegbar.ts`, CLI `frei-verfuegbar` |
| Deadline cards (Frist chips) | `home-view.ts` + `core/elster/steuertermine.ts` |
| Tx detail: "Classification (EÜR)", "VAT (Umsatzsteuer)" rows | `views/tx-detail-dialog.ts:136,190,203` |
| Receipt metadata (supplier country, reverse charge) | `views/beleg-metadaten-dialog.ts`, `beleg-eingang-view.ts` |
| Invoice form VAT combo (19/7/0) | `views/rechnung-form-dialog.ts:300`, `zeit-rechnung-dialog.ts` |
| Hinweise actions (USt-ohne-Angabe, Reverse-Charge, …) | `views/hinweis-handlung.ts` |
| Glossary (`?` buttons) | `widgets/glossary-help.ts`; terms in `core/lib/glossary.ts` (de + en copies, 449 lines) |
| Window-level tax hooks | `window.ts:310-313, 338, 439-440, 532` |

### 1d. Glossary (`core/lib/glossary.ts`, ~49 terms × 2 languages)

DE-tax terms (hide/replace): euer, ust-zahllast, vorsteuer, vereinnahmte-ust, abschlusszahlung, gewst-messbetrag, gewerbesteuer, feststellung, einkuenfte, sonderbetriebsausgaben, aufgabe, kleinunternehmer, afa(partly), abgabefrist, steuerkonto, ustva, ist-versteuerung, dauerfristverlaengerung, transferticket, steuerruecklage, anlagegut(+kandidat), gwg, reverse-charge, e-rechnung (§14) ≈ 22. Neutral: gewinn, rohertrag, gesamtleistung, betriebsergebnis, bwa, doppelzahlung, snapshot, freigabe, klassifizierung, privatentnahme, zu-pruefen, laufende-kosten, erstattung, splitbuchung, projektergebnis, dokumentregel, mahnstufe, … ≈ 27. `check:glossary` must learn per-module term sets.

### 1e. Web UI (`src/frontends/web`)

* Client nav `web/client/components/bh-app.ts:67-76` (`steuer` item, gate `hasElster||hasEst` at :214), views `bh-tax-view.ts`, `bh-ustva-view.ts`, `bh-steuererklaerung-view.ts`, `bh-steuerkonto-view.ts`, `bh-fristen-view.ts` (+ hub/assistent), glossary `web/client/lib/glossary.ts`, report helpers `lib/report.ts`.
* Server routes `web/routes.ts:140-150`: `/api/euer`, `/api/uste`, `/api/gewst`, `/api/feststellung`, `/api/wizard`, `/api/est`, `/api/steuerkonto`, `/api/est-intake/apply` (+ `/api/dashboard`, `/api/home`, `/api/hinweise` mixed); `web/report-pdf-routes.ts` (EÜR/USt PDFs).
* ≈ 6 client files, 9 routes, 1 route file.

## 2. Core

### 2a. `core/elster/*` (53 modules). Classification: **P** = pure German tax (hide/replace wholesale), **E** = entangled with bookkeeping (must keep working; needs a neutral extraction), **N** = effectively neutral, only lives in the wrong folder.

"ext" = number of importers outside `core/elster`.

| Module | Class | ext | Why |
|---|---|---|---|
| `euer-transactions.ts` | **E** | 24 | The *transaction ledger classification* (document/rule/manual → category + VAT rate). Used by Buchungen, tx-view, ledger seed, Beleg review, Zu prüfen, aufteilung, erstattungen, CLI `buchungen`. EÜR aggregate is only one consumer. |
| `euer-classify.ts` | **E** | 0 (int 7) | Rule chain → SKR03 category + implied VAT rate. Counterparty rules are generic; categories are SKR03 (DE chart). |
| `euer-aggregate.ts` | **E/P** | 4 | Category → EÜR line (43 Kz refs). The aggregate (income/expense by category) is neutral; the Kz mapping is DE. |
| `bwa.ts` | **N/E** | 3 | BWA = management accounting, but built on SKR03 categories. Keep. |
| `hinweise.ts` | **E** | 12 | Hint engine; mixes neutral hints (Doppelzahlung, offene Forderungen, Zu prüfen) with DE ones (USt ohne Angabe, Reverse Charge, §19, Steuernummer, Anlagegut/GWG, deadlines). Needs per-hint `module` tag. |
| `zu-pruefen.ts`, `splitbuchung.ts`, `erstattung.ts`, `laufende-kosten.ts`, `serie.ts`, `iban-wechsel.ts`, `doppelte-rechnung.ts`, `lieferant-doppelt-bezahlt.ts`, `regel-aus-beispielen.ts`, `projekt-ergebnis.ts`, `kontoauszug.ts`, `anlagegut-kandidat.ts`(P) | **N** | 7,5,2,4,0,1,1,1,3,2,1,1 | Bookkeeping; just live under `elster/`. Move to `core/books/` (or re-export) so "elster" means ELSTER. |
| `frei-verfuegbar.ts` | **E** | 4 | "Free to spend" = balance − tax reserve; reserve term is DE tax forecast. Make the reserve a pluggable input (0 when off). |
| `ustva-aggregate.ts`, `ustva-buchungen.ts`, `ustva-validate.ts`, `ustva-xml.ts`, `uste-aggregate.ts`, `uste-xml.ts` | **P** | 10,1,0,2,12,0 | USt-VA / USt-Erklärung (Kz81/86/66/83…). `uste-aggregate` also feeds Home, Hinweise, cross-checks, steuerblatt PDF. |
| `reverse-charge.ts`, `reverse-charge-kandidat.ts`, `ust-ohne-angabe.ts`, `ust-abweichung.ts` | **E/P** | 1 each | §13b logic; VAT-on-bookings checks. Plain VAT bookkeeping would want the *concept*, DE would supply the rules. |
| `euer-xml.ts`, `est-xml.ts`, `gewst-xml.ts`, `feststellung-xml.ts`, `xml-format.ts`, `eds-envelope.ts`, `vordruck-lines.ts` | **P** | 0–1 | ELSTER XML and Kz form lines. |
| `est-aggregate.ts`, `est-berechnung.ts`, `est-tarif.ts`, `zve-bescheid.ts` | **P** | 1 | §32a tariff, ZvE. (`est-tarif` pulls BMF constants.) |
| `gewst.ts`, `feststellung.ts`, `betriebsaufgabe.ts` | **P** | 9, 8, 2 | GewSt, gesonderte Feststellung, §16/§34. gewst/feststellung are consumed by Home dashboard + wizard. |
| `afa.ts` | **E** | 2 | Depreciation: bookkeeping concept, linear AfA with DE rules (GWG limit, Halbjahres/pro-rata). Keep core, make rules pluggable. |
| `steuernummer.ts`, `pin.ts`, `kontoabfrage-xml.ts`, `kontoabfrage-parse.ts` | **P** | 2,3,1,1 | Steuernummer format (Bundesland → 13-digit ELSTER), ERiC PIN, Steuerkonto query. |
| `fristen.ts`, `steuertermine.ts`, `steuerzahlungen.ts` | **P** | 5,5,6 | Deadlines (10th, Dauerfrist, Jahresabgabefrist, §108 AO weekend shift, **no holiday model**). `steuerzahlungen` also drives open-payment lists. |
| `home.ts` | **P/E** | 6 | Dashboard model (tax forecast + deadlines). |
| `vor-abgabe.ts` | **P** | 1 | pre-submission checklist. |

Totals: ~23 P, ~8 E, ~22 N (of 53).

### 2b. Other core areas with DE tax content

| Area | Path | Class | Detail |
|---|---|---|---|
| VAT rates `[0, 0.07, 0.19]` | `core/actions/documents.ts:257` (`VAT_RATES`); `core/invoices/e-rechnung/prefill.ts:58` (`KNOWN_RATES`); `core/lib/select-field-constants.ts:16` (`TAX_RATE_OPTIONS` incl. COVID 5/16 %); `core/invoices/form.ts:47`, `recurring.ts:20`, `self-provider.ts:150`; `core/actions/umsatz-aufstellung.ts:81-124,210-214` (`rate19/rate7`); `core/actions/elster/cross-checks.ts:283` (hardcoded 0.19/0.07) | **E** | Rates must become per-country data (AT: 20/13/10/4.9, `docs/research/austria.md` §2). |
| Invoice legal text | `core/invoices/cii-xml.ts:65` ("Steuerbefreiung für Kleinunternehmer gemäß § 19 UStG"), `:185,209` (`'DE'` default), issuer §14 check `core/config/schema/entity.ts:42-62`, `core/invoices/issuer.ts`, `self-provider.ts:72-76,420`, PDF text in `core/invoices/` | **E** | Invoicing must keep working; legal sentence + mandatory-fields check should come from the country module (tax number OR vatId, § note). `kleinunternehmer` flag is on the issuer (`entity.ts:62`) AND relevant for ELSTER Ust section. |
| E-Rechnung | `core/invoices/e-rechnung/*` (XRechnung/ZUGFeRD read, §14 classification), `cii-xml.ts` | **E** | EN 16931 is EU-neutral; §14 UStG classification text and rules are DE. |
| SKR03 categories | `core/lib/select-field-constants.ts:32-79` (`ACCOUNTING_CATEGORY_OPTIONS`, `NO_RECEIPT_CATEGORIES`), `core/lib/prompts.ts:28-44` (AI prompt names SKR03 + 19 %/7 %/§13b + "German VAT rate"), `core/lib/qonto-categories.ts` (German labels) | **E** | Chart of accounts is the data model of bookkeeping. Treat as `chartOfAccounts` provided by a country (DE = SKR03; neutral default minimal). Prompts then need templating. |
| Category → Kz | `core/elster/euer-aggregate.ts` (43 Kz refs), `core/elster/vordruck-lines.ts` (24) | **P** | The DE mapping file; the AT equivalent would be E1a lines. |
| BMF exchange rates | `core/config/bmf-rates.ts`, `bmf-import.ts`, `app/bmf-umrechnungskurse.json`; consumers `core/elster/ustva-aggregate.ts`, `core/actions/elster/ustva.ts`, `steuerblatt-pdf.ts`, `est-tarif.ts` | **P** | § 16 Abs. 6 UStG. Neutral FX conversion for bookkeeping would need an ECB-style source. |
| Holidays | none modelled (`core/elster/steuerzahlungen.ts:26`) | – | Weekend shift only. |
| ELSTER actions | `core/actions/elster/*` (26 files: cross-checks, eric-cli, eric-status, est-intake(-topics), est, euer, explain, feststellung, filing-keys, fingerprint, gewst, hinweise, report, signoffs, snapshots, stammdaten, steuerblatt-pdf, steuerkonto, submission-overview, submit, uste, ustva, validate, web-filing, wizard) | **P** (mostly) | `hinweise.ts`, `explain.ts`, `snapshots.ts`, `signoffs.ts` carry generic "filing record / sign-off" concepts; snapshots/signoffs could be country-neutral (a filed return is a filed return). |
| Other tax actions at top level | `core/actions/steuertermine.ts`, `steuerzahlungen.ts`, `validate-steuernummer.ts`, `zve.ts`, `filings.ts` (generic record), `umsatz-aufstellung.ts` (VAT per rate), `est-kinder.ts`, `core/presenters/steuer.ts`, `year-snapshot.ts`, `frei-verfuegbar.ts` | **P/E** | |
| Config / schema | `core/config/schema/elster.ts` (580 lines), `est.ts` (376), `finanzierung.ts` (KfW/BEG, DE funding) | **P** | See §4. |
| Demo data | `core/lib/demo/dataset.ts`, `app/demo/` | – | German demo entity. |
| Tax constants registry | `docs/references/tax-sources.md`, AGENTS.md rule "every constant sourced" | – | Must become per-country (`tax-sources/<cc>.md`). |

### 2c. Entanglement hot spots (the 3 that matter most)

1. **`core/elster/euer-transactions.ts` + `euer-classify.ts`** — the transaction classification engine is *the* bookkeeping ledger, named and typed as EÜR, produces SKR03 category + `vatRate` per booking, and is imported by 24 files across presenters, actions, CLI, desktop and web. Also seeds `core/lib/ledger/seed.ts`. Must be split into neutral `books/classify` (category, vat, source) and DE `eur` (Kz aggregation).
2. **The `elster` manifest section** (`core/config/schema/elster.ts`) — holds DE tax data *and* bookkeeping inputs: `klassifizierung` (rules), `adjustments` (AfA, Privatanteile), `taxation_basis` (ist/soll), `betrieb`, `ust`, `deadline_extension_months`, `eric_home`. `hasElster = !!entity.elster` is also the gate for Settings/Home/Hinweise, so "tax off" currently implies "classification off".
3. **Invoicing legal layer** — `core/invoices/{cii-xml,issuer,self-provider,form,recurring}.ts`, `core/actions/documents.ts:257`, `umsatz-aufstellung.ts`: VAT rates 19/7/0, §14/§19 sentences, `'DE'` defaults, Steuernummer-or-USt-Id check. Invoices are neutral bookkeeping that must keep working with the module off.

(Runner-up: `core/elster/hinweise.ts` mixes neutral and DE hints; `core/lib/prompts.ts` + `select-field-constants.ts` bake SKR03 and German VAT into the AI contract.)

## 3. CLI + MCP

### 3a. CLI (`src/frontends/cli`)

DE-tax-only (`elster` group, `cli/elster/index.ts:22`): `setup`, `euer {report,generate-xml,validate-eric}`, `ustva {report,generate-xml,validate-eric}`, `uste {…}`, `gewst {…}`, `feststellung {…}`, `est {report,generate-xml,pruefblatt,intake-entlastung,intake-kinderbetreuung,intake-haushalt,intake-lohnersatz,validate-eric}`, `submit`, `pin`, `kontoabfrage`, `steuerkonto`, `stammdaten`, `wizard`, `crosscheck`, `signoff {status,sign,revoke}`, `lock`/`snapshot`, `filing record-web`, `explain`, `reclassify`(E: it is a classification command). = **19 command groups / ~45 leaf commands**.
Top-level DE/mixed: `zve` (P), `bmf-kurse import` (P), `umsatz-aufstellung` (E, VAT per rate), `frei-verfuegbar` (E), `hinweise` (E), `fristen` (mixed: open items neutral, Steuertermine DE), `filing` (generic record), `finanzierung darlehen` (DE funding but mostly neutral loan math).
Neutral: `qonto`, `fints`, `paperless`, `belege`, `buchungen`, `transactions`, `invoices`, `contacts`, `reconcile`, `time`, `projects`, `ledger`, `sync`, `mail-eingang`, `camt-export`, `check-apis`, `config`, `demo`, `mcp`, `web`.

### 3b. MCP (`frontends/mcp/tools/*`, 96 tools total)

`tools/elster.ts` registers 33 tools:
* **DE-tax-only (19):** `elster_euer_report`, `elster_explain_figure`, `elster_feststellung_datenblatt`, `elster_gewst_report`, `elster_uste_report`, `elster_stammdaten`, `elster_cross_checks`, `elster_decision_log`, `elster_period_status`, `elster_list_snapshots`, `create_filing_snapshot`, `record_web_filing`, `elster_signoff_status`, `sign_off_filing`, `revoke_signoff`, `elster_submit_readiness`, `submit_filing`, `elster_lock_period`, `elster_zve`.
* **Mixed (3):** `frei_verfuegbar`, `hinweise_list`, `hinweise_ok`.
* **Neutral bookkeeping that merely lives in `elster.ts` (11):** `buchungen_zu_pruefen`, `buchung_bestaetigen`, `erstattungen_list`, `erstattung_entscheiden`, `aufteilungen_list`, `buchung_aufteilen`, `projekt_ergebnis`, `projekt_zuordnen`, `laufende_kosten_list`, `laufende_kosten_entscheiden`, `record_classification`.
Elsewhere (`cross-system.ts`/`reconcile-store.ts`): `list_upcoming_deadlines`, `list_open_tax_payments`, `record_filing`/`list_filings`/`remove_filing`/`attach_filing_document`/`list_filing_documents`/`detach_filing_document` (generic filing archive — keep neutral), `invoices_e_rechnung_lesen` (neutral EN 16931).
Registration is read-only gated by `mcp.allowWrite`; a capability gate would be a second filter at registration time (`frontends/mcp/server.ts`, `tools/elster.ts`). The prompts in `core/lib/prompts.ts` + `frontends/mcp/prompts.ts` reference ELSTER/§13b/SKR03 text.

## 4. Manifest schema

* `core/config/schema/entity.ts` `ManifestEntitySchema` (line ~150): `id, name, kind (free-form string: gbr · einzelunternehmen · privat · …), accounts, dms, invoicing, demo, elster?, est?, finanzierung?, recurring?, projects?, hinweise_geprueft?, laufende_kosten?`. **No `country`, no `jurisdiction`, no `taxModule`.**
* `kind` is free text and *is* currently used as a coarse switch (`kind === 'privat'` hides business views, `nav.ts` `BUSINESS_ONLY`). It conflates legal form with tax regime — do not overload it.
* Manifest is strict-versioned (`MANIFEST_VERSION = 1`, `schema/manifest.ts`); adding an optional field with a default is not a breaking change → no version bump, no `migrate`.
* Related existing places: `IssuerConfigSchema.countryCode` (postal, keep), `ElsterConfig.betrieb.*` (DE tax identity), `est.bundesland`, `app` section (global settings).

**Recommended placement:** two optional fields directly on the entity:

```ts
/** ISO 3166-1 alpha-2; where the entity is taxed. Missing = 'DE' (every manifest written so far). */
country: z.string().length(2).default('DE'),
/** Which country module's tax features are active. 'none' = plain bookkeeping. Missing = the country's module. */
taxModule: z.enum(['none', 'de' /*, 'at' later */]).optional(),   // resolves to country's module if absent
```

Resolution `taxModuleOf(entity) = entity.taxModule ?? (entity.country === 'DE' ? 'de' : 'none')`. Existing manifests: both absent → `country 'DE'`, `taxModule 'de'` → unchanged behaviour. A user in e.g. Switzerland sets `country: 'CH'` → `none`. "German tax off" for a German entity = `taxModule: 'none'`. Keep `country` and `taxModule` separate (jurisdiction ≠ feature switch; also feeds default currency, IBAN checks, locale). Do not touch `issuer.countryCode`.
Note the loader `.default()` makes the field show up in re-serialised manifests — use `.optional()` + an accessor if byte-stable writes matter (`check:fields` also requires either a UI row or an entry in `dev/field-coverage.allow.json` for the new fields; a Settings row "Country / tax module" in the entity dialog `views/entity-dialogs.ts` / setup assistant fits).
Schema consequence for the container problem: keep `elster`/`est` as the `de` module's config blobs, but move `klassifizierung` (and later `adjustments` pieces that are bookkeeping) to an entity-level `books`/`classification` key with a read-fallback to `elster.klassifizierung` (the repo already has the pattern: `migrate-forward.ts`).

## 5. Proposal: minimal capability seam

### 5a. Shape

```
core/countries/
  index.ts          // registry: getCountry(cc), taxModuleOf(entity)
  types.ts          // CountryModule, Capabilities
  none/index.ts     // plain bookkeeping: no tax features, rates [0], chart minimal
  de/index.ts       // wires the existing core/elster/** (no code moved at first)
  at/               // later: FON client, E1a/U30/U1, rates 20/13/10/4.9
```

```ts
interface Capabilities {            // what the UI/CLI/MCP query; booleans first, data later
  ustva: boolean; euer: boolean; est: boolean; gewst: boolean; feststellung: boolean;
  steuerkonto: boolean; submit: boolean;        // electronic filing
  kleinunternehmer: boolean; taxDeadlines: boolean; taxReserve: boolean;
}
interface CountryModule {
  id: string;
  capabilities(entity): Capabilities;
  vatRates(date): number[];                     // replaces VAT_RATES / KNOWN_RATES / TAX_RATE_OPTIONS
  invoiceLegal(entity, invoice): { notes: string[]; missingFields: string[] };  // §14/§19 text + checks
  chartOfAccounts(): Category[];                // SKR03 for DE
  glossaryTerms(): string[];                    // filters glossary
}
```

`capabilities(entity)` is exposed via `EntityModel` (`core/presenters/workspace.ts:28-30`) next to the existing `hasElster/hasEst`, so web + desktop get it for free through the same model. `hasElster = module.capabilities.euer && !!entity.elster` keeps old call sites valid.

### 5b. Call sites to change

| Layer | Sites | Notes |
|---|---|---|
| Existing `hasElster`/`hasEst` consumers | 44 refs (nav.ts, tab-hub.ts, window.ts, einstellungen-view.ts, home presenter, chat-agent, assistent-panel, web bh-app) | Mostly satisfied by redefining the two flags from capabilities — near zero edits |
| Desktop nav/tab hub | 2 files (`nav.ts:99`, `tab-hub.ts:84-90` generalise `businessOnly/estOnly` to `needs: keyof Capabilities`) | |
| Desktop settings groups | `einstellungen-view.ts:330-370` (≈14 builders) + ERiC card `konten-view.ts:109` + setup-assistant Steuernummer row | one `if` per block |
| Home KPIs / dashboard | `home-view.ts:163,207`, `presenters/home.ts`, `presenters/frei-verfuegbar.ts` | |
| Tx detail EÜR/VAT rows | `tx-detail-dialog.ts:136-203` | |
| Web client | `bh-app.ts:212-214` + 5 views + 9 routes in `routes.ts:140-150` (return 404/empty) | |
| CLI | `cli/elster/index.ts` (+ `zve`, `bmf-kurse`, `umsatz-aufstellung`): one guard in the entity-resolution helper (`cli/elster/shared.ts`) that fails loud "German tax module off for entity X" | |
| MCP | `tools/elster.ts` 19 tools + 3 mixed; filter at registration by capability, or guard in handler | |
| VAT rates / legal text | ~8 files listed in §2b | |
| Glossary | `lib/glossary.ts` + web copy, `check:glossary` | |
| Docs | AGENTS.md tax-sources rule → per-country | |

Rough count: **~60–70 edit locations**, but **~40 of them collapse into 3 shared helpers** (`capabilities`, nav/tab filter, CLI/MCP guard).

### 5c. Step order

| # | Step | Size | Result |
|---|---|---|---|
| 1 | Schema: optional `country` + `taxModule`, `taxModuleOf()`, example manifest + `field-coverage` entry, tests that old manifests resolve to `de`. | **S** | Switch exists, nothing consumes it. |
| 2 | `core/countries/{types,index,de,none}` + `capabilities(entity)`; expose on `EntityModel`; redefine `hasElster/hasEst` through it. | **S–M** | UI hides Steuer nav/hub, Home tax KPIs/deadlines, Settings tax groups, web nav with zero view code touched. Demo: `taxModule: 'none'` yields plain bookkeeping UI. |
| 3 | Guards on edges: CLI `elster` group + `zve`/`bmf-kurse`/`umsatz-aufstellung`, MCP 22 tools, web routes, `hinweise` per-hint module tag, assistant prompts. | **M** | No path reaches DE tax logic when off. |
| 4 | Un-entangle bookkeeping from `elster`: (a) move neutral modules out of `core/elster` (22 N modules; mechanical, re-export shims), (b) split `euer-transactions` into neutral classify/ledger + DE `eur` aggregation, (c) `klassifizierung` out of the `elster` section with read-fallback. | **L** (b is the risky part; 24 importers, tests exist) | Classification/Buchungen/Zu prüfen work without an `elster` section. |
| 5 | Country data hooks: `vatRates`, `invoiceLegal` (§14/§19 text, issuer checks, `'DE'` defaults), `chartOfAccounts` (SKR03 + AI prompt templating), glossary term sets, FX source (BMF vs neutral). | **M–L** | Invoices and AI prompts stop assuming 19/7/SKR03. |
| 6 | Neutral FX + deadlines reminders (optional): generic user-defined Fristen without tax logic. | **S** | Fristen view useful with module off. |
| 7 | First real second module (AT): per `docs/research/austria.md` §8, M for UVA-only milestone, L complete. | **M–L** | Validates the interface; adjust seam after. |

Steps 1–3 deliver the requested "German tax features off" for a UI-visible product (≈ **M** total) and are independent of the refactor in 4/5. Do 4 before 7 (AT would otherwise copy `euer-transactions`).

### 5d. Risks / notes

* Ctrl+1…9 nav shortcuts (`nav.ts` comment): hiding `steuer` shifts `projekte`/`konten` slots; filter after assigning shortcuts or accept shift.
* `fristen` nav entry is intentionally not entity-scoped — with a mixed portfolio (one DE, one `none` entity) it must still show open items and show tax Fristen only for DE entities.
* Filed years depend on classification (see `euer-classify.ts` header); the step-4 split must keep outputs byte-identical (existing tests; add golden tests first).
* `kleinunternehmer` is used by three layers (issuer, ust section, invoice PDF text); decide whether it moves under country module config or stays on `issuer` with module-defined meaning.
* AGENTS.md demands every tax constant be sourced centrally in `docs/references/tax-sources.md` → per-country files needed when AT lands.
* The inventory comes from greps over the source only. Counts are approximate (±10 %).
