# 2. All AI features go through kurier and the bundled opencode

- Status: **Accepted**; all steps planned, not implemented
- Date: 2026-10-10
- Deciders: Pascal Garber
- Related: [AI jobs study](../architecture/ai-jobs-study.md),
  [ADR 0001](0001-country-modules-and-per-entity-tax-switch.md),
  [kurier ADR 0001: kurier as an embeddable widget](https://github.com/JumpLink/kurier/blob/main/docs/adr/0001-kurier-as-an-embeddable-widget.md)

## Context

The app calls a language model in five places: invoice extraction, metadata review and
document-type classification (one-shot jobs over OCR text), plus the assistant chat in a
one-shot and an agentic form. Two providers exist, the Claude Agent SDK and Scaleway, chosen by
`LLM_PROVIDER`. The agentic chat imports the Claude Agent SDK directly and bypasses the
`LLMProvider` port. The SDK does not resolve under GJS, so those paths run on Node only.

The one-shot jobs parse the model's JSON leniently and cast it to a type; nothing validates it.
Their prompts hard-code German VAT rates, § 13b and a German category list.

[kurier](https://github.com/JumpLink/kurier) is an ACP client that starts coding agents as
subprocesses. It stays a standalone app that keeps growing, and it will also ship LGPL packages
(`@kurier/core`, `@kurier/widget`) so other GTK apps can embed it. A probe showed that opencode
2.0.25 honours the MCP servers a client passes in ACP `session/new`, so this app can hand its own
`steuer mcp` tools to a bundled opencode without touching the user's global configuration.

## Decision

- **One login for every AI feature.** The user connects one provider once, in the embedded kurier
  widget, and the chat and every one-shot job use it.
- **Chat:** the assistant becomes the `@kurier/widget` chat with a bundled opencode. The app
  passes `steuer mcp` through `session/new` `mcpServers`; the in-process tools move to MCP tools.
- **One-shot jobs** stay behind the `LLMProvider` port. A new `OpencodeProvider` runs them through
  kurier's headless job API against the same agent, data directory and login as the widget, with
  `opencode serve` structured output (`json_schema`). ACP with a result-sink tool is the fallback
  if structured output proves unreliable.
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
- **UI:** kurier's current interface is a proof of concept, and so was this app's old assistant
  panel. The widget gets a fresh design (GNOME HIG, libadwaita), agreed with screenshots before it
  is built. The kurier app then uses the same widget.

## Order of work

1. **Planned, not implemented:** Zod-validated output for the three one-shot jobs; prompts and
   enums from the German country module. Useful on its own, independent of kurier.
2. **Planned, not implemented:** probe `opencode serve` structured output (`json_schema`) and
   whether opencode can connect Scaleway; scratch HOME, demo text only, a user-connected model.
3. **Planned, not implemented (in kurier):** injectable paths and settings, `@kurier/core`,
   `mcpServers` plumbing, the headless job API with deny-all permissions, a connected check and
   the model allow-list.
4. **Planned, not implemented:** `OpencodeProvider` and `LLM_PROVIDER=opencode`; engine status
   reports whether a provider is connected.
5. **Planned, not implemented (in kurier):** the widget design, then `@kurier/widget` with inline
   provider onboarding; the kurier app moves onto it.
6. **Planned, not implemented:** the chat moves to the widget plus `steuer mcp`; the intake
   proposals flow gets an MCP tool with an approval step in the app.
7. **Planned, not implemented:** opencode becomes the default; the Claude Agent SDK and its
   provider are removed, with a migration note for users of the Claude CLI login.

## Consequences

- The app depends on kurier's packages and bundles opencode in its Flatpak; opencode's version is
  pinned through kurier's agent catalog. opencode announces a v2 API, so the job API in kurier is
  the one place that absorbs its changes.
- Every AI path runs under GJS; the Node-only Claude path disappears.
- Until step 7 the existing providers keep working unchanged.
- A model answer that fails validation is an error the user sees, never a silently cast value.
