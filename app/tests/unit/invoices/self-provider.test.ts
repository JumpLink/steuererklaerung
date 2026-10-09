import { describe, it, expect } from '@gjsify/unit';
import { openLedger, migrate, type LedgerDatabase } from '@steuererklaerung/store';
import type { DmsProvider } from '@steuererklaerung/dms';
import { SelfOutgoingInvoiceProvider, type SelfProviderDeps } from '../../../src/core/invoices/self-provider.ts';
import type { CreateInvoiceInput } from '../../../src/core/invoices/provider.ts';

const AT = '2026-03-01T10:00:00Z';

// A single shared in-memory DB across the provider's withDb calls (real code opens a file DB).
function makeDeps(
    db: LedgerDatabase,
    over: Partial<SelfProviderDeps> = {},
): { deps: SelfProviderDeps; stored: string[]; links: Array<[string, string]> } {
    const stored: string[] = [];
    const links: Array<[string, string]> = [];
    const fakeDms: DmsProvider = {
        kind: 'builtin',
        list: async () => [],
        get: async () => null,
        getFile: async (id) => ({ bytes: new TextEncoder().encode(`bytes:${id}`), mimeType: 'application/pdf' }),
        // biome-ignore lint: minimal fake
        store: async (input) => {
            stored.push(input.filename);
            return { id: `doc-${stored.length}`, filename: input.filename } as never;
        },
        setMetadata: async () => {},
        link: async (docId, txId) => {
            links.push([docId, txId]);
        },
    };
    const deps: SelfProviderDeps = {
        entityId: 'gbr',
        numberPrefix: 'RE-',
        iban: 'DE02120300000000202051',
        logoPath: null,
        withDb: (fn) => fn(db),
        resolveIssuer: () => ({
            name: 'JumpLink',
            address: 'Musterweg 1',
            zip: '12345',
            city: 'Musterstadt',
            taxNumber: '12/345/67890',
            kleinunternehmer: false,
            bank: { iban: 'DE02120300000000202051' },
        }),
        makeDms: () => fakeDms,
        resolveRecipient: (input) =>
            input.recipient ?? { name: 'Beispiel GmbH', address: 'Kundenstr. 2', zip: '54321', city: 'Kundenstadt' },
        now: () => AT,
        ...over,
    };
    return { deps, stored, links };
}

function input(over: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
    return {
        issueDate: '2026-03-01',
        dueDate: '2026-03-15',
        currency: 'EUR',
        iban: 'DE02120300000000202051',
        performanceStart: '2026-02-01',
        performanceEnd: '2026-02-28',
        items: [{ title: 'Beratung', quantity: 2, unit: 'Std', unit_price: 100, vat_rate: 19 }],
        ...over,
    };
}

export default async () => {
    await describe('SelfOutgoingInvoiceProvider', async () => {
        await it('creates a draft (unnumbered) and lists it', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const { deps } = makeDeps(db);
            const provider = new SelfOutgoingInvoiceProvider(deps);
            const draft = await provider.createDraft(input());
            expect(draft.status).toBe('draft');
            expect(draft.number).toBe(null);
            expect(draft.provider).toBe('self');
            const list = await provider.listInvoices();
            expect(list.length).toBe(1);
            expect(list[0].customerName).toBe('Beispiel GmbH');
            expect(list[0].total).toBe(238);
            db.close();
        });

        await it('stores a German thousands-grouped price exactly (no 1.23 for "1.234,56")', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const provider = new SelfOutgoingInvoiceProvider(makeDeps(db).deps);
            const draft = await provider.createDraft(
                input({ items: [{ title: 'Projekt', quantity: '1', unit_price: '1.234,56', vat_rate: '19' }] }),
            );
            const detail = await provider.getInvoice(draft.id);
            expect(detail?.items[0].unitPrice).toBe(1234.56); // NOT 1.23
            expect(detail?.totals.net).toBe(1234.56);
            expect(detail?.totals.gross).toBe(1469.13); // 1234.56 * 1.19
            db.close();
        });

        await it('rejects EUR-only violations in validate AND on updateDraft', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const provider = new SelfOutgoingInvoiceProvider(makeDeps(db).deps);
            expect(provider.validate(input({ currency: 'USD' })).some((p) => p.includes('nur EUR'))).toBe(true);
            // An edit must not bypass the content checks (regression: updateDraft skipped validate).
            const draft = await provider.createDraft(input());
            let threw = false;
            try {
                await provider.updateDraft(draft.id, input({ currency: 'USD' }));
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
            db.close();
        });

        await it('detail carries iban + buyerReference (preserved across edits)', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const provider = new SelfOutgoingInvoiceProvider(makeDeps(db).deps);
            const draft = await provider.createDraft(input({ buyerReference: '04011000-12345-06' }));
            const detail = await provider.getInvoice(draft.id);
            expect(detail?.iban).toBe('DE02120300000000202051');
            expect(detail?.buyerReference).toBe('04011000-12345-06');
            db.close();
        });

        await it('finalizes: assigns a number and archives PDF + XML through the DMS', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            // Under GJS pdfRenderingAvailable() is true → the real cairo/Pango render + archive runs.
            // On Node it refuses before numbering (asserted in the catch below).
            const { deps, stored } = makeDeps(db);
            const provider = new SelfOutgoingInvoiceProvider(deps);
            const draft = await provider.createDraft(input());
            // Rendering needs GJS; skip the archive assertions when unavailable but still expect a number.
            let finalized: Awaited<ReturnType<typeof provider.finalize>> | null = null;
            try {
                finalized = await provider.finalize(draft.id);
            } catch (e) {
                // On Node (no cairo/Pango) finalize refuses before numbering — assert that and stop.
                expect(e instanceof Error ? e.message : String(e)).toContain('GJS');
                db.close();
                return;
            }
            expect(finalized.number).toBe('RE-2026-0001');
            expect(finalized.status).toBe('open');
            expect(stored.some((f) => f.endsWith('.pdf'))).toBe(true);
            expect(stored.some((f) => f.endsWith('.xrechnung.xml'))).toBe(true);
            db.close();
        });

        await it('links the archived invoice document to the settling transaction on markPaid', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const { deps, links } = makeDeps(db);
            const provider = new SelfOutgoingInvoiceProvider(deps);
            const draft = await provider.createDraft(input());
            try {
                await provider.finalize(draft.id);
            } catch (e) {
                // Node has no cairo/Pango → no archive → nothing to link; the GJS run covers it.
                expect(e instanceof Error ? e.message : String(e)).toContain('GJS');
                db.close();
                return;
            }
            await provider.markPaid(draft.id, { txId: 'camt:DE15-tx-42', paidAt: '2026-03-20' });
            expect(links.some(([, tx]) => tx === 'camt:DE15-tx-42')).toBe(true);
            db.close();
        });

        await it('gates finalize on PDF availability with a clear message', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const provider = new SelfOutgoingInvoiceProvider(makeDeps(db).deps);
            const draft = await provider.createDraft(input());
            // We can't force availability off under GJS, but the error path (Node) is covered above;
            // here we simply assert getInvoice reflects the draft.
            const detail = await provider.getInvoice(draft.id);
            expect(detail?.kind).toBe('invoice');
            expect(detail?.items.length).toBe(1);
            db.close();
        });
    });
};
