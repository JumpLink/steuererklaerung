# Contributing

Thanks for helping. Please read [`AGENTS.md`](AGENTS.md) too; it holds the detailed working
rules and applies to people as much as to AI agents.

## Setup

The toolchain is [gjsify](https://github.com/gjsify/gjsify). Do not use `npm install`, it
removes the dependencies gjsify manages.

```bash
npm install -g @gjsify/cli   # once
gjsify install
cd app
```

## Before you open a pull request

Run these from `app/`; all must pass:

```bash
gjsify run check             # tsc and project checks
gjsify run lint
gjsify format --check .      # or `gjsify run format` to fix
gjsify run test              # builds and runs the tests on GJS
gjsify run build
```

Register a new `*.test.ts` in `app/tests/test.mts`. If you change tax logic, rebuild before
trying the CLI, since it runs off the bundle.

## Commits

[Conventional commits](https://www.conventionalcommits.org/): `type(scope): description`,
imperative, subject at most 50 characters. Keep commits atomic, each leaving the code
working. Do not skip hooks.

## Tax figures need a source

Every tax constant, rate, threshold or formula in code must be listed in
[`docs/references/tax-sources.md`](docs/references/tax-sources.md) with source, retrieval
date and tax year, and the code comment points there. Check order: statute text
(gesetze-im-internet.de), then the official BMF handbooks, then a reputable secondary source
to confirm. Many values change yearly, so keep them per tax year. A change without a source
will not be merged.

## No real data

Never put real names, amounts, tax numbers, IBANs or documents into code, fixtures, tests,
screenshots, issues or commits. Use the demo data (`app/demo/`, the *Fischer & Weber GbR*
entity) only. The real config (`steuererklaerung.json`, formerly `buchhaltung.json`), `.env`
and anything under `app/elster/` are gitignored; keep it that way.

ERiC is never committed, not even encrypted. See
[`app/docs/eric-license-considerations.md`](app/docs/eric-license-considerations.md).

## Security

Report vulnerabilities as described in [`SECURITY.md`](SECURITY.md), not in public issues.

## Licence

Contributions are licensed under AGPL-3.0-or-later, or LGPL-3.0-or-later for files under
`packages/*`.
