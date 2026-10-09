/**
 * Unit tests for the Paperless upload additions: the shared custom-field resolver
 * (friendly names → { field, value }, incl. select option-id coercion), the upload
 * content-type inference, and the new tags__id__in list filter.
 */

import { describe, it, expect, vi, afterEach } from '@gjsify/unit';
import { resolveCustomFieldEntries } from '../../../src/core/lib/custom-fields.ts';
import { contentTypeForFilename, listDocuments } from '@steuererklaerung/paperless';
import type { SyncConfig } from '../../../src/core/config/index.ts';

const fakeConfig = {
    custom_field_ids: { invoice_number: 11, data_scope: 42, ai_note: 43 },
    select_field_options: { data_scope: { privat: '7', geschäftlich: '8', gemischt: '9' } },
} as unknown as SyncConfig;

export default async () => {
    await describe('paperless upload helpers', async () => {
        await describe('resolveCustomFieldEntries', async () => {
            await it('maps friendly names to field ids and passes text values through', async () => {
                const entries = resolveCustomFieldEntries({ invoice_number: 'INV-1', ai_note: 'hi' }, fakeConfig);
                expect(JSON.stringify(entries)).toBe(
                    JSON.stringify([
                        { field: 11, value: 'INV-1' },
                        { field: 43, value: 'hi' },
                    ]),
                );
            });

            await it('resolves a select label to its numeric option id (data_scope=privat → 7)', async () => {
                const entries = resolveCustomFieldEntries({ data_scope: 'privat' }, fakeConfig);
                expect(JSON.stringify(entries)).toBe(JSON.stringify([{ field: 42, value: 7 }]));
            });

            await it('skips unknown or unconfigured fields', async () => {
                const entries = resolveCustomFieldEntries({ nope: 'x', data_scope: 'privat' }, fakeConfig);
                expect(entries.length).toBe(1);
            });

            await it('caps over-long text custom fields at 128 chars (Paperless limit, e.g. ai_note)', async () => {
                const entries = resolveCustomFieldEntries({ ai_note: 'x'.repeat(200) }, fakeConfig);
                expect(entries.length).toBe(1);
                expect((entries[0].value as string).length).toBe(128);
            });
        });

        await describe('contentTypeForFilename', async () => {
            await it('infers image + pdf types from the extension (case-insensitive)', async () => {
                expect(contentTypeForFilename('heizungsraum.jpg')).toBe('image/jpeg');
                expect(contentTypeForFilename('Scan.PDF')).toBe('application/pdf');
                expect(contentTypeForFilename('x.png')).toBe('image/png');
                expect(contentTypeForFilename('weird.xyz')).toBe('application/octet-stream');
            });

            await it('names the text formats instead of calling them binary', async () => {
                expect(contentTypeForFilename('nachweis.txt')).toBe('text/plain');
                expect(contentTypeForFilename('buchungen.csv')).toBe('text/csv');
                expect(contentTypeForFilename('notiz.md')).toBe('text/markdown');
            });

            await it('declares XML honestly, even though Paperless refuses it', async () => {
                // Not text/plain: the server sniffs the CONTENT with libmagic and ignores this
                // header, so a false claim would not smuggle the file in — it would only make
                // the rejection ("File type text/xml not supported") harder to understand.
                expect(contentTypeForFilename('2025_AnlageEUER_Serverantwort.xml')).toBe('text/xml');
            });
        });

        await describe('listDocuments tag filter', async () => {
            afterEach(() => vi.unstubAllGlobals());

            await it('sends tags__id__in as a comma-joined id list', async () => {
                let captured = '';
                vi.stubGlobal(
                    'fetch',
                    vi.fn(async (url: string) => {
                        captured = String(url);
                        return { ok: true, status: 200, text: async () => JSON.stringify({ count: 0, results: [] }) };
                    }),
                );
                await listDocuments({ tag_ids: [19, 4] }, { baseUrl: 'https://pl.test', headers: {} });
                expect(captured.includes('tags__id__in=19%2C4') || captured.includes('tags__id__in=19,4')).toBe(true);
            });

            await it('omits tags__id__in when no tag ids are given', async () => {
                let captured = '';
                vi.stubGlobal(
                    'fetch',
                    vi.fn(async (url: string) => {
                        captured = String(url);
                        return { ok: true, status: 200, text: async () => JSON.stringify({ count: 0, results: [] }) };
                    }),
                );
                await listDocuments({ tag_ids: [] }, { baseUrl: 'https://pl.test', headers: {} });
                expect(captured.includes('tags__id__in')).toBe(false);
            });
        });
    });
};
