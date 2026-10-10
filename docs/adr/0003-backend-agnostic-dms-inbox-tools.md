# 3. Backend-agnostic `dms_*` tools for the inbox workflow

- Status: **Accepted**; built
- Date: 2026-10-10
- Deciders: Pascal Garber
- Related: [ADR 0002](0002-all-ai-through-kurier-and-opencode.md)

## Context

A scheduled agent should run the accounting inbox workflow (list the inbox, propose metadata,
apply it after a human yes, reconcile the payment status against the bank) without knowing
whether Paperless or the built-in DMS sits behind an entity. The MCP surface only offered
`paperless_*` tools, which name Paperless ids and custom fields, and the built-in DMS had no
inbox, no payment fields and no KI-Hinweis column.

## Decision

- A new MCP group `dms` exposes `dms_list_inbox`, `dms_get_document`, `dms_propose_metadata`,
  `dms_apply_metadata`, `dms_set_payment_status` and `dms_match_payment`. They take an optional
  `entity_id` and resolve the provider through the entity's DMS configuration.
- The logic lives in `core/actions/dms/inbox.ts` and takes a `DmsProvider`, so both back-ends
  and test fakes run the same code.
- `DmsProvider` gains the optional methods `listInbox`, `getText` and `markReviewed`;
  `DmsDocument` gains `paymentStatus`, `dueDate` and `amountToPay`.
- The inbox is defined per back-end. Paperless: documents carrying the `tag_ids.inbox` tag
  (`Neu`, created by `setup`), swapped for `tag_ids.ai_reviewed` on review. Built-in: documents
  with `ai_extracted_at IS NULL`; writing metadata stamps it.
- Built-in schema v26 adds `documents.payment_status`, `due_date` and `amount_to_pay`; the
  KI-Hinweis maps to the existing `documents.note` column.
- Propose never calls a model. The agent is the caller; the tool validates and diffs.
- Write tools carry `readOnlyHint: false`, so the existing `mcp.allowWrite` gate drops them.
- Paperless cannot write correspondent, document type or direction through the DMS interface
  (names need ids). They are reported as `notWritable`; `paperless_update_document` stays.
- `paperless_*` tools are unchanged and documented as Paperless-specific.

## Order of work

1. Schema v26, provider methods, config tag. Done.
2. Action layer and MCP group. Done.
3. A CLI front-end for the same actions. Planned, not implemented.

## Consequences

- The published MCP tool list and the `mcp.groups` settings gain a `dms` entry (default on).
- The manifest `paperless.tag_ids` gains an optional `inbox` id; existing configs keep working
  and get an empty Paperless inbox until it is set.
- A schema bump means older app versions cannot open a v26 ledger.
