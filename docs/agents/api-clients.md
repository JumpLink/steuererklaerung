# API client conventions

The REST clients are hand-rolled and share one shape — follow the matching rule, do not invent a
new pattern per client.

[Qonto]|dir: `app/src/core/clients/qonto/`
|auth: Login+SecretKey env `QONTO_SIGN_IN` / `QONTO_SECRET_KEY`; `QONTO_PRODUCTION_*` /
`QONTO_STAGING_*` override per `QONTO_ENV`; opt: `QONTO_BASE_URL`, `QONTO_STAGING_TOKEN`
|structure: `request.ts` (`get/post/patch/deleteRequest/postMultipart/listAll`) + one module per
resource (`transactions.ts`, `attachments.ts`, …) + shared `types.ts` + `index.ts` re-exports
|paths relative to `baseUrl/v2/`
|refs: 1) `n8n-nodes-qonto-api` → `nodes/Qonto/Qonto.node.ts` (paths/query/body) + `helpers.ts`
(date formats, pagination) 2) https://docs.qonto.com/ 3) `@qonto/embed-sdk` = types only, do NOT
depend on it for endpoints (OAuth-only; we use Login:SecretKey)

[New endpoint]|1 look up the exact path + params in the ref source |2 add/reuse types in
`types.ts` |3 implement via the shared `request.ts` helpers (`listAll()` for paginated Qonto
lists) |4 export from `index.ts` |5 JSDoc: purpose, params, return, required env vars |6 update
the CLI README if you exposed a new command
