# Paperless-NGX API Client - Extension Guide

Reference sources and conventions for extending the Paperless-NGX API client. Keep code and comments in English.

## 1. Official API Documentation

**URL:** https://docs.paperless-ngx.com/api/

- **File Uploads:** `POST /api/documents/post_document/` - multipart/form-data, required field `document` (file), optional: `title`, `created`, `correspondent`, `document_type`, `storage_path`, `tags` (multiple), `archive_serial_number`, `custom_fields`. Response: `task_id` (UUID); status via `GET /api/tasks/?task_id={uuid}`.
- **Filtering by custom fields:** `GET /api/documents/` with `custom_field_query` parameter (syntax e.g. `["fieldname", "exact", value]`, `range`, `icontains` etc.).
- **Bulk Editing:** `POST /api/documents/bulk_edit/` - JSON body: `documents` (IDs), `method` (e.g. `modify_custom_fields`, `set_correspondent`, `add_tag`), `parameters`.
- **API versioning:** Header `Accept: application/json; version=6` (or higher).
- **Auth:** Token from "My Profile" in the UI; Header `Authorization: Token <token>`.

Further endpoints (Tags, Correspondents, Document Types, Storage Paths, Notes, Download, Thumbnail) are documented at `/api/schema/view/`.

## 2. Python API Client (reference only)

**Path (external repo):** a local checkout of `pypaperless` (path is machine-specific)

- `pypaperless/api.py` - Base URL, headers, `request()` with method/path/json/form/params, FormData processing for upload.
- `pypaperless/const.py` - API paths (`documents`, `documents_post`, `tasks`, `custom_fields`, etc.).
- `pypaperless/models/documents.py` - `DocumentDraft._serialize()` form fields, `Document` model incl. `custom_fields`.
- `pypaperless/models/tasks.py` - `GET /api/tasks/?task_id={uuid}` returns array; `related_document` = created document ID on success.
- `pypaperless/models/custom_fields.py` - CustomField types, create/update via Draft.

Adapt to our TypeScript structure; do not copy Python syntax or libraries.

## 3. Request layer (existing)

**Path:** `packages/paperless/src/request.ts`

- **Config:** `PAPERLESS_BASE_URL`, `PAPERLESS_API_TOKEN`; `config()` returns `{ config | error }`, `getConfig()` throws on error.
- **Methods:** `get<T>(path, query?)`, `post<T>(path, body?, extraHeaders?)`, `patch<T>(path, body?)`, `postMultipart<T>(path, formData?, extraHeaders?)`. Path relative to base URL (e.g. `/api/documents/`). For multipart, don't set Content-Type (boundary from fetch).
- **Query:** `buildQuery()` supports objects/arrays (arrays as multiple params, objects as JSON string).

Add new methods (e.g. `delete`) only if the API requires it.

## 4. Client structure (maintain this pattern)

- **`request.ts`:** Configuration, get/post/patch/postMultipart.
- **`types.ts`:** Shared types (Document, DocumentCustomFieldValue, Task, CustomField, CustomFieldDataType, Paginated*, PostDocumentOptions, UpdateDocumentPayload, etc.).
- **Resource modules:** `documents.ts`, `tasks.ts`, `custom-fields.ts`. Each module uses only `request.ts` and `types.ts`; no cross-imports between resource modules.
- **`index.ts`:** `check()` (via config + listDocuments), re-export of all public functions and types.

New resources (e.g. Tags, Correspondents, Document Types): own module (e.g. `tags.ts`), types in `types.ts`, export in `index.ts`.

## 5. Conventions for new endpoints

1. **Check docs + Python client:** Exact path, query/body parameters, response format (single object vs. paginated list with `count`/`next`/`previous`/`results`).
2. **Types in `types.ts`:** Interfaces for request/response; for paginated lists `PaginatedX` with `count`, `next`, `previous`, `results`.
3. **Function in appropriate module:** Call `get`/`post`/`patch`/`postMultipart` from `request.ts`; path with leading slash (e.g. `/api/tags/`).
4. **Export in `index.ts`:** Re-export public functions and needed types.
5. **JSDoc:** Brief description, parameters, return type, env notes if applicable.

## Do not adopt from Python client

- Async/await patterns from aiohttp, caching (PaperlessCache), mixins, dataclass serialization.

## Use as reference from Python client

- API paths, form field names for post_document, task query with `task_id`, custom field data types and extra_data (select_options, default_currency), bulk edit methods and parameters.
