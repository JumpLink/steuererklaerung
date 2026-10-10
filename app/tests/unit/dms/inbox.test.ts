import { describe, it, expect, beforeEach, afterEach, vi } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuiltinDmsProvider, PaperlessDmsProvider } from '@steuererklaerung/dms';
import type { DmsDocument, DmsProvider, PaperlessFieldConfig } from '@steuererklaerung/dms';
import {
    applyMetadata,
    getDocumentWithText,
    listInbox,
    proposeMetadata,
    setPaymentStatus,
} from '../../../src/core/actions/dms/inbox.ts';

function doc(over: Partial<DmsDocument> = {}): DmsDocument {
    return {
        id: '1',
        dms: 'builtin',
        title: 'Scan 1',
        correspondent: null,
        documentType: null,
        direction: null,
        created: null,
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
        ...over,
    };
}

/** In-memory provider: records every write so tests can assert on it. */
function fakeProvider(kind: 'builtin' | 'paperless', initial: DmsDocument) {
    const state = { doc: initial, inbox: true, writes: [] as Array<Partial<DmsDocument>> };
    const provider: DmsProvider = {
        kind,
        list: async () => [state.doc],
        get: async (id) => (id === state.doc.id ? state.doc : null),
        getFile: async () => null,
        listInbox: async () => (state.inbox ? [state.doc] : []),
        getText: async () => 'x'.repeat(7000),
        markReviewed: async () => {
            state.inbox = false;
        },
        setMetadata: async (_id, meta) => {
            state.writes.push(meta);
            state.doc = { ...state.doc, ...meta };
        },
    };
    return { provider, state };
}

const PL_CONFIG: PaperlessFieldConfig = {
    custom_field_ids: {
        qonto_settled_at: 1,
        invoice_date: 2,
        invoice_number: 3,
        qonto_transaction_id: 4,
        total_net: 5,
        total_gross: 6,
        tax_amount: 7,
        ai_note: 8,
        payment_status: 9,
        due_date: 10,
        amount_to_pay: 11,
    },
    tag_ids: { inbox: 70, ai_reviewed: 71 },
    select_field_options: { payment_status: { offen: 'opt-offen', bezahlt: 'opt-bezahlt' } },
    document_type_ids: { incoming_invoice: 1, outgoing_invoice: 2 },
};

interface Call {
    method: string;
    url: string;
    body: unknown;
}

/** Stubs global fetch with one Paperless document (id 5, in the inbox); returns the recorded calls. */
function stubPaperless(): Call[] {
    const calls: Call[] = [];
    const plDoc = {
        id: 5,
        title: 'Scan 5',
        correspondent: null,
        tags: [70, 3],
        created: '2026-02-02',
        added: '2026-02-03T10:00:00Z',
        content: 'Volltext',
        custom_fields: [{ field: 9, value: 'opt-offen' }],
    };
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
            const method = init?.method ?? 'GET';
            calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
            let payload: unknown = {};
            if (url.includes('/api/correspondents/')) payload = { count: 0, next: null, results: [] };
            else if (url.includes('tags__id__in')) payload = { count: 1, next: null, results: [plDoc] };
            else if (url.includes('/api/documents/5/')) payload = plDoc;
            return {
                ok: true,
                status: 200,
                statusText: '',
                headers: { get: () => null },
                text: async () => JSON.stringify(payload),
            };
        }),
    );
    return calls;
}

export default async () => {
    await describe('dms inbox actions', async () => {
        await describe('with a fake provider', async () => {
            await it('lists the inbox as compact summaries', async () => {
                const { provider } = fakeProvider('builtin', doc());
                const res = await listInbox(provider);
                expect(res.count).toBe(1);
                expect(res.dms).toBe('builtin');
                expect(res.documents[0].id).toBe('1');
            });

            await it('refuses a provider without an inbox', async () => {
                const { provider } = fakeProvider('builtin', doc());
                delete provider.listInbox;
                let threw = false;
                try {
                    await listInbox(provider);
                } catch {
                    threw = true;
                }
                expect(threw).toBe(true);
            });

            await it('truncates long document text', async () => {
                const { provider } = fakeProvider('builtin', doc());
                const res = await getDocumentWithText(provider, '1');
                expect(res.text?.length).toBe(6000);
                expect(res.textTruncated).toBe(true);
            });

            await it('proposes only the fields that differ and writes nothing', async () => {
                const { provider, state } = fakeProvider('builtin', doc({ title: 'Scan 1', gross: 10 }));
                const p = await proposeMetadata(
                    provider,
                    '1',
                    { title: 'Scan 1', gross: 12.5, invoiceNumber: 'R-1' },
                    { model: 'test-model', today: '2026-10-10' },
                );
                expect(p.changes.map((c) => c.field).join(',')).toBe('gross,invoiceNumber');
                expect(p.aiNote.length).toBeLessThan(200);
                expect(p.aiNote.includes('test-model')).toBe(true);
                expect(state.writes.length).toBe(0);
            });

            await it('rejects a malformed date and an empty title', async () => {
                const { provider } = fakeProvider('builtin', doc());
                for (const bad of [{ created: '10.10.2026' }, { title: '  ' }]) {
                    let threw = false;
                    try {
                        await proposeMetadata(provider, '1', bad, { model: 'm' });
                    } catch {
                        threw = true;
                    }
                    expect(threw).toBe(true);
                }
            });

            await it('applies a proposal with the KI-Hinweis and leaves the inbox', async () => {
                const { provider, state } = fakeProvider('builtin', doc());
                const res = await applyMetadata(provider, '1', { gross: 99, correspondent: 'ACME' }, { model: 'm' });
                expect([...res.applied].sort().join(',')).toBe('correspondent,gross');
                expect(res.markedReviewed).toBe(true);
                expect(state.writes[0].gross).toBe(99);
                expect(typeof state.writes[0].aiNote).toBe('string');
                expect((await listInbox(provider)).count).toBe(0);
            });

            await it('reports paperless-unwritable fields instead of writing them', async () => {
                const { provider, state } = fakeProvider('paperless', doc({ dms: 'paperless' }));
                const res = await applyMetadata(provider, '1', { correspondent: 'ACME', gross: 5 }, { model: 'm' });
                expect(res.notWritable.join(',')).toBe('correspondent');
                expect(res.applied.join(',')).toBe('gross');
                expect(state.writes[0].correspondent).toBe(undefined);
            });

            await it('sets the payment status and rejects unknown values', async () => {
                const { provider, state } = fakeProvider('builtin', doc());
                await setPaymentStatus(provider, '1', { status: 'bezahlt', dueDate: '2026-11-01', amountToPay: 12 });
                expect(state.doc.paymentStatus).toBe('bezahlt');
                expect(state.doc.dueDate).toBe('2026-11-01');
                let threw = false;
                try {
                    await setPaymentStatus(provider, '1', { status: 'vielleicht' as never });
                } catch {
                    threw = true;
                }
                expect(threw).toBe(true);
            });
        });

        await describe('BuiltinDmsProvider (temp store)', async () => {
            let dir = '';
            let prevDir: string | undefined;
            let prevLedger: string | undefined;
            beforeEach(async () => {
                prevDir = process.env.TRANSACTIONS_DATA_DIR;
                prevLedger = process.env.LEDGER_DB_PATH;
                dir = mkdtempSync(join(tmpdir(), 'bh-dms-inbox-'));
                process.env.TRANSACTIONS_DATA_DIR = dir;
                process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
            });
            afterEach(async () => {
                if (prevDir === undefined) delete process.env.TRANSACTIONS_DATA_DIR;
                else process.env.TRANSACTIONS_DATA_DIR = prevDir;
                if (prevLedger === undefined) delete process.env.LEDGER_DB_PATH;
                else process.env.LEDGER_DB_PATH = prevLedger;
                try {
                    rmSync(dir, { recursive: true, force: true });
                } catch {
                    /* best-effort */
                }
            });

            await it('a stored document is in the inbox until metadata is applied', async () => {
                const p = new BuiltinDmsProvider('jumplink');
                const stored = await p.store({
                    bytes: Buffer.from('inbox-1'),
                    filename: 'a.pdf',
                    mimeType: 'application/pdf',
                });
                expect((await p.listInbox()).map((d) => d.id).join(',')).toBe(stored.id);

                await applyMetadata(
                    p,
                    stored.id,
                    { gross: 10, invoiceNumber: 'R-9' },
                    { model: 'm', today: '2026-10-10' },
                );

                expect((await p.listInbox()).length).toBe(0);
                const got = await p.get(stored.id);
                expect(got?.gross).toBe(10);
                expect(typeof got?.aiNote).toBe('string');
            });

            await it('persists payment status, due date and amount to pay', async () => {
                const p = new BuiltinDmsProvider('jumplink');
                const stored = await p.store({
                    bytes: Buffer.from('inbox-2'),
                    filename: 'b.pdf',
                    mimeType: 'application/pdf',
                });
                await setPaymentStatus(p, stored.id, { status: 'offen', dueDate: '2026-12-01', amountToPay: 42.5 });
                const got = await p.get(stored.id);
                expect(got?.paymentStatus).toBe('offen');
                expect(got?.dueDate).toBe('2026-12-01');
                expect(got?.amountToPay).toBe(42.5);
            });
        });

        await describe('PaperlessDmsProvider (stubbed fetch)', async () => {
            afterEach(() => vi.unstubAllGlobals());
            const creds = { url: 'https://pl.test', token: 'token' };

            await it('the inbox is the documents carrying the inbox tag', async () => {
                const calls = stubPaperless();
                const p = new PaperlessDmsProvider(PL_CONFIG, creds);
                const docs = await p.listInbox();
                expect(docs.map((d) => d.id).join(',')).toBe('5');
                expect(docs[0].paymentStatus).toBe('offen');
                expect(calls.some((c) => c.url.includes('tags__id__in=70'))).toBe(true);
            });

            await it('an unconfigured inbox tag yields an empty inbox without a request', async () => {
                const calls = stubPaperless();
                const p = new PaperlessDmsProvider({ ...PL_CONFIG, tag_ids: undefined }, creds);
                expect((await p.listInbox()).length).toBe(0);
                expect(calls.length).toBe(0);
            });

            await it('marking reviewed swaps the inbox tag for the reviewed tag', async () => {
                const calls = stubPaperless();
                const p = new PaperlessDmsProvider(PL_CONFIG, creds);
                await p.markReviewed('5');
                const patchCall = calls.find((c) => c.method === 'PATCH');
                const tags = (patchCall?.body as { tags: number[] } | undefined)?.tags ?? [];
                expect(tags.join(',')).toBe('3,71');
            });

            await it('writes payment status as the select option id', async () => {
                const calls = stubPaperless();
                const p = new PaperlessDmsProvider(PL_CONFIG, creds);
                await p.setMetadata('5', { paymentStatus: 'bezahlt', dueDate: '2026-11-01' });
                const body = calls.find((c) => c.method === 'PATCH')?.body as {
                    custom_fields: Array<{ field: number; value: unknown }>;
                };
                expect(body.custom_fields.find((f) => f.field === 9)?.value).toBe('opt-bezahlt');
                expect(body.custom_fields.find((f) => f.field === 10)?.value).toBe('2026-11-01');
            });

            await it('refuses a payment status Paperless has no option for', async () => {
                stubPaperless();
                const p = new PaperlessDmsProvider(PL_CONFIG, creds);
                let threw = false;
                try {
                    await p.setMetadata('5', { paymentStatus: 'storniert' });
                } catch {
                    threw = true;
                }
                expect(threw).toBe(true);
            });
        });
    });
};
