# 2. All AI features go through lotse and the bundled opencode

- Status: **Accepted**; all steps planned, not implemented
- Date: 2026-10-10
- Deciders: Pascal Garber
- Related: [AI jobs study](../architecture/ai-jobs-study.md),
  [ADR 0001](0001-country-modules-and-per-entity-tax-switch.md),
  [lotse ADR 0001: lotse as an embeddable widget](https://github.com/JumpLink/lotse/blob/main/docs/adr/0001-lotse-as-an-embeddable-widget.md),
  [lotse ADR 0004: a headless job API](https://github.com/JumpLink/lotse/blob/main/docs/adr/0004-headless-job-api.md)

## Context

The app calls a language model in five places: invoice extraction, metadata review and
document-type classification (one-shot jobs over OCR text), plus the assistant chat in a
one-shot and an agentic form. Two providers exist, the Claude Agent SDK and Scaleway, chosen by
`LLM_PROVIDER`. The agentic chat imports the Claude Agent SDK directly and bypasses the
`LLMProvider` port. The SDK does not resolve under GJS, so those paths run on Node only.

The one-shot jobs parse the model's JSON leniently and cast it to a type; nothing validates it.
Their prompts hard-code German VAT rates, § 13b and a German category list.

[lotse](https://github.com/JumpLink/lotse) is an ACP client that starts coding agents as
subprocesses. It stays a standalone app that keeps growing, and it will also ship LGPL packages
(`@lotse/core`, `@lotse/widget`) so other GTK apps can embed it. A probe showed that opencode
2.0.25 honours the MCP servers a client passes in ACP `session/new`, so this app can hand its own
`steuer mcp` tools to a bundled opencode without touching the user's global configuration.

## Decision

- **One login for every AI feature.** The user connects one provider once, in the embedded lotse
  widget, and the chat and every one-shot job use it.
- **Chat:** the assistant becomes the `@lotse/widget` chat with a bundled opencode. The app
  passes `steuer mcp` through `session/new` `mcpServers`; the in-process tools move to MCP tools.
- **One-shot jobs** stay behind the `LLMProvider` port. A new `OpencodeProvider` runs them through
  lotse's headless job API (`runJob`) against the same agent, data directory and login as the
  widget. The answer is the agent's final ACP message, read as JSON and validated by this app's
  Zod schema (amended 2026-10-11, see below).
- **The Claude Agent SDK goes completely**: `ClaudeAgentProvider`, `chat-agent.ts` and the
  optional dependency.
- **Scaleway** as a separate direct provider goes too if opencode can connect it as a provider
  (verified in step 2); otherwise it stays as the one exception. **"No AI" stays**: every feature
  keeps its non-AI path (`app/dev/ai-boundary.allow.json`).
- **Validated output:** every job validates the model's answer with a Zod schema and rejects it
  otherwise. Prompts, VAT rates and category lists come from the country module (ADR 0001).
- **Privacy:** receipt data and tax figures only go to a provider the user connected. Free hosted
  defaults are refused through a model allow-list in the job API.
- **History:** conversation history lives in this app's data directory, readable only by the user,
  is included in the app's backups, and can be deleted in Settings.
- **UI:** lotse's current interface is a proof of concept, and so was this app's old assistant
  panel. The widget gets a fresh design (GNOME HIG, libadwaita), agreed with screenshots before it
  is built. The lotse app then uses the same widget.

## Order of work

1. **Planned, not implemented:** Zod-validated output for the three one-shot jobs; prompts and
   enums from the German country module. Useful on its own, independent of lotse.
2. **Planned, not implemented:** probe how often the final-text JSON of the three jobs comes back
   malformed (lotse ADR 0004, its step 2) and
   whether opencode can connect Scaleway; scratch HOME, demo text only, a user-connected model.
3. **Planned, not implemented (in lotse):** injectable paths and settings, `@lotse/core`,
   `mcpServers` plumbing, the headless job API with deny-all permissions, a connected check and
   the model allow-list.
4. **Planned, not implemented:** `OpencodeProvider` and `LLM_PROVIDER=opencode`; engine status
   reports whether a provider is connected.
5. **Planned, not implemented (in lotse):** the widget design, then `@lotse/widget` with inline
   provider onboarding; the lotse app moves onto it.
6. **Planned, not implemented:** the chat moves to the widget plus `steuer mcp`; the intake
   proposals flow gets an MCP tool with an approval step in the app.
7. **Planned, not implemented:** opencode becomes the default; the Claude Agent SDK and its
   provider are removed, with a migration note for users of the Claude CLI login.

## Consequences

- The app depends on lotse's packages and is meant to bundle opencode in a future Flatpak
  (planned, not built yet; packaging today is deb/rpm); opencode's version is pinned through
  lotse's agent catalog. opencode announces a v2 API, so the job API in lotse is
  the one place that absorbs its changes.
- Every AI path runs under GJS; the Node-only Claude path disappears.
- Until step 7 the existing providers keep working unchanged.
- A model answer that fails validation is an error the user sees, never a silently cast value.

## Amendment 2026-10-11: final ACP text instead of `json_schema`

[lotse ADR 0004](https://github.com/JumpLink/lotse/blob/main/docs/adr/0004-headless-job-api.md)
decides the transport of the headless job API, and it is not the one named above.

- **The answer is the final message, not `opencode serve` structured output.** `runJob<T>` runs one
  ACP turn and reads the agent's last message after `end_turn`: either the whole trimmed message is
  one JSON value, or its last ```` ```json ```` block is. `opencode serve` `json_schema` is dropped
  as the primary path: it is a second protocol to one agent, it bypasses lotse's ACP permission gate
  and model gate, and it ties the job API to opencode.
- **This app validates.** `OpencodeProvider` passes its Zod schema's `parse` as `runJob`'s `parse`,
  and may pass the JSON Schema as `schema` for the prompt instruction. A mismatch is a `JobError`
  of kind `'invalid'`, no JSON at all is `'malformed'`; both reach the user, there is no automatic
  retry. That is the "validated output" bullet above, now enforced at one place.
- **The model allow-list is mandatory.** `modelPolicy` is a required `runJob` option and is checked
  before the prompt; the jobs pass the same policy as the chat. Permissions default to deny-all.
- **The result-sink tool stays the fallback.** If the probe in step 2 shows final-text JSON is not
  rarely malformed, lotse adds it behind the same `parse`; this app's code does not change.
- **Not built yet.** `runJob` is accepted in lotse but not yet implemented or released; step 4 here
  waits for it.
