# AI document enrichment — one prompt source and a recorded rationale

Moved out of AGENTS.md. The rule that stays there: prompt text lives only in `src/core/lib/prompts.ts`; every AI metadata decision records its rationale in `ai_note`.

The Paperless AI-enrichment workflow is unified: it is driven from **one** prompt
source and every AI metadata decision records **why** it was made.

- **Prompt source of truth = `src/core/lib/prompts.ts`.** All enrichment prompt text
  (invoice extraction, classification, metadata-review system rules, and the MCP
  prompt text) lives here — never duplicate prompt strings into a frontend.
- **`ai_note` (KI-Hinweis) convention.** Every AI-made metadata decision records a
  short rationale into the Paperless custom field `ai_note`: **what** the review
  changed/resolved + **provenance** (model), as ONE concise German line (< 200
  chars), overwriting any prior note (fresh each review). The
  `paperless review-metadata` action writes it automatically (deterministic
  post-step in `src/core/actions/paperless/review-metadata.ts` —
  `buildAiNoteRationale` + `applyAiNoteToPayload`, gated by `--dry-run`); external
  agents must set the same field via `dms_apply_metadata` (any DMS back-end) or
  `paperless_update_document` (Paperless only).
- **Backend-agnostic inbox tools (`dms_*`, ADR 0003).** `dms_list_inbox`,
  `dms_get_document`, `dms_propose_metadata` (dry run), `dms_apply_metadata`,
  `dms_set_payment_status`, `dms_match_payment`, and the vocabulary reads
  `dms_list_document_types` / `dms_list_correspondents` / `dms_list_tags`; apply writes
  correspondent, type, tags (`tags_add`/`tags_remove`) and direction by id or exact name,
  creating unknown ones only with `create: true` (`src/frontends/mcp/tools/dms.ts`,
  logic in `src/core/actions/dms/inbox.ts`). The write tools sit behind
  `mcp.allowWrite`. Inbox = Paperless documents with the `tag_ids.inbox` tag; built-in
  DMS documents never reviewed (`ai_extracted_at IS NULL`). `paperless_*` stays and is
  Paperless-specific.
- **Contract tools (`contracts_*`, ADR 0004).** Reads: `contracts_list`, `contracts_get`,
  `contracts_match` (candidate bookings + findings missing/returned/changed),
  `contracts_deadlines` (upcoming notice deadlines, optionally as .ics). Writes behind
  `mcp.allowWrite`: `contracts_save`, `contracts_archive`, `contracts_link_transaction`,
  `contracts_link_document` (`src/frontends/mcp/tools/contracts.ts`, logic in
  `src/core/actions/contracts.ts` + the pure rules in `src/core/contracts/`; ledger tables
  since schema v27). Deadlines and findings are derived on every read, never stored.
- **Two AI-usage modes, both drawing from `prompts.ts`:**
  - **External** — Claude Code (or another MCP client) drives the workflow through
    the `paperless_*` + `document-workflow` MCP tools, guided by the MCP **prompts**
    below; and the headless `paperless review-metadata` CLI runs the same rules.
  - **Internal** — the app assistant runs the same review in-process via
    `reviewMetadata()`, consuming `REVIEW_METADATA_SYSTEM_PROMPT_*` directly.
- **Registered MCP prompts** (`src/frontends/mcp/prompts.ts`, read-only, exposed
  regardless of `mcp.allowWrite`; text sourced from `src/core/lib/prompts.ts`):
  - `review_document_metadata` — per-document metadata-review rules + how to drive
    it via the `paperless_*` tools and record the rationale into `ai_note`
    (`getReviewDocumentMetadataPromptText` + `REVIEW_METADATA_MCP_USAGE_NOTE`).
  - `enrich_paperless_documents` — the higher-level batch workflow (select →
    analyze → classify `data_scope` → find related → validate → update + link →
    record `ai_note`; private vs business closing steps)
    (`ENRICH_PAPERLESS_DOCUMENTS_PROMPT`).
