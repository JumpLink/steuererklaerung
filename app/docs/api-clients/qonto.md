# Qonto API Client - Extension Guide

Reference sources and conventions for extending the Qonto API client. Do not copy n8n or SDK code verbatim; adapt to our structure and auth (Login:SecretKey).

## 1. Endpoint reference (paths, query, body)

**n8n-nodes-qonto-api** (external repo):

- `nodes/Qonto/Qonto.node.ts` - all resources and operations with endpoint paths, query params, and request bodies.
- `nodes/Qonto/helpers.ts` - `formatDateTime` (ISO without ms), `formatDate` (YYYY-MM-DD), pagination (`current_page`, `per_page`, response key = endpoint name, `meta.total_pages`).

Use these to get the exact Qonto v2 paths (e.g. `organization`, `bank_accounts`, `transactions`, `transactions/:id/attachments`) and parameter names.

## 2. Structure and patterns

**Client structure** (same shape across all hand-rolled clients):

- `src/core/clients/qonto/`
- **Pattern:** One `request.ts` (config, base URL, headers, `get`/`post`/...), domain modules per resource (e.g. `transactions.ts`, `attachments.ts`), shared `types.ts`, re-exports from `index.ts`.

For each new Qonto resource:

- Prefer a new module (e.g. `resource-name.ts`) that uses `request.ts` (`get`, `post`, `listAll`, `postMultipart` where needed).
- Add types in `qonto/types.ts` and use them in the new module.
- Export public functions and types from `qonto/index.ts`.

## 3. Request layer (existing)

**Path:** `src/core/clients/qonto/request.ts`

- **Provided:** `config()`, `get()`, `post()`, `patch()`, `deleteRequest()`, `postMultipart()` (multipart/form-data), `listAll()` (pagination). Paths are relative to `baseUrl/v2/`.
- **Env:** `QONTO_ENV=production|staging`; credentials from `QONTO_PRODUCTION_SIGN_IN`/`QONTO_PRODUCTION_SECRET_KEY` or `QONTO_STAGING_SIGN_IN`/`QONTO_STAGING_SECRET_KEY`/`QONTO_STAGING_TOKEN` (fallback: `QONTO_SIGN_IN`, `QONTO_SECRET_KEY`). Optional: `QONTO_BASE_URL`.
- **Exports:** `getQontoEnv()`, `getDefaultBankAccountId()`.

Extend only if the API requires something new (e.g. another method or content type).

## 4. Official API docs

- **URL:** https://docs.qonto.com/ (Business API, authentication, scopes)
- Use for exact field names, response shapes, and required scopes when adding endpoints.

## 5. @qonto/embed-sdk (reference only)

- **Package:** `@qonto/embed-sdk` (in `package.json` for reference)
- **Role:** Inspiration/reference only - for types, API endpoint paths, and response shapes. Do not use as a runtime dependency; we implement endpoints ourselves with `request.ts`.
- **Note:** The SDK uses Access-Token (OAuth), not Login:SecretKey. Adapt to our auth and structure.

## Checklist when adding an endpoint

1. Look up path and parameters in `Qonto.node.ts` (and helpers for date/pagination).
2. Add or reuse types in `qonto/types.ts`.
3. Implement in a domain module using `request.ts`; use `listAll()` for paginated lists.
4. Export from `qonto/index.ts`.
5. Optionally mention the new capability in the CLI README (Qonto section).
