# 5. The assistant writes, in two tiers of approval

- Status: **Accepted**
- Date: 2026-11-11
- Deciders: Pascal Garber
- Related: [ADR 0002](0002-all-ai-through-lotse-and-opencode.md),
  [ADR 0003](0003-backend-agnostic-dms-inbox-tools.md),
  [backup](../app/backup.md), issues #95 (this record) and #96 (its last step),
  [lotse `host-tools.ts`](https://github.com/JumpLink/lotse/blob/main/packages/core/src/host-tools.ts)

## Context

The app ships two assistants. The old built-in engine calls an LLM provider in process; the lotse
pane starts a bundled opencode and hands it this app's own MCP tools. `aiEngine` decides, and it
defaults to `builtin`, so the pane is the thing nobody sees.

The pane is read-only twice over. `lotseMcpLaunch` sets `STEUER_MCP_READONLY`, which drops every
tool annotated `readOnlyHint: false` — 46 of them, from `buchung_bestaetigen` to `submit_filing` —
and `assistantGateAnswer` declines the ACP kinds `delete`, `move`, `edit`, `write` and `execute`
without asking. Both were right while nothing guarded a write: the agent explains a Buchung, and
the person then does the work by hand in the same window.

That is also why the app cannot be tried. Everything it is for is a write: confirming a
classification, splitting a booking, applying inbox metadata, finalizing an invoice. An assistant
that may not touch any of it demonstrates nothing, and the person who would most benefit from
being walked through a tax year is exactly the one who does not know which button comes next.

lotse 0.5 brings the three pieces that were missing. `HostToolPolicy.hostConfirmed` marks tools
lotse may **never** approve — not from its dialog, not from an always-allow, not from a grant left
over earlier in the session — and routes them to the host's own dialog instead. `alwaysAllow:
'session'` answers the agent's narrower `allow_once` on the wire and keeps the always in memory,
keyed by the ACP session, so no promise outlives the conversation. `toolPresenter` lets the app
render its own tool calls (issue #22) instead of raw names and JSON.

The app already owns the rest. `core/actions/backup.ts` writes a consistent snapshot through
SQLite and takes a lock. The ledger has an append-only `audit_log`. `period-guard.ts` and
`ledger.ts` refuse writes into a festgeschriebene period for every DMS back-end, `tax-guard.ts`
refuses German-tax tools for an entity whose module is off. And the read-only `*_plan_*`,
`*_propose_*` and `*_suggest_*` tools already exist next to the writes they describe.

## Decision

- **lotse is the assistant.** `aiEngine`, `AI_ENGINE_ENV` and `DEFAULT_AI_ENGINE` go away: AI on
  means the lotse pane. `isAssistantEnabled()` stays the only consent, and `lotseEmbedPlan`
  returns `null` without it, so "no AI" keeps meaning no process.
- **The pane gets the write catalogue.** `lotseMcpLaunch` stops setting the read-only marker; the
  agent sees what `mcp.groups` and `mcp.allowWrite` expose. `STEUER_MCP_READONLY` and
  `restrictMcpToReadOnly` stay — they are how an externally registered client is held to a
  manifest decision, and they remain the default for unattended jobs.
- **Two tiers, and every write tool is in exactly one.** The tier is a property of the tool, not
  of a mood:
  - **Tier A — the app's own dialog, one call, never an always.** Passed to lotse as
    `hostTools.hostConfirmed` by MCP name (`steuererklaerung.submit_filing`), so lotse's negative
    guarantee carries it: `submit_filing` (the app asks for the keystore PIN itself and never
    hands it to an agent), `elster_lock_period` (Festschreibung, not reversible),
    `sign_off_filing` and `revoke_signoff` (a signature in someone's name), every tool that
    deletes a record the change log cannot reconstruct — `remove_filing`, `remove_contact`,
    `invoices_delete_draft`, `invoices_cancel`, `detach_filing_document` — and, pre-committed
    before one exists, any tool that moves money. The app has no such tool today;
    `generate_sepa_qr` draws a code the person scans, and FinTS answers an agent's TAN prompt with
    the refusing interaction (`startMcpServer`).
  - **Tier B — lotse's dialog, approval per call, always-allow scoped to the session.** Everything
    else with `readOnlyHint: false`: the confirmations, splits, links, metadata, drafts and
    classifications that are the daily work. `assistantGateAnswer` answers `'ask'` for them
    instead of `'decline'`, and keeps declining nothing — the catalogue and the tiers decide, not
    the ACP kind, which says `edit` for `buchung_bestaetigen` and `edit` for `submit_filing`
    alike.
- **A write into a locked period is refused, not confirmed.** Issue #95 asks for the app's own
  dialog there; refusing is narrower and it is what GoBD means. `assertTxPeriodUnlocked` and the
  ledger's own check already throw, and no approval path is added that could override them. The
  agent's legal move is to propose a correction booking in the open period, which is a tier B
  write like any other.
- **The allowlist is derived; the tier list is the one thing maintained by hand.** No second list
  of readable tools: the catalogue is already `mcp.groups` plus each tool's `readOnlyHint`, and
  ADR 0003 chose that annotation precisely so no name list drifts. Tier A cannot be derived — it
  is a judgement about consequences — so it is written out, and a new `dev/check-assistant-tiers.js`
  gate in `gjsify run check` fails when a tool annotated `readOnlyHint: false` appears in no tier.
  Adding a write tool therefore forces the decision at the commit that adds it.
- **A preview is a tool, not a flag.** Every write that changes more than one row keeps a
  read-only counterpart (`dms_plan_reconcile_open_items`, `dms_propose_metadata`,
  `contracts_match`, `invoices_suggest_paid`), and the approval dialog shows that plan's diff
  through the `toolPresenter` of issue #22. A `dryRun` parameter on a write tool is rejected: it is
  a second, rarely exercised code path inside every tool, and the one path that matters is the one
  nobody tested.
- **One backup before the first change of a session.** The first tier A or tier B approval of an
  ACP session runs `core/actions/backup.ts` in its child process and waits. A backup that fails
  declines the call and says why — the person can switch the assistant off, not around the
  snapshot. Once per session, keyed like the always-allow memory, so a conversation with forty
  writes costs one snapshot.
- **A change log the person can read, and undo where there is an inverse.** The MCP server appends
  one line to `assistant-changes.ndjson` (0600, in the app's data directory, declared `state`,
  inside the backups) after every `readOnlyHint: false` tool returns: time, ACP session, tool,
  entity, year, the ids it touched, the field names it changed, and the inverse call when the
  action has one. It records references, never values: no document bodies, no amounts, no
  Steuernummern, so the log never becomes a second copy of the tax data. A new Settings page lists
  the sessions and their changes and renders the current values from the live store. Undo offers
  the inverse where one exists — unlink a link, delete a draft that was created, restore the
  captured previous metadata — and otherwise says plainly that the session's backup is the way
  back. Ledger writes keep appending to `audit_log`; the agent log points at it rather than
  duplicating it.
- **Free models and demo mode stay as ADR 0002 amended them.** The pane passes no `modelPolicy`,
  lotse's warning card shows while a free model is selected, and the person decides; unattended
  jobs keep `denyFreeHostedModels` because a card nobody reads is not a warning. The demo entity
  plus a free model must carry the full flow, writes included — that is the acceptance test for
  this record, not a nice extra.

## Order of work

1. **Tiers and the gate, with the pane still read-only.** The tier tables, `assistantGateAnswer`
   rewritten against them, the `check:assistant-tiers` gate, and unit tests: every write tool has a
   tier, no tier A name reaches lotse's own approval, `assistantGateAnswer` answers `'ask'` and
   never approves. Nothing changes for the person yet, so the guard is reviewable on its own.
2. **Backup and the change log**, both behind the still-closed gate: the once-per-session snapshot
   with its failure path, the NDJSON writer, its state-manifest entry, and tests that the first
   write snapshots and the second does not.
3. **Open the pane.** Drop the read-only marker from `lotseMcpLaunch`, pass `hostTools`
   (`hostConfirmed` + `alwaysAllow: 'session'`) and the app's confirmation callback, wire the
   ELSTER PIN dialog and the deletion dialogs to it. Keep `STEUER_MCP_READONLY` for external
   clients and jobs.
4. **The surfaces:** the change-log page, undo, the `toolPresenter` for this app's tools (#22),
   gettext EN + DE, real screenshots EN + DE from the demo entity under
   `./scripts/headless-run --window-shot`.
5. **Remove the engine switch.** `aiEngine` and `AI_ENGINE_ENV` go; an older `settings.json`
   migrates silently. The old engine's code stays one release so a regression has somewhere to
   fall back to.
6. **Packaging and the VM check:** the bundled opencode in deb, rpm, AppImage, Flatpak, the
   Windows zip/MSI and the macOS package, started from a path with non-ASCII characters; store
   rules checked before a store build.
7. **One release later, issue #96:** `core/clients/llm/*`, `clients/scaleway/chat.ts`,
   `actions/assistant/chat*.ts` and `@anthropic-ai/claude-agent-sdk` are deleted, with the
   `aiEngine` migration. This is step 7 of ADR 0002 finished.

Steps 1 and 2 are the whole of the guard and can land before anyone can write. Step 3 is the one
commit that changes what an agent may do, and it is small because 1 and 2 did the work.

## Consequences

- The pane's third invariant in `lotse-embed.ts` ("the tools it gets are read-only") is replaced by
  the tier policy, and that file's header must say so — it is the one place the pane's rules are
  written down, and a stale header there is worse than none.
- A write reaches the store on the agent's turn, so the window has to notice: the views refresh
  from the change log's entries rather than assuming the person caused every change.
- `mcp.allowWrite` now governs the pane as well as external clients. Someone who turned writes off
  for Claude Code has also turned them off for the assistant. That is the honest reading of the
  setting, and Settings has to say it in one sentence.
- A conversation can cost one backup folder per session; retention prunes them like any other.
- The change log holds the shape of someone's bookkeeping even though it holds no figures. It is
  0600, in the data directory, in the backups, and deletable in Settings along with the
  conversation history.

## Resolved questions

- **Scope of an always-allow.** One scope per session is enough for the first release. Per-tool
  scoping waits for a lotse that offers it.
- **The locked-period refusal** stands as written here, and #95's wording yields: a write into a
  locked period is refused, not confirmed by a dialog.
- **Backup on failure.** No write without a successful backup. The only way out is switching the
  assistant off; there is no "proceed once without one".
- **Scaleway.** #96 removes the old engine, and Scaleway with it, without probing opencode first.
