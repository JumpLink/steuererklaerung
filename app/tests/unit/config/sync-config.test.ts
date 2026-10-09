import { describe, it, expect, afterEach } from '@gjsify/unit';
import { rmSync } from 'node:fs';
import { loadPaperlessConfig } from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

/**
 * The former standalone sync-config loader is gone; the Paperless config now lives in the manifest's
 * `paperless` section and is read via loadPaperlessConfig (strict by default = positive doc-type ids).
 */
export default async () => {
    await describe('loadPaperlessConfig', async () => {
        const dirs: string[] = [];
        afterEach(() => {
            for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
        });

        /** Write a manifest whose `paperless` section is `data` (undefined ⇒ no paperless section). */
        function fixture(data: object | undefined): string {
            const { dir, path } = writeManifestFixture({
                entities: [{ id: 'gbr', kind: 'gbr' }],
                ...(data === undefined ? {} : { paperless: data }),
            });
            dirs.push(dir);
            return path;
        }

        await it('loads a valid strict config', async () => {
            const path = fixture({
                document_type_ids: { incoming_invoice: 1, outgoing_invoice: 2 },
                custom_field_ids: { invoice_number: 10 },
                tag_ids: { ai_reviewed: 5 },
            });
            const config = loadPaperlessConfig(undefined, path);
            expect(config.document_type_ids.incoming_invoice).toBe(1);
            expect(config.document_type_ids.outgoing_invoice).toBe(2);
            expect(config.custom_field_ids.invoice_number).toBe(10);
            expect(config.custom_field_ids.qonto_transaction_id).toBe(0); // defaulted
            expect(config.tag_ids.ai_reviewed).toBe(5);
            expect(config.tag_ids.qonto_import).toBe(0); // defaulted
            expect(config.preferred_language).toBe('de'); // defaulted
            expect(config.exclude_tag_ids.join(',')).toBe(''); // defaulted to []
        });

        await it('parses exclude_tag_ids (out-of-scope "* Privat" tags)', async () => {
            const path = fixture({
                document_type_ids: { incoming_invoice: 1, outgoing_invoice: 2 },
                exclude_tag_ids: [15, 17, 23],
            });
            expect(loadPaperlessConfig(undefined, path).exclude_tag_ids.join(',')).toBe('15,17,23');
        });

        await it('rejects zero document_type_ids in strict mode', async () => {
            const path = fixture({ document_type_ids: { incoming_invoice: 0, outgoing_invoice: 0 } });
            expect(() => loadPaperlessConfig(undefined, path)).toThrow(/Paperless-Abschnitt|Invalid|Ungültig/);
        });

        await it('allows zero document_type_ids in lenient mode', async () => {
            const path = fixture({});
            const config = loadPaperlessConfig({ strict: false }, path);
            expect(config.document_type_ids.incoming_invoice).toBe(0);
            expect(config.document_type_ids.outgoing_invoice).toBe(0);
        });

        await it('parses own_correspondent_ids', async () => {
            const path = fixture({
                document_type_ids: { incoming_invoice: 1, outgoing_invoice: 2 },
                own_correspondent_ids: [10, 20],
            });
            expect(loadPaperlessConfig(undefined, path).own_correspondent_ids).toStrictEqual([10, 20]);
        });

        await it('parses preferred_language', async () => {
            const path = fixture({
                document_type_ids: { incoming_invoice: 1, outgoing_invoice: 2 },
                preferred_language: 'en',
            });
            expect(loadPaperlessConfig(undefined, path).preferred_language).toBe('en');
        });

        await it('throws when the manifest has no paperless section', async () => {
            const path = fixture(undefined);
            expect(() => loadPaperlessConfig({ strict: false }, path)).toThrow(/paperless/);
        });
    });
};
