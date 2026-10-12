import { describe, it, expect } from '@gjsify/unit';
import type { DmsDocument, DmsProvider } from '@steuererklaerung/dms';
import type { ElectronicStatement } from 'lib-fints';
import {
    findGaps,
    fintsStatements,
    parseStatementTitle,
    statementTitle,
    type FetchedAccount,
} from '../../../src/core/actions/fints-statements.ts';
import { assertStatementSupport } from '../../../src/core/clients/fints/client.ts';

function doc(id: string, title: string): DmsDocument {
    return {
        id,
        dms: 'paperless',
        title,
        correspondent: null,
        documentType: 'Kontoauszug',
        direction: 'incoming',
        created: '2026-01-01',
        added: '2026-01-01',
        tags: [],
        invoiceNumber: null,
        net: null,
        gross: null,
        vat: null,
        linkedTxIds: [],
        mimeType: null,
        pageCount: null,
        ocrText: null,
        ocrSource: null,
        aiNote: null,
        paymentStatus: 'offen',
    };
}

/** Synthetic HIEKA payload: no real bank data. */
function stmt(year: number | undefined, number: number | undefined): ElectronicStatement {
    return {
        format: '3',
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-01-31T00:00:00Z'),
        date: new Date('2026-02-01T00:00:00Z'),
        year,
        number,
        document: new Uint8Array([1, 2, 3]),
    } as unknown as ElectronicStatement;
}

function fetched(statements: ElectronicStatement[], over: Partial<FetchedAccount> = {}): FetchedAccount[] {
    return [{ account: 'testbank', accountNumber: '1234567', bankName: 'Testbank', statements, ...over }];
}

function setup(existing: string[], vocab: Record<string, string[]>, duplicate = false) {
    const ingested: string[] = [];
    const provider = {
        kind: 'paperless',
        listByDocumentType: async () => existing.map((t, i) => doc(String(i), t)),
        listVocabulary: async (kind: string) => (vocab[kind] ?? []).map((name, i) => ({ id: String(i), name })),
        ingest: async (input: { title: string }) => {
            ingested.push(input.title);
            return { document: doc('new', input.title), created: !duplicate };
        },
    } as unknown as DmsProvider;
    return { provider, ingested };
}

const fullVocab = { documentType: ['Kontoauszug'], tag: ['Neu'], correspondent: ['Testbank'] };

export default async () => {
    await describe('fints-statements', async () => {
        await it('round-trips the statement title', async () => {
            const key = { account: 'my bank', accountNumber: '1234567', year: 2026, number: 7 };
            const title = statementTitle(key);
            expect(title).toBe('Kontoauszug my bank 1234567 2026/007');
            expect(parseStatementTitle(title)?.number).toBe(7);
            expect(parseStatementTitle(title)?.account).toBe('my bank');
            expect(parseStatementTitle('Rechnung 1')).toBe(null);
        });

        await it('finds gaps per account and year', async () => {
            const t = (n: number) => statementTitle({ account: 'a', accountNumber: '1', year: 2026, number: n });
            const gaps = findGaps([t(1), t(2), t(5), null, 'other']);
            expect(gaps.length).toBe(1);
            expect(gaps[0].missing.join(',')).toBe('3,4');
        });

        await it('dry run plans uploads and writes nothing', async () => {
            const { provider, ingested } = setup([], fullVocab);
            const res = await fintsStatements(
                { entityId: 'e' },
                { provider, fetch: async () => fetched([stmt(2026, 1)]) },
            );
            expect(res.dryRun).toBe(true);
            expect(res.toUpload).toBe(1);
            expect(ingested.length).toBe(0);
        });

        await it('apply uploads only statements the DMS lacks', async () => {
            const have = statementTitle({ account: 'testbank', accountNumber: '1234567', year: 2026, number: 1 });
            const { provider, ingested } = setup([have], fullVocab);
            const res = await fintsStatements(
                { entityId: 'e', apply: true },
                { provider, fetch: async () => fetched([stmt(2026, 1), stmt(2026, 2)]) },
            );
            expect(ingested.length).toBe(1);
            expect(res.applied).toBe(1);
            expect(res.entries[0].decision).toBe('exists');
        });

        await it('treats a duplicate checksum as already there', async () => {
            const { provider } = setup([], fullVocab, true);
            const res = await fintsStatements(
                { entityId: 'e', apply: true },
                { provider, fetch: async () => fetched([stmt(2026, 3)]) },
            );
            expect(res.entries[0].decision).toBe('exists');
            expect(res.applied).toBe(0);
        });

        await it('reports statements without a number', async () => {
            const { provider, ingested } = setup([], fullVocab);
            const res = await fintsStatements(
                { entityId: 'e', apply: true },
                { provider, fetch: async () => fetched([stmt(undefined, undefined)]) },
            );
            expect(res.entries[0].decision).toBe('no-number');
            expect(ingested.length).toBe(0);
        });

        await it('notes a missing correspondent and tag instead of creating them', async () => {
            const { provider } = setup([], { documentType: ['Kontoauszug'] });
            const res = await fintsStatements(
                { entityId: 'e', apply: true },
                { provider, fetch: async () => fetched([stmt(2026, 1)]) },
            );
            expect(res.notes.length).toBe(2);
            expect(res.applied).toBe(1);
        });

        await it('fails when the document type is missing', async () => {
            const { provider } = setup([], {});
            let message = '';
            try {
                await fintsStatements(
                    { entityId: 'e', apply: true },
                    { provider, fetch: async () => fetched([stmt(2026, 1)]) },
                );
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message.includes('Kontoauszug')).toBe(true);
        });

        await it('rejects --acknowledge', async () => {
            const { provider } = setup([], fullVocab);
            let failed = false;
            try {
                await fintsStatements({ entityId: 'e', acknowledge: true }, { provider, fetch: async () => [] });
            } catch {
                failed = true;
            }
            expect(failed).toBe(true);
        });

        await it('assertStatementSupport fails without HIEKAS or PDF', async () => {
            const msg = (fn: () => unknown) => {
                try {
                    fn();
                } catch (err) {
                    return (err as Error).message;
                }
                return '';
            };
            expect(msg(() => assertStatementSupport(false, undefined)).includes('HIEKAS')).toBe(true);
            const noPdf = { indexAllowed: false, receiptRequired: false, supportedFormats: ['1'] };
            expect(msg(() => assertStatementSupport(true, noPdf as never)).includes('PDF')).toBe(true);
            const ok = { indexAllowed: false, receiptRequired: false, supportedFormats: ['3'] };
            expect(assertStatementSupport(true, ok as never)).toBe(ok as never);
        });
    });
};
