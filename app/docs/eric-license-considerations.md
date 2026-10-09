# ERiC (ELSTER Rich Client) License Considerations

This document summarizes the key obligations and constraints of the ERiC license agreement (Release 43) as they apply to this project, particularly regarding open-source distribution.

## What is ERiC?

ERiC is a C library provided free of charge by the Bayerisches Landesamt für Steuern (LfSt) on behalf of the German tax authorities. It enables software to electronically submit tax declarations via the ELSTER system.

## Open-Source Distribution Constraint

**ERiC must not be distributed as part of this repository.**

Per §4 (3) of the license agreement, transferring the usage rights to third parties and sublicensing beyond the scope of §4 (1) is explicitly prohibited. This means:

- The ERiC binary library **cannot** be bundled in any public repository or release artifact.
- Each user of this software must **individually** accept the ERiC license agreement and download the library themselves from [elster.de](https://www.elster.de).
- The project must treat ERiC as an **external, user-supplied dependency** (BYOB — Bring Your Own Binary).

### Recommended approach

- Provide a setup script or documented instructions for users to download ERiC from the ELSTER developer portal.
- The setup process should make clear that the user must accept the ERiC license before proceeding.
- Application code may link against ERiC, but must not redistribute it.

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
| Distribution | Do NOT bundle ERiC — users must download it themselves |
| Sublicensing | Not permitted |
| End-user notices | GDPR sheet + privacy notice + log file notice required |
| Minimum version | Must use at least the designated Mindestversion |
| Product naming | Must not contain "ELSTER" |
| ELSTER logo | Only in ERiC documentation |
| Confidentiality | Do not publish developer portal internals |
| Support | Your responsibility, not LfSt's |
| Hersteller-ID | Keep secret; can be revoked on violation |
