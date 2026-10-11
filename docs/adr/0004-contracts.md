# 4. Contracts (Verträge)

- Status: **Accepted** (steps 1–3); steps 4–6 planned
- Date: 2026-10-11
- Deciders: Pascal Garber
- Related: [research/contracts-prior-art.md](../research/contracts-prior-art.md),
  [ADR 0003](0003-backend-agnostic-dms-inbox-tools.md)

## Context

The app already sees every recurring debit: "Laufende Kosten" (`core/elster/laufende-kosten.ts`)
detects series of equal payments to one party and lets the owner confirm them. A series is not a
contract. It does not know the contract number, the term, the notice period or which documents
belong to it, so it cannot answer the two questions an owner actually has: "did every expected
payment arrive, and at the agreed amount?" and "by when do I have to cancel?".

The prior-art study found that neither open-source tool models term, renewal and notice
separately, that matching works best as a proposal the owner confirms, and that the useful
findings are expected-but-missing payments plus, on a SEPA account, returned and changed debits.

## Decision

- **Own store.** Contracts live in the ledger (SQLite), schema v27, not in the DMS. A DMS has no
  notion of a term or a notice period, and the matching decisions are bookkeeping state like
  `refund_links`. Every write appends a `contract.*` row to `audit_log`.
- **Tables.**
  - `contracts`: id, `entity_id` (workspace entity, no FK), name, counterparty (as written) and an
    optional DMS-agnostic `counterparty_ref` (`paperless:<id>`, a built-in correspondent id),
    contract number, `account_key` (the account it is paid from), a user category (free text, not
    a tax category), amount (EUR, positive) + cycle (`monatlich` | `vierteljaehrlich` |
    `halbjaehrlich` | `jaehrlich`, the existing series intervals) + amount tolerance, start date,
    initial term (months), renewal (months, or none = indefinite), notice period (value + unit:
    days, weeks, months), auto-renewal, end date, payment method (`lastschrift` | `ueberweisung` |
    `karte` | `paypal` | `sonstiges`), the mandate's creditor ID, mandate reference and
    counterparty IBAN, extra match text, status (`active` | `cancelled` | `ended` | `archived`),
    notes, timestamps.
  - `contract_transactions`: contract id + unified tx id, `linked` or `rejected`. A rejection keeps
    the matcher quiet for that booking.
  - `contract_documents`: contract id + document ref (the same `paperless:<id>` / built-in id
    strings as `filing_documents`) + a role (`contract`, `invoice`, `notice`, `confirmation`,
    `other`).
- **Matching is a proposal.** A booking is a candidate when it is a debit (or, for a returned
  debit, a credit) on the contract's account, not rejected, and matches by strength: creditor ID
  or mandate reference in purpose/reference, then counterparty IBAN, then counterparty name
  (`gleichePartei`) or match text — always within the amount window (amount ± tolerance) except
  for the strong keys, which also catch a changed amount. Linking stays an explicit action.
- **Findings** come from the expected dates (start date stepped by the cycle with `plusMonate`,
  ± `SERIE_TOLERANZ_TAGE`) against the linked and candidate bookings:
  - `missing`: an expected date passed by more than the tolerance with no payment;
  - `returned`: a credit from the same counterparty with the debited amount (Rücklastschrift);
  - `changed`: a payment outside the amount window that matched by a strong key or by name.
  Findings are computed, never stored. They are measured against the newest booking of the
  account, not today, so a lagging import does not report everything as missing.
- **Notice deadlines are derived, never stored.** Current term end = start + initial term, then
  rolled forward by the renewal period; with no renewal period (indefinite) the next possible end
  is today + notice. Latest notice date = term end − notice period, not shifted for weekends. The
  action returns upcoming deadlines in a window and a pure `buildContractIcsEvents` turns them into
  `IcsEvent`s, as `fristen-reminder.ts` does for tax deadlines, so a calendar or reminder tool can
  consume them.
- **Surfaces.** A CLI command `contracts` and an MCP group `contracts` with `contracts_*` tools.
  Reads are free; writes carry `readOnlyHint: false` and fall under the existing `mcp.allowWrite` /
  `STEUER_MCP_READONLY` gate.
- **Relation to Laufende Kosten.** Series detection stays as it is. A confirmed series is the
  natural seed for a contract; turning one into the other is a later step.

## Order of work

1. Schema v27, store repo, action layer with matching, findings and deadlines. Done.
2. CLI `contracts`. Done.
3. MCP group `contracts`. Done.
4. A GTK page (list with amount, cycle, next date and a deadline badge, after the Wallos notes in
   the research). Planned, not implemented.
5. Agent proposals: create a contract from a confirmed Laufende-Kosten series or from a contract
   document in the DMS. Planned, not implemented.
6. Cancellation letters with sent / proof / confirmation states. Planned, not implemented.

## Consequences

- A schema bump: older app versions cannot open a v27 ledger.
- The published MCP tool list and `mcp.groups` gain a `contracts` entry (default on).
- `UnifiedTransaction` has no creditor-ID or mandate field, so the strong keys are searched in
  purpose and reference text. A structured field from FinTS/CAMT would make them exact; that is a
  separate change.
- Deadlines are only as good as the term data the owner enters; a contract without a term or
  notice period has no deadline and says so.
