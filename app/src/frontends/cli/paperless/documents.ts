import type { CommandModule } from 'yargs';

import { paperlessDocuments, paperlessDocument, paperlessTask } from '../../../core/actions/paperless/read.ts';
import {
    paperlessUpdateDocument,
    paperlessUpdateDocumentFields,
    paperlessTrashDocument,
} from '../../../core/actions/paperless/write.ts';
import { paperlessUploadDocument } from '../../../core/actions/paperless/upload.ts';
import { paperlessZuordnung } from '../../../core/actions/paperless/zuordnung.ts';
import type { UpdateDocumentPayload } from '@steuererklaerung/paperless';
import { pickArgv, runAndExit } from '../output.ts';

export const documentsSubcommand: CommandModule = {
    command: 'documents',
    describe: 'List documents (paginated), optionally filtered by document type',
    builder: (y) =>
        y
            .option('page-size', { type: 'number', default: 10, describe: 'Page size' })
            .option('page', { type: 'number', default: 1, describe: 'Page number' })
            .option('query', { type: 'string', describe: 'Search query' })
            .option('document-type-id', { type: 'number', describe: 'Filter by document type ID' })
            .option('tags', { type: 'string', describe: 'Comma-separated tag IDs (all must match)' })
            .option('check-types', {
                type: 'boolean',
                default: false,
                describe: 'Show document_type distribution in results (to verify API filter strictness)',
            }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const pageSize = pickArgv<number>(raw, 'pageSize', 'page-size');
        const page = pickArgv<number>(raw, 'page');
        const query = pickArgv<string>(raw, 'query');
        const documentTypeId = pickArgv<number>(raw, 'documentTypeId', 'document-type-id');
        const tagsCsv = pickArgv<string>(raw, 'tags');
        const tagIds = tagsCsv
            ? tagsCsv
                  .split(',')
                  .map((s) => Number(s.trim()))
                  .filter((n) => Number.isFinite(n))
            : undefined;
        const checkTypes = Boolean(raw['check-types'] ?? raw['checkTypes']);
        runAndExit(async () => {
            const result = await paperlessDocuments({
                page_size: pageSize,
                page,
                query,
                document_type_id: documentTypeId,
                tag_ids: tagIds,
            });
            if (checkTypes && result.results?.length > 0) {
                const typeCounts = new Map<number | null, number>();
                let mismatchCount = 0;
                for (const doc of result.results) {
                    const dt = doc.document_type ?? null;
                    typeCounts.set(dt, (typeCounts.get(dt) ?? 0) + 1);
                    if (documentTypeId != null && dt !== documentTypeId) mismatchCount++;
                }
                console.error(`\n--- document_type distribution (${result.results.length} docs on this page) ---`);
                for (const [typeId, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
                    const label = typeId != null ? `type ${typeId}` : 'null (no type)';
                    const marker = documentTypeId != null && typeId !== documentTypeId ? ' ← MISMATCH' : '';
                    console.error(`  ${label}: ${count}${marker}`);
                }
                if (documentTypeId != null && mismatchCount > 0) {
                    console.error(
                        `  ⚠ ${mismatchCount} document(s) have a different type than requested (${documentTypeId})`,
                    );
                } else if (documentTypeId != null) {
                    console.error(`  ✓ All documents match requested type ${documentTypeId}`);
                }
                console.error('');
            }
            return result;
        });
    },
};

export const documentSubcommand: CommandModule = {
    command: 'document <id>',
    describe: 'Get a single document by id',
    builder: (y) => y.positional('id', { type: 'number', demandOption: true }),
    handler: (argv) => {
        runAndExit(() => paperlessDocument((argv as unknown as { id: number }).id));
    },
};

export const updateDocumentSubcommand: CommandModule = {
    command: 'update <id>',
    describe:
        'Correct a document’s metadata: --title, --document-type-id, --correspondent-id, --created (YYYY-MM-DD), --tags (comma-separated IDs). Only the given fields change.',
    builder: (y) =>
        y
            .positional('id', { type: 'number', demandOption: true })
            .option('title', { type: 'string', describe: 'New title' })
            .option('document-type-id', {
                type: 'number',
                describe: 'New document type ID (0 or "null" to clear)',
            })
            .option('correspondent-id', {
                type: 'number',
                describe: 'New correspondent ID (0 or "null" to clear)',
            })
            .option('created', { type: 'string', describe: 'Document date YYYY-MM-DD' })
            .option('tags', { type: 'string', describe: 'Comma-separated tag IDs (replaces tags)' })
            .option('data-scope', { type: 'string', describe: 'privat | geschäftlich | gemischt' })
            .option('custom-field', {
                type: 'array',
                describe: 'Custom field as name=value (repeatable, friendly names; merged, not replaced)',
            }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const id = pickArgv<number>(raw, 'id');
        const payload: UpdateDocumentPayload = {};
        const title = pickArgv<string>(raw, 'title');
        if (title != null) payload.title = title;
        const dt = pickArgv<number>(raw, 'documentTypeId', 'document-type-id');
        if (dt != null) payload.document_type = dt > 0 ? dt : null;
        const corr = pickArgv<number>(raw, 'correspondentId', 'correspondent-id');
        if (corr != null) payload.correspondent = corr > 0 ? corr : null;
        const created = pickArgv<string>(raw, 'created');
        if (created != null) payload.created = created;
        const tags = pickArgv<string>(raw, 'tags');
        if (tags != null) {
            payload.tags = tags
                .split(',')
                .map((t) => parseInt(t.trim(), 10))
                .filter((n) => Number.isInteger(n) && n > 0);
        }
        const customFields: Record<string, unknown> = {};
        const dataScope = pickArgv<string>(raw, 'dataScope', 'data-scope');
        if (dataScope) customFields.data_scope = dataScope;
        const cfArgs = raw['custom-field'] ?? raw['customField'];
        if (Array.isArray(cfArgs)) {
            for (const pair of cfArgs) {
                const [key, ...rest] = String(pair).split('=');
                if (key && rest.length > 0) customFields[key.trim()] = rest.join('=');
            }
        }
        const hasCustomFields = Object.keys(customFields).length > 0;
        runAndExit(async () => {
            if (id == null) throw new Error('id is required');
            if (Object.keys(payload).length === 0 && !hasCustomFields)
                throw new Error(
                    'Nothing to update — pass at least one of --title/--document-type-id/--correspondent-id/--created/--tags/--data-scope/--custom-field',
                );
            const updated = hasCustomFields
                ? await paperlessUpdateDocumentFields(id, { payload, customFields })
                : await paperlessUpdateDocument(id, payload);
            return {
                id: updated.id,
                title: updated.title,
                document_type: updated.document_type,
                correspondent: updated.correspondent,
                created: updated.created,
            };
        });
    },
};

export const trashDocumentSubcommand: CommandModule = {
    command: 'trash <id>',
    describe:
        'Move a document to the Paperless trash (soft delete, restorable). Use for the worse copy of a duplicate.',
    builder: (y) => y.positional('id', { type: 'number', demandOption: true }),
    handler: (argv) => {
        runAndExit(() => paperlessTrashDocument((argv as unknown as { id: number }).id));
    },
};

export const uploadDocumentSubcommand: CommandModule = {
    command: 'upload <file>',
    describe:
        'Upload a local file (PDF/image/scan) into Paperless with metadata + custom fields. ' +
        '--data-scope and --custom-field use friendly names.',
    builder: (y) =>
        y
            .positional('file', { type: 'string', demandOption: true, describe: 'Path to the file' })
            .option('title', { type: 'string', describe: 'Document title' })
            .option('correspondent-id', { type: 'number', describe: 'Correspondent ID' })
            .option('correspondent-name', {
                type: 'string',
                describe: 'Correspondent by name (reused if it exists, else created)',
            })
            .option('document-type-id', { type: 'number', describe: 'Document type ID' })
            .option('tags', { type: 'string', describe: 'Comma-separated tag IDs to attach' })
            .option('tag-names', {
                type: 'string',
                describe: 'Comma-separated tag names (each reused if it exists, else created)',
            })
            .option('created', { type: 'string', describe: 'Document date YYYY-MM-DD' })
            .option('data-scope', { type: 'string', describe: 'privat | geschäftlich | gemischt' })
            .option('custom-field', {
                type: 'array',
                describe: 'Extra custom field as name=value (repeatable, friendly names)',
            }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const file = pickArgv<string>(raw, 'file');
        const tagsCsv = pickArgv<string>(raw, 'tags');
        const tagIds = tagsCsv
            ? tagsCsv
                  .split(',')
                  .map((s) => Number(s.trim()))
                  .filter((n) => Number.isFinite(n))
            : undefined;
        const namesCsv = pickArgv<string>(raw, 'tagNames', 'tag-names');
        const tagNames = namesCsv
            ? namesCsv
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
            : undefined;
        const customFields: Record<string, unknown> = {};
        const dataScope = pickArgv<string>(raw, 'dataScope', 'data-scope');
        if (dataScope) customFields.data_scope = dataScope;
        const cfArgs = raw['custom-field'] ?? raw['customField'];
        if (Array.isArray(cfArgs)) {
            for (const pair of cfArgs) {
                const [key, ...rest] = String(pair).split('=');
                if (key && rest.length > 0) customFields[key.trim()] = rest.join('=');
            }
        }
        runAndExit(() =>
            paperlessUploadDocument({
                filePath: file as string,
                title: pickArgv<string>(raw, 'title'),
                correspondentId: pickArgv<number>(raw, 'correspondentId', 'correspondent-id'),
                correspondentName: pickArgv<string>(raw, 'correspondentName', 'correspondent-name'),
                documentTypeId: pickArgv<number>(raw, 'documentTypeId', 'document-type-id'),
                tagIds,
                tagNames,
                created: pickArgv<string>(raw, 'created'),
                customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
            }),
        );
    },
};

export const taskSubcommand: CommandModule = {
    command: 'task <taskId>',
    describe: 'Get consumption task status by UUID (e.g. from document upload)',
    builder: (y) => y.positional('taskId', { type: 'string', demandOption: true }),
    handler: (argv) => {
        const taskId = (argv as unknown as { taskId: string }).taskId;
        runAndExit(() => paperlessTask(taskId));
    },
};

export const zuordnungSubcommand: CommandModule = {
    command: 'zuordnung <id>',
    describe:
        'Which Paperless rule (correspondent, document type, tags) most likely assigned the values of a document — Paperless does not record it, so this re-runs the rules against the text',
    builder: (y) => y.positional('id', { type: 'number', demandOption: true }),
    handler: (argv) => {
        runAndExit(() => paperlessZuordnung((argv as unknown as { id: number }).id), {
            print: (z) => {
                console.log(z.kopf);
                for (const e of z.eintraege) console.log(`  · ${e.satz}`);
            },
        });
    },
};
