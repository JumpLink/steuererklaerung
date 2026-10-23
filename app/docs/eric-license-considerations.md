# ERiC (ELSTER Rich Client) License Considerations

This document summarizes the key obligations and constraints of the ERiC license agreement (Release 43) as they apply to this project, particularly regarding open-source distribution.

## What is ERiC?

ERiC is a C library provided free of charge by the Bayerisches Landesamt für Steuern (LfSt) on behalf of the German tax authorities. It enables software to electronically submit tax declarations via the ELSTER system.

## Open-Source Distribution Constraint

**ERiC is not checked into this repository, but official release builds may ship it.**

§4 (1) of the license agreement grants the right to integrate ERiC into one's own software products and to distribute it together with them as a single product, directly or indirectly. §4 (3) prohibits transferring that right to third parties and sublicensing beyond §4 (1). This means:

- The ERiC binary library stays **out of the public source repository** (proprietary, version-bound).
- Official release artifacts (Flatpak, deb/rpm, AppImage, MSI/zip, macOS zip) **may bundle ERiC** as part of the one product. The release pipeline fetches ERiC from a private repo with a read-only deploy key (secret `ERIC_DEPLOY_KEY`) and adds it to every package, including the `.flatpak` bundle on the GitHub release. The Flathub build does not carry it, and a build without the secret has none.
- Forks and self-builds do not inherit our right: they provide their own ERiC (`ERIC_HOME`) after accepting the license themselves.
- Distribution through third-party stores is "indirect" distribution of our product; ERiC must stay bound to the app and must not be offered as a standalone download.

### The bundled Hersteller-ID

Official release builds also carry the app's own 5-digit ELSTER Hersteller-ID: written from
the `ERIC_HERSTELLER_ID` secret as a `hersteller-id` file next to the bundled runtime, read
by `packages/eric/src/paths.ts`. It marks submissions on the wire as this software. It never
appears in the source repository, and the Flathub build ships without it (a person's own
identifier from the settings overrides it, and registering one is free in the ELSTER
developer area).

**Neither ERiC nor the bundled identifier may be lifted out of the release artifacts for use
by other software.** Distribution is bound to this one product (§4 (1)); transferring either
to third parties or sublicensing beyond that is forbidden (§4 (3)); misuse can get the
identifier blocked, rendering the integration non-functional (§9).

### Recommended approach

- Keep the setup script and documented instructions for forks, self-builds and development.
- Wherever ERiC is not bundled (Flathub, forks, self-builds), the setup process must make clear that the user has to accept the ERiC license.
- Never offer ERiC separately from the application.

## Mandatory End-User Notices

When ERiC is used in the application, the following notices **must** be presented to end users before they use the software (§5):

1. **GDPR Information Sheet** — The document "Allgemeine Informationen zur Umsetzung der datenschutzrechtlichen Vorgaben der Artikel 12 bis 14 der Datenschutz-Grundverordnung in der Steuerverwaltung" (provided as Annex 2 of the license) must be shown with an acknowledgment mechanism.

2. **Data Privacy Notice** — The following notice (or its equivalent) must be displayed:
   > This software collects personal data as defined by Art. 4 No. 1 GDPR and Art. 9 (1) GDPR for the purpose of processing. In addition to the data required for tax assessment, the software collects data about the user's operating system and transmits it to the tax authorities. This data is necessary to ensure proper data processing and to prevent errors. Data usage is governed by Art. 6 (1) subpara. 1 lit. e in conjunction with (3) subpara. 1 lit. b GDPR in conjunction with federal and state tax laws.

3. **Log File Notice** (§15) — Users must be informed that ERiC creates log files stored locally. If log files are forwarded (e.g. for support), explicit user consent is required and must be provable.

## Version Requirements

- Regularly check for new ERiC versions on the ELSTER developer portal (§5 (4)).
- Always use at least the version designated as **"Mindestversion"** (minimum version) by the LfSt (§5 (6)).
- Using older versions is at your own risk.

## RABE (Belegabruf) Requirements

If the application uses RABE (reference-based document retrieval), additional obligations apply (§6):

- The external document storage must be available **24/7** (maintenance windows: weekdays 18:00–06:00, max 4 hours; weekends/holidays max 6 hours).
- API response times should be in the **millisecond range**.
- The current RABE interface specification must be fully implemented.
- An additional user notice about document retrieval must be displayed.

## Branding Restrictions

- The ELSTER logo may **not** be used freely — only within ERiC documentation (§4 (2)).
- The product name must **not** contain "ELSTER" (§12).

## Confidentiality

- Confidentiality obligations apply mutually and survive termination of the agreement (§14).
- Do **not** publish: Hersteller-ID, API keys, LfSt support contact details, or other non-public information from the developer portal.

## Liability and Compliance

- The LfSt's liability is largely excluded (§10). You bear all integration and support costs (§8).
- **You** are responsible for end-user support, not the LfSt (§7).
- Export control regulations apply since ERiC uses cryptographic technology (§13).
- Violating the license can result in your **Hersteller-ID being blocked** (§9), rendering the integration non-functional.

## Summary

| Topic | Rule |
|---|---|
| Distribution | Not in the source repo; official builds may bundle it (§4 (1)); forks bring their own |
| Sublicensing | Not permitted (§4 (3)) |
| End-user notices | GDPR sheet + privacy notice + log file notice required |
| Minimum version | Must use at least the designated Mindestversion |
| Product naming | Must not contain "ELSTER" |
| ELSTER logo | Only in ERiC documentation |
| Confidentiality | Do not publish developer portal internals |
| Support | Your responsibility, not LfSt's |
| Hersteller-ID | Keep out of the repo (private config); can be revoked on violation (§9) |
| Reuse from bundles | ERiC and the bundled Hersteller-ID are product-bound; extraction for other software is a licence violation (§4 (3), §9) |
