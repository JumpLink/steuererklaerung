# Adding Paperless Resources (Document Types, Custom Fields, Tags)

When adding new **document types**, **custom fields**, or **tags** that the sync uses (match/import), follow this pattern so they are created on demand and their IDs stored in the `paperless` section of `steuererklaerung.json`.

## 1. Config (`src/core/config/schema/paperless.ts` + the `paperless` section of `steuererklaerung.json`)

The Paperless sync config is the `paperless` section of the consolidated `steuererklaerung.json` manifest; its Zod schema lives in `schema/paperless.ts` (the former standalone `sync-config.ts` loader is gone).

- **Schema:** Add the new key to the right Zod object in `schema/paperless.ts`:
  - Document types: `DocumentTypeIdsSchema` → `<key>: nonNegativeInt`
  - Custom fields: `CustomFieldIdsSchema` → `<key>: nonNegativeInt`
  - Tags: `TagIdsSchema` → `<key>: nonNegativeInt`
- **Defaults:** Add the new key with value `0` to the matching `DEFAULT_*_IDS` const in the same file (`DEFAULT_DOCUMENT_TYPE_IDS` / `DEFAULT_CUSTOM_FIELD_IDS` / `DEFAULT_TAG_IDS`).
- **`steuererklaerung.example.json`:** Add the new key with value `0` under `paperless.<section>`.

## 2. Setup (`src/core/actions/paperless/setup.ts`)

- **RESOURCES:** Add one or more entries:
  - **Document type:** `key: 'document_type_ids'`, `configKey: '<key>'`, `name: 'Display Name'`, `create: () => createDocumentType({ name: '...' }).then(r => ({ id: r.id }))`.
  - **Custom field:** `key: 'custom_field_ids'`, `configKey: '<key>'`, `name: 'Display Name'`, `create: () => createCustomField({ name: '...', data_type: 'string'|'float'|'date'|... }).then(r => ({ id: r.id }))`.
  - **Tag:** `key: 'tag_ids'`, `configKey: '<key>'`, `name: 'tag-slug'`, `create: () => createTag({ name: '...' }).then(r => ({ id: r.id }))`.
- Setup only creates resources whose config ID is 0; it then writes all IDs back with `writeSyncConfig(updates)`.

## 3. Import / Usage (`src/core/actions/sync/import.ts` and callers)

- If the new field must be **set on import:** Extend `ImportAttachmentToPaperlessParams` with optional data (e.g. `amount_cents?: number`, `settled_at?: string | null`). In `applyQontoMetadata()`, read the new config IDs from `config.custom_field_ids.<key>`; if the ID is set and the value is provided, append `{ field: id, value: formattedValue }` to `customFields`.
- **Callers** (e.g. sync interactive): When calling `importAttachmentToPaperless()`, pass the new params from the report/context.
- **Document types** are used for `document_type` in `postDocument()`. New document types would only be needed for a new category.
- **Tags** are applied in `applyQontoMetadata()` from `config.tag_ids.qonto_import`. Additional tags require a new config key and merging in the same way.

## 4. Paperless Custom Field Data Types

- `string`: UUIDs, text.
- `float`: Numbers (e.g. transaction amount in currency units; use signed for debit/credit).
- `date`: Use string `YYYY-MM-DD`.
- `monetary`: If you need currency; otherwise float is enough.

## 5. Checklist

1. Add `custom_field_ids.<new_key>` to `CustomFieldIdsSchema` + `DEFAULT_CUSTOM_FIELD_IDS` in `src/core/config/schema/paperless.ts`, and to `paperless.custom_field_ids` in `steuererklaerung.example.json`.
2. Add entry to RESOURCES in `src/core/actions/paperless/setup.ts` (name + data_type).
3. If used on import: add param to `ImportAttachmentToPaperlessParams`, extend `applyQontoMetadata` to push the value when ID and value are present, pass from interactive (or other caller).
4. Run `paperless setup-fields` once to create the field and write the ID into the `paperless` section of `steuererklaerung.json`.
