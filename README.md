# Steuererklärung

*[Deutsche Version](README.de.md)*

A native GNOME application that computes the annual profit statement (EÜR), the VAT
pre-return (USt-VA) and income tax from your own bank transactions and receipts, and submits
the finished return to ELSTER through **ERiC**.

It exists because Linux has no serious tax software. The official ElsterFormular was
Windows-only and was discontinued. What remains is the browser portal *Mein ELSTER*, where
you type numbers in by hand with no bookkeeping underneath. This project tries to cover the
whole path from bank transaction to filed return on your own machine.

![Overview](docs/screenshots/01-uebersicht.png)

| | |
|---|---|
| ![Tax return](docs/screenshots/09-steuererklaerung.png) | ![Anlage EÜR](docs/screenshots/10-euer.png) |
| ![Receipt inbox](docs/screenshots/02-beleg-eingang.png) | ![Reports](docs/screenshots/08-auswertungen.png) |

All screenshots use the bundled demo entity: an invented company with invented numbers.
The app UI and most documentation are in German. A [screen-by-screen tour](docs/app/README.md)
shows every view.

## Who it is for

German freelancers and small businesses who prepare their own tax returns, including
English speakers living in Germany who file via ELSTER. The tax logic follows German law, so
the interface and terms stay German. This README glosses them where needed.

## Features

One core, four interfaces: the logic lives in shared actions, and the CLI, the app, the
web UI and the MCP server are thin adapters on top.

- **Native app** (GTK 4 + libadwaita): overview, receipt inbox, transactions, invoices,
  time tracking, contacts, reports, tax, accounts, settings.
- **CLI** (`steuer`): 23 command groups, most read commands print JSON. Everything works
  here first, including filing.
- **Web UI** (`steuer web`, local only, 127.0.0.1): the same views in a browser.
- **MCP server** (`steuer mcp`): lets an AI assistant search and tag receipts. Read-only by
  default; write tools are an opt-in setting.

**Taxes.** Anlage EÜR (income-surplus statement, § 4 (3) EStG, driven by transactions),
USt-VA and annual VAT return, trade tax (GewSt 1 A), separate and uniform assessment for
partnerships, private income tax (employment income, deductions, § 35a household services,
§ 24b, childcare). Also an asset register with straight-line depreciation (AfA), private
use shares, business cessation, reverse charge (§ 13b) and cross-checks between forms.

**Receipts.** A built-in document store or **Paperless-ngx**, chosen per entity. Receipts
are linked to transactions, and missing receipts for claimed input VAT show up as a to-do
list. An LLM can optionally extract invoice fields from OCR text; every AI decision writes
its rationale back to the document.

**Banking.** Qonto API (optional), FinTS/HBCI, CAMT.052/053 files from any bank, PayPal and
Amazon exports for enrichment. Everything lands in a local store (NDJSON + SQLite).

**Invoicing.** Outgoing invoices via Qonto or fully self-hosted: draft, finalise, PDF per
DIN 5008 with SEPA QR code, XRechnung XML, cancellation. Recurring invoices with reminders.

**Filing.** Review PDF and ERiC XML per form, ERiC validation, immutable filing snapshots,
a fingerprint-bound approval gate, test submission before the real one.

The full command reference is in [`app/README.md`](app/README.md) (German).

## Requirements

A current Linux with GNOME libraries, all taken from your distribution:

- gjs 1.86 or newer (Fedora 43+, Ubuntu 25.10+)
- GTK 4 and libadwaita for the native app
- libsoup3, json-glib, gnutls, libnghttp2
- libgda and libgda-sqlite
- pango and cairo
- blueprint-compiler, only to build the app UI
- optional: libsecret (ELSTER PIN in the keyring), poppler-glib (receipt preview)

On Fedora:

```bash
sudo dnf install gjs gtk4 libadwaita libsoup3 json-glib gnutls libnghttp2 \
                 libgda libgda-sqlite pango cairo blueprint-compiler
```

## Install and build

The toolchain is [**gjsify**](https://github.com/gjsify/gjsify): TypeScript is built for
GJS and runs there, not on Node. **Never run `npm install`.** This is a gjsify workspace and
npm prunes the dependencies gjsify manages.

```bash
npm install -g @gjsify/cli   # once: bootstrap the toolchain, the only npm call
gjsify install               # dependencies from gjsify-lock.json
gjsify run build             # build CLI, app and web UI
```

Then run from `app/`:

```bash
cd app
gjsify run start --help        # the CLI
gjsify run start:app           # the native app
gjsify run start web           # the web UI on http://127.0.0.1:3000
gjsify run start mcp           # the MCP server (stdio)
```

The CLI calls itself `steuer` in its help and in the docs. No installed command of that
name exists yet; `gjsify run start` stands in for it.

### Try the demo

The repo ships a complete invented company, *Fischer & Weber GbR*, with a second private
entity, transactions, receipts and invoices. `--demo` (or `STEUER_DEMO=1`) switches every
interface to it without touching real data:

```bash
cd app
gjsify run start --demo demo seed     # create the demo data (idempotent)
STEUER_DEMO=1 gjsify run start:app    # the app on the demo data
```

### Your own data

All configuration lives in one file, `steuererklaerung.json`: entities, tax numbers,
accounts, receipt sources, invoicing backend. It is gitignored and never leaves your
machine. Start from [`app/steuererklaerung.example.json`](app/steuererklaerung.example.json):

```bash
cp app/steuererklaerung.example.json app/steuererklaerung.json
cp app/.env.example app/.env          # credentials for bank, document store, LLM
cd app && gjsify run start config validate
```

An older `buchhaltung.json` (the project's previous name) is still read, with a notice.

### Optional integrations

Qonto (bank and invoicing) and Paperless-ngx (documents) are optional. Without them, use
CAMT/FinTS imports and the built-in document store.

## ERiC: bring your own binary

Submission and the official plausibility check use **ERiC** (ELSTER Rich Client), the native
library from the Bavarian tax authority.

> **ERiC is not part of this project and must not be redistributed.** The vendor licence
> forbids passing it on and sublicensing it. This repo ships only our own wrapper
> ([`packages/eric`](packages/eric/README.md)): no ERiC source, no binaries, no schemas.

Each user downloads ERiC themselves (developer registration in the
[ELSTER developer area](https://www.elster.de/eportal/infoseite/entwickler), accepting the
licence) and points `ERIC_HOME` at it:

```bash
export ERIC_HOME=/path/to/eric/runtime           # contains lib/libericapi.so
gjsify run -w @steuererklaerung/eric build:meson # compile our binding once
export LD_LIBRARY_PATH="$ERIC_HOME/lib:$ERIC_HOME/lib/plugins:$LD_LIBRARY_PATH"
```

**Without ERiC everything works except validation and submission**: computing, reports,
receipts, invoices, XML and review PDF. The loader tells you what is missing instead of
crashing. You can also upload the generated XML to *Mein ELSTER* by hand. Details:
[`app/docs/eric-license-considerations.md`](app/docs/eric-license-considerations.md).

## Maturity

This is one person's working tool, built because no tax advisor is involved and the returns
still have to be right. Every figure is meant to be checkable: tax constants are listed with
source, retrieval date and tax year in
[`docs/references/tax-sources.md`](docs/references/tax-sources.md), and each figure can be
expanded down to single transactions (`steuer elster explain`).

It is not a polished product and does not cover every case. It was built and tried on a
dissolved partnership (GbR), a sole proprietorship and private income tax cases. Anything
else is untested. The native app is marked as a preview: reading and reviewing work
everywhere, writing in few places, and filing itself runs through the CLI.

### Transparency: how this is made

The project is developed largely through vibe coding. The code is written with AI coding
agents; the maintainer directs the work and reviews the results. Not every line was written
by hand.

What backs the numbers is not where the code came from but whether it can be checked. Tax
rules cite their sources in [`docs/references/tax-sources.md`](docs/references/tax-sources.md),
and generated returns are validated against ELSTER's ERiC. Still: this is not tax advice,
there is no warranty (see the [AGPL](LICENSE)), and you must check your return yourself
before sending it.

### Disclaimer

This software is not tax advice and does not replace it. No guarantee is given for the
correctness of computed values. Whoever submits a return is responsible for its content.
Only ELSTER's validation and the tax office's assessment are binding.

## Further reading

- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to contribute
- [`docs/`](docs/README.md): tax workflow, deadlines, and the cited references (German)
- [`docs/app/README.md`](docs/app/README.md): the app, view by view
- [`app/README.md`](app/README.md): full command reference and configuration
- [`AGENTS.md`](AGENTS.md): working rules for humans and AI agents

## License

[AGPL-3.0-or-later](LICENSE) © Pascal Garber.

The app is AGPL. The reusable packages under `packages/*` are
[LGPL-3.0-or-later](packages/eric/LICENSE), each with its own licence text.

You may use, modify and share it freely. The AGPL adds one condition to the GPL: if you
offer this program **as a network service**, you must give that service's users the source
of your version. Running it locally for yourself adds no obligation.

The wrapper in `packages/eric` is our own code; **ERiC itself is not shipped**. Dependencies
with other licences that get pulled into a build: `lib-fints` (LGPL-2.1-or-later), `xlsx`
(Apache-2.0), the Adwaita icons (LGPL-3.0-or-later / CC-BY-SA-3.0) and Adwaita Sans
(OFL-1.1) in the web UI. Whoever distributes a bundled artefact must meet their terms.
