# Study: moving Steuererklärung's AI to the lotse/opencode agent approach (non-chat jobs)

Read-only study of this repository (main b7948c1) plus lotse docs and the
opencode docs. Items marked **UNVERIFIED** were not measured or run. Paths are relative to `app/src/` unless noted.

## 1. Inventory of AI call sites

Abstraction: `core/clients/llm/index.ts` (`getLLMProvider()`), interface `LLMProvider.complete({system,user,json,maxTokens,model})`
in `core/clients/llm/types.ts`. It returns raw text plus best-effort telemetry. Test seam: `setLLMProviderOverride`.

| # | Site | What | Trigger | Input | Output | Non-AI fallback (`app/dev/ai-boundary.allow.json`) |
|---|---|---|---|---|---|---|
| 1 | `core/actions/paperless/extract-invoice.ts:149` (`extractInvoiceFieldsFromContent`) | one-shot extraction of invoice fields, cross-checked against an optional Qonto tx | CLI `paperless extract-invoice-fields-incoming/outgoing` (`frontends/cli/paperless/extract.ts`), type handlers, review-metadata, invoice import/update (`actions/invoices/import.ts`, `update.ts`) | Paperless OCR text only (`doc.content`, cut at `DEFAULTS.LLM_MAX_CONTENT_LENGTH`) | one JSON object, `INVOICE_EXTRACTION_SYSTEM_PROMPT` (`core/lib/prompts.ts:19`); cast `as ExtractedInvoiceFields`, no schema validation | E-invoices (XRechnung/ZUGFeRD) are read from the data record without AI (`core/invoices/e-rechnung`); otherwise manual entry mask |
| 2 | `core/actions/paperless/review-metadata.ts:598` | metadata review: correspondent, document type, tags, title, created date, `ai_note` rationale | CLI `paperless review-metadata` (`maintenance.ts:108`), batch loop with throttle | OCR text plus lists of correspondents, types and tags | JSON, `REVIEW_METADATA_SYSTEM_PROMPT_DE/EN` (`prompts.ts:144/152`) | Paperless's own matching rules (`paperless/zuordnung.ts`); `actions/dokumentregeln.ts` for the built-in DMS; manual edit in the receipt dialog |
| 3 | `core/actions/paperless/classify-documents.ts:71` | classification: pick one document type id | CLI `paperless classify-documents` (`maintenance.ts:186`) | OCR text plus the type list | `{document_type_id, confidence, reason}`, `maxTokens` 256, lenient JSON parse | same as #2 |
| 4 | `core/actions/assistant/chat.ts:151` (`answerQuestion`) | single-shot Q&A over an aggregate text context | web `frontends/web/routes.ts:216`, desktop `frontends/desktop/data/assistent.ts:55`; used when the provider is not Claude, or when the agentic path fails | text context | free text | the UI offers the same answers as filters and hints |
| 5 | `core/actions/assistant/chat-agent.ts:126-291` (`answerAgentic`) | chat: tool-calling agent. Imports the Claude Agent SDK directly (bypasses `getLLMProvider`), in-process tools via `createSdkMcpServer`/`tool()`, `allowedTools` whitelist | web and desktop chat; only when `LLM_PROVIDER` is claude | question plus history | text plus intake `proposals` (approve-to-apply) | as #4 |
| 6 | `core/actions/assistant/engine-status.ts:28,54` | availability probe (settings screen, `einstellungen-view.ts:21`) | user click | none | status | n/a (excluded from the check) |
| 7 | MCP mode (`frontends/mcp/prompts.ts`, text from `lib/prompts.ts:253-296`) | **no app-side model call.** The client's own AI is told how to review via `paperless_*` tools (`REVIEW_METADATA_MCP_USAGE_NOTE`, `ENRICH_PAPERLESS_DOCUMENTS_PROMPT`) and writes `ai_note` back | an external agent | tools | tool calls | n/a |

Providers (`core/clients/llm/`):
- `claude-agent-provider.ts`: `@anthropic-ai/claude-agent-sdk` (`query`, `maxTurns:1`, no tools). It uses the logged-in Claude CLI
  subscription, or `ANTHROPIC_API_KEY`. It has retry with backoff and `isAuthError`. The SDK is an **optionalDependency, not
  redistributed** (licence), and is loaded lazily. The comment at ~line 104 says it is **not resolvable under GJS** (`--external`),
  so these commands are effectively **Node-only today**.
- `scaleway-provider.ts`: OpenAI-compatible HTTPS, `response_format: json_object`, key and config from `clients/scaleway`.
  This works under GJS.
- Selected by env `LLM_PROVIDER` (claude | scaleway | none/off/aus) and `LLM_MODEL`. `AI_NOT_CONFIGURED_MESSAGE` is the German
  "no AI set up" text. Default is `claude`.
- Guard: `check:ai` (`app/dev/check-ai-boundary.js`) demands an `ohneKi` sentence per site in `app/dev/ai-boundary.allow.json`.
  This is the app's central promise: usable without AI.

## 2. How generic is the receipt analysis?

- **Not tied to Paperless in principle, tied in practice.** The LLM step takes a string (`extractInvoiceFieldsFromContent(content, direction, qontoCtx)`),
  so it works on any text. Everything around it is Paperless-coupled: document fetch via `@steuererklaerung/paperless`, writing
  custom fields (`buildInvoiceCustomFieldsPayload`, field ids from `config.custom_field_ids`), the `ai_note` field. The built-in DMS
  path (`actions/invoices/import.ts`) reuses the same function. `core/invoices/e-rechnung/index.ts` reads PDF/XML bytes and
  `extractPdfText` (`@steuererklaerung/dms`) exists, but **no job sends a PDF or image to the model.** There is no vision path.
  Scans depend on Paperless's OCR (or on the DMS's text layer).
- **Structured output:** none enforced. The prompt says "respond with JSON"; the Claude path appends `JSON_INSTRUCTION`; Scaleway uses
  `json_object`. The reply goes through `extractJsonCandidate` and `parseJsonLeniently` (`@steuererklaerung/shared`) and is **cast**
  to the interface. Validation happens per field afterwards: enum membership (`ACCOUNTING_CATEGORY_OPTIONS`, `SUPPLIER_COUNTRY_OPTIONS`),
  `normalizeTaxRateLabel`, `toDateOnly`, `isDateInRangeStrict`, numeric NaN checks. So there is no schema (no Zod or JSON Schema) for the model output.
- **German-specific content (matters for ADR-0001, `docs/adr/0001-country-modules-and-per-entity-tax-switch.md`):**
  - `tax_rate` is fixed to `0%|5%|7%|16%|19%` (German VAT, incl. the 2020 COVID rates).
  - `reverse_charge` references §13b UStG, and "supplier outside Germany and 0% ⇒ true".
  - `supplier_country` defaults to "DE" when only a German city is given.
  - `accounting_category` is a hard-coded German chart of accounts (SKR-style: 8400, 4946, 4806, 1789, …) in the prompt, via the `ACCOUNTING_CATEGORY_ENUM` in `lib/select-field-constants.ts`.
  - The assistant prompts say "deutsche Entität".
  - Review prompts exist in DE and EN (`PromptLanguage`); extraction and classification are English prompts with German domain terms.
  - **Consequence:** the prompt and the enums must become part of the country module (`core/countries/`, `de` | `none` | future `at`): `taxRates`, the account-category list,
    a reverse-charge rule, the default country. With `taxModule:'none'` the extraction should skip the tax fields. That is a precondition for any schema-based approach,
    because the JSON schema would be generated from the country module.

## 3. Options for the one-shot jobs

Goal: one provider login, made once in the widget, serves every AI feature.

### a) Keep the direct provider call (status quo)
- Pros: deterministic path we own. Scaleway runs under GJS. Fast (no agent overhead). Easy to test (`setLLMProviderOverride`).
  Works headless and in CI. The EU provider is a privacy plus.
- Cons: **two logins** (widget and `LLM_PROVIDER`/Claude CLI/Scaleway key), the opposite of the goal. The Claude path is Node-only under GJS
  and needs a user-installed SDK. No enforced structured output. Subscription use through the Agent SDK is exactly what the bundled opencode would replace.

### b) Headless ACP session through the bundled opencode
- Mechanics: lotse starts `opencode acp`, `session/new` with `mcpServers`, one prompt turn, read the agent message. It uses the same isolated
  HOME/XDG (`<dataDir>/agents/opencode`, `core/agents/isolation.ts` in lotse) as the widget, so the same login. Permission gate: deny-all.
  Chunks arrive through `session/update`.
- **ACP has no structured-output field** (v1 schema: `PromptRequest` carries content blocks only, `refs/acp/schema.v1.json` in lotse). So structured
  output is either prompt-and-parse, as today (unreliable, and the agent may add prose or tool calls), or the **sink-tool pattern**:
  the host adds a tiny stdio/http MCP server with one tool `submit_result` whose input schema is the target JSON Schema; the prompt says
  "call submit_result exactly once". Arguments are validated by the host and re-prompted on failure. This is reliable in practice (**UNVERIFIED** on opencode; the
  same mechanism opencode uses internally for its `StructuredOutput` tool, see c). It depends on opencode honouring `session/new.mcpServers`, which lotse's widget study marks **UNVERIFIED**.
- Pros: one login, no new dependency in the app (lotse already speaks ACP), reuses permission and sandbox handling, an MCP tool gives the agent
  Paperless/Qonto context (for example fetching the tx itself). Cons: process start per job unless a session or process is reused (cold start **UNVERIFIED**, likely 1-3 s),
  agent system prompt and tool list inflate tokens, a model may deviate, no `temperature`/`maxTokens` knob in ACP (config options are agent-specific), and a streaming
  protocol is heavier than needed for a request/response.

### c) opencode SDK / `opencode serve` HTTP API
- **Exists.** `@opencode-ai/sdk` (npm: https://www.npmjs.com/package/@opencode-ai/sdk; docs https://opencode.ai/docs/sdk/). `createOpencode()` starts a
  server and returns a client; `createOpencodeClient({baseUrl, fetch})` connects to a running one. The server is `opencode serve --port --hostname`
  (https://opencode.ai/docs/server/), OpenAPI 3.1 at `/doc`, optional basic auth `OPENCODE_SERVER_PASSWORD`.
- **Structured output is supported**: `client.session.prompt({path:{id}, body:{parts, format:{type:"json_schema", schema, retryCount}}})`; the model is forced
  through a `StructuredOutput` tool, the result lands in `result.data.info.structured_output`, and failure after retries yields `info.error.name === "StructuredOutputError"`
  (default 2 retries) (https://opencode.ai/docs/sdk/#structured-output). **Caveat:** the same page's session table names the field `body.outputFormat`, the example uses `format`.
  The docs disagree with themselves; check `/doc` of the installed version before coding. The page also announces opencode v2 (https://opencode.ai/v2); API drift is a risk.
- Per-call controls from the HTTP docs: `POST /session/:id/message` body `{model, agent, system, tools, parts, noReply}`. So we can pin `model`, supply our own
  `system` and set `tools` to disable all built-ins. `PUT /auth/:id` and `/provider/auth`, `/provider/{id}/oauth/authorize|callback` exist, so a host could even drive login
  itself. `POST /mcp` adds an MCP server dynamically (so `steuer mcp` is reachable).
- **Under GJS:** the client is a generated fetch-based client with an injectable `fetch`, so it should run on gjsify's fetch/web stack (**UNVERIFIED**; not tested, and
  `createOpencode()` uses `child_process` spawn which needs gjsify's `node:child_process`; safer is lotse spawning `opencode serve` and the app using `createOpencodeClient` or plain `fetch`).
  The wire contract is small enough to hand-roll (`POST /session`, `POST /session/:id/message`) if the SDK does not bundle under GJS.
- Pros: **schema-validated output with retries done by opencode**, per-call model and no tools, request/response semantics, one long-lived server for batches
  (no per-doc start), same login if the server runs with the widget's isolated HOME, `GET /provider` tells which providers are `connected` (replaces `engine-status`).
  Cons: a second process mode in lotse (serve next to acp; must share `auth.json` state with the widget's agent without both writing), loopback HTTP port plus password to manage,
  JSON-schema forcing via tool call is weaker on small free models, and a session per document should be deleted afterwards (`DELETE /session/:id`) to avoid history pollution.
  Latency/cost: one extra tool round-trip for structured output (**UNVERIFIED**).

### d) Reuse opencode's provider auth, call the model directly
- Read `auth.json` from the bundled agent's isolated HOME and call Anthropic/OpenAI ourselves. **Reject.** lotse's rule is that it never reads credentials back
  (lotse AGENTS.md, Privacy), a stored OAuth/subscription token is meant for the agent, not for third-party clients, and it welds us to opencode's file format.
  It would also bring back provider plumbing per provider (the very thing the abstraction exists for).
- Acceptable variant: opencode as the **credential/model router** only, via `opencode serve` (that is option c) or its `/provider` listing to *show* what is connected.

### Comparison

| | a direct | b ACP headless | c serve + SDK | d read auth.json |
|---|---|---|---|---|
| one login | no | yes | yes | yes (but forbidden) |
| structured output | prompt+lenient parse | sink-tool, our validation | native `json_schema` + retries | ours |
| latency | lowest | cold start + agent overhead | warm server, small overhead | lowest |
| cost/tokens | lowest | agent prompt overhead | tools can be disabled | lowest |
| determinism | medium | low | medium | medium |
| offline/local | Scaleway no, none yet | via opencode's local providers | same | n/a |
| privacy | free choice of EU provider | follows the provider the user connected | same | n/a |
| GJS | Scaleway yes, Claude SDK no | needs lotse acp only | SDK **UNVERIFIED**, raw fetch ok | n/a |
| testability | best (override seam) | stand-in agent exists in lotse | fake HTTP server | ok |

Privacy note (workspace rule in werkstatt AGENTS.md): free hosted opencode models (Zen etc.) must never receive receipt data. A job API must therefore take an explicit
**model allowlist or "user-connected provider only"** and refuse the free default. Scaleway (EU) stays valuable as a documented privacy-first alternative.

## 4. Recommendation and order

**Keep the `LLMProvider` port, add a third implementation that goes through the bundled opencode via `opencode serve` (c), with ACP-with-sink-tool (b) as a fallback and Scaleway/none kept.**
The port already isolates all four one-shot jobs (#1-#4); only the factory changes. Chat (#5) moves into the widget and the Agent SDK dependency disappears with it.

| Step | What | Size | Risk |
|---|---|---|---|
| 1 | In steuer: extend the port with a schema-aware call `extract<T>({system,user,schema})` and validate with Zod for #1-#3 (output schemas derived from the types and the country module); make prompts/enums come from `core/countries/` (ADR-0001 step 4+). Works with today's providers (parse + validate + one repair retry). | M | prompt regression; no live data to test, use synthetic fixtures |
| 2 | Probe (a spike, not production): is `session/new.mcpServers` honoured by opencode, and does `format:{type:"json_schema"}` (or `outputFormat`) work on the installed version; measure cold start and per-job latency with a throwaway HOME. | S | answers the UNVERIFIED items; decides b vs c |
| 3 | lotse: headless job API in `@lotse/core` (below), first against `opencode serve`. | L | the second process mode; shared auth state |
| 4 | Steuer: `OpencodeProvider implements LLMProvider` (calls the lotse job API / HTTP), add `LLM_PROVIDER=opencode`, extend `engine-status` with `connected`; add to `check:ai` allow-list as before. | M | GJS fetch behaviour of the SDK; auth error mapping (replace `isAuthError`) |
| 5 | Chat: `chat-agent.ts` replaced by the widget plus `steuer mcp` over `session/new`; move the in-process tools (`createSdkMcpServer`) to MCP tools; the intake `proposals` flow needs an MCP tool and a host-side approve UI. | L | biggest behaviour change; tool parity |
| 6 | Default switch to `opencode` once one login works; drop `ClaudeAgentProvider`/optional SDK; keep `scaleway` and `none`. Doc + `check:ai` entries. | S | users with a working Claude CLI setup need a migration note |

**What must exist in lotse (public, LGPL packages, host-agnostic):**
1. `@lotse/core` headless job API, no GTK: `runJob({ prompt, system?, schema?, model?, mcpServers?, tools:'none'|'host', timeoutMs, signal }) → { output, structured?, usage }`,
   permissions fixed to deny-all (guardrail 1: a job is not a session grant). It resolves the agent exactly like the widget (`resolveAgent`) and uses the **same `dataDir` and isolated HOME**,
   so there is one login.
2. A job runner that owns one warm `opencode serve` (loopback, random port, generated password, 0600 pid/port file under the host's dataDir) or a pooled ACP agent, sessions created and
   deleted per job, with bounded concurrency (batch loops over hundreds of documents).
3. A provider-state call for hosts: "is a provider connected, which model" (`GET /provider` → `connected`), plus an error taxonomy (`not-logged-in`, `rate-limited`, `schema-failed`) so steuer can keep its
   friendly German messages.
4. Model policy hook: `allowModel(modelId) => boolean` so the host can refuse free/hosted-for-training models for document data.
5. A stand-in for tests (lotse already has `scripts/stand-in-agent.mjs`; add a stand-in `serve` that returns canned `structured_output`).
6. The widget and the job runner share the agent-state locking (two clients on one `auth.json`/session DB).

**Biggest open risks:** (1) opencode API drift (docs conflict on the structured-output field; v2 announced), (2) `mcpServers` acceptance, (3) GJS support of the SDK client,
(4) weaker structured output on small models, so keep the app-side Zod validation plus the existing per-field normalisation as the final gate, (5) privacy routing of document data.

## Sources
- https://opencode.ai/docs/sdk/ (client, `session.prompt`, structured output, `auth.set`)
- https://opencode.ai/docs/server/ (`opencode serve`, endpoints, OpenAPI `/doc`, auth)
- https://www.npmjs.com/package/@opencode-ai/sdk (package; not fetched, referenced from the SDK docs)
- Repo: `app/src/core/clients/llm/*`, `core/lib/prompts.ts`, `core/actions/paperless/{extract-invoice,review-metadata,classify-documents}.ts`,
  `core/actions/assistant/{chat,chat-agent,engine-status}.ts`, `app/dev/ai-boundary.allow.json`, `docs/adr/0001-country-modules-and-per-entity-tax-switch.md`
- lotse: [lotse](https://github.com/JumpLink/lotse) `AGENTS.md` and its embeddable-widget study (`docs/architecture/embeddable-widget-study.md`)
