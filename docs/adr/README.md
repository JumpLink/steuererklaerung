# Architecture decision records

Decisions about this app that shape more than one change, with the reason they were made. A
record is short: what forced the decision, what was decided, in what order the work happens, and
what follows from it.

## Format

- File name: `NNNN-short-title-in-kebab-case.md`, numbered from `0001` in the order they are
  written. A number is never reused.
- Header, as a list right under the title:
  - `- Status:` one of the values below
  - `- Date:` the day of the decision (`YYYY-MM-DD`)
  - `- Deciders:` who decided
  - `- Related:` other records, research notes or inventories it builds on
- Sections: **Context**, **Decision**, **Order of work**, **Consequences**. Add others (Scope,
  Exceptions) only when they carry something the four do not.
- English, active voice. No real figures, tax numbers, account keys or client names — the same
  rule as the rest of [`docs/`](../README.md).

## Status values

| Status | Meaning |
|---|---|
| Proposed | Written down, not yet agreed |
| Accepted | Agreed; the parts named in the record are built or being built |
| Superseded by NNNN | Replaced by a later record; kept for the history |
| Rejected | Considered and turned down; kept so it is not proposed again unread |

A record may be accepted for some steps and leave later steps planned. It then says so in its
status line and marks each planned step as **planned, not implemented**.

## Records

| No. | Title | Status |
|---|---|---|
| [0001](0001-country-modules-and-per-entity-tax-switch.md) | Country modules and a per-entity switch for German tax features | Accepted (steps 1–3) |
| [0002](0002-all-ai-through-kurier-and-opencode.md) | All AI features go through kurier and the bundled opencode | Accepted (all steps planned) |
| [0003](0003-backend-agnostic-dms-inbox-tools.md) | Backend-agnostic `dms_*` tools for the inbox workflow | Accepted (CLI step planned) |
