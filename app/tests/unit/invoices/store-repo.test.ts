import { describe, it, expect } from '@gjsify/unit';
import {
    openLedger,
    migrate,
    lockPeriod,
    createInvoiceDraft,
    updateInvoiceDraft,
    deleteInvoiceDraft,
    finalizeInvoice,
    markInvoicePaid,
    createStornoInvoice,
    setArchivedDocuments,
    listInvoices,
    getInvoiceEvents,
    type InvoiceDraftInput,
    type InvoiceIssuerSnapshot,
    type InvoiceRecipient,
    type LedgerDatabase,
} from '@steuererklaerung/store';

const AT = '2026-03-01T10:00:00Z';

const issuer: InvoiceIssuerSnapshot = {
    name: 'Beispiel Aussteller',
    address: 'Musterweg 1',
    zip: '12345',
    city: 'Musterstadt',
    taxNumber: '12/345/67890',
    bank: { iban: 'DE02120300000000202051' },
};
const recipient: InvoiceRecipient = {
    name: 'Beispiel GmbH',
    address: 'Kundenstr. 2',
    zip: '54321',
    city: 'Kundenstadt',
};

function draft(over: Partial<InvoiceDraftInput> = {}): InvoiceDraftInput {
    return {
        entityId: 'gbr',
        issueDate: '2026-03-01',
        dueDate: '2026-03-15',
        performanceStart: '2026-02-01',
        performanceEnd: '2026-02-28',
        recipient,
        items: [{ title: 'Beratung', quantity: 2, unit: 'Std', unitPriceNet: 100, vatRate: 0.19 }],
        ...over,
    };
}

function fresh(): LedgerDatabase {
    const db = openLedger(':memory:');
    migrate(db);
    return db;
}

const ctx = { issuer, recipient, prefix: 'RE-', at: AT };

export default async () => {
    await describe('invoice repo', async () => {
        await it('creates a draft with no number and computed totals', async () => {
            const db = fresh();
            const inv = createInvoiceDraft(db, draft(), AT);
            expect(inv.status).toBe('draft');
            expect(inv.number).toBe(null);
            expect(inv.totals.gross).toBe(238);
            expect(getInvoiceEvents(db, inv.id).map((e) => e.action)).toStrictEqual(['created']);
            db.close();
        });

        await it('edits a draft but refuses to edit a finalized invoice', async () => {
            const db = fresh();
            const inv = createInvoiceDraft(db, draft(), AT);
            const edited = updateInvoiceDraft(
                db,
                inv.id,
                draft({ items: [{ title: 'X', quantity: 1, unitPriceNet: 50, vatRate: 0.19 }] }),
                AT,
            );
            expect(edited.totals.gross).toBe(59.5);
            finalizeInvoice(db, inv.id, ctx);
            expect(() => updateInvoiceDraft(db, inv.id, draft(), AT)).toThrow();
            expect(() => deleteInvoiceDraft(db, inv.id, AT)).toThrow();
            db.close();
        });

        await it('finalize assigns a number, freezes totals, and is gap-free per year', async () => {
            const db = fresh();
            const a = finalizeInvoice(db, createInvoiceDraft(db, draft(), AT).id, ctx);
            const b = finalizeInvoice(db, createInvoiceDraft(db, draft(), AT).id, ctx);
            expect(a.number).toBe('RE-2026-0001');
            expect(b.number).toBe('RE-2026-0002');
            expect(a.status).toBe('open');
            expect(a.finalizedAt).toBe(AT);
            // A deleted draft between them leaves no gap (unnumbered).
            deleteInvoiceDraft(db, createInvoiceDraft(db, draft(), AT).id, AT);
            const c = finalizeInvoice(db, createInvoiceDraft(db, draft(), AT).id, ctx);
            expect(c.number).toBe('RE-2026-0003');
            db.close();
        });

        await it('refuses finalize without issuer tax identity', async () => {
            const db = fresh();
            const inv = createInvoiceDraft(db, draft(), AT);
            expect(() =>
                finalizeInvoice(db, inv.id, { ...ctx, issuer: { ...issuer, taxNumber: null, vatId: null } }),
            ).toThrow();
            db.close();
        });

        await it('marks an open invoice paid but not a draft', async () => {
            const db = fresh();
            const inv = createInvoiceDraft(db, draft(), AT);
            expect(() => markInvoicePaid(db, inv.id, { paidAt: '2026-03-20', txId: 'qonto:tx1' }, AT)).toThrow();
            finalizeInvoice(db, inv.id, ctx);
            const paid = markInvoicePaid(db, inv.id, { paidAt: '2026-03-20', txId: 'qonto:tx1' }, AT);
            expect(paid.status).toBe('paid');
            expect(paid.paidTxId).toBe('qonto:tx1');
            db.close();
        });

        await it('storno negates the invoice, gets its own number, and cancels the original', async () => {
            const db = fresh();
            const inv = finalizeInvoice(db, createInvoiceDraft(db, draft(), AT).id, ctx);
            const { storno, original } = createStornoInvoice(db, inv.id, { ...ctx, reason: 'Testwiderruf' });
            expect(storno.kind).toBe('storno');
            expect(storno.number).toBe('RE-2026-0002');
            expect(storno.totals.gross).toBe(-238);
            expect(storno.stornoOfId).toBe(inv.id);
            expect(original.status).toBe('cancelled');
            expect(original.cancelledById).toBe(storno.id);
            // A second storno is refused.
            expect(() => createStornoInvoice(db, inv.id, ctx)).toThrow();
            db.close();
        });

        await it('storno totals are the EXACT inverse of the original (round-half asymmetry)', async () => {
            const db = fresh();
            // net 2.50 @ 19% → vat round(47.5)=0.48. Recomputing from negated qty would give
            // round(-47.5)=-0.47; negating the frozen total must give exactly -0.48.
            const inv = finalizeInvoice(
                db,
                createInvoiceDraft(
                    db,
                    draft({ items: [{ title: 'X', quantity: 1, unitPriceNet: 2.5, vatRate: 0.19 }] }),
                    AT,
                ).id,
                ctx,
            );
            expect(inv.totals.vat).toBe(0.48);
            const { storno } = createStornoInvoice(db, inv.id, ctx);
            expect(storno.totals.vat).toBe(-0.48);
            expect(storno.totals.net).toBe(-inv.totals.net);
            expect(storno.totals.gross).toBe(-inv.totals.gross);
            db.close();
        });

        await it('refuses mutations in a GoBD-locked period', async () => {
            const db = fresh();
            const inv = createInvoiceDraft(db, draft(), AT);
            // periods.entity_id FKs entities(id); seed the ledger entity, then lock 2026.
            db.prepare(`INSERT INTO entities(id, name) VALUES('artcode', 'Muster & Partner GbR')`).run();
            lockPeriod(db, 'artcode', 2026, AT); // gbr → ledger 'artcode'
            expect(() => finalizeInvoice(db, inv.id, ctx)).toThrow();
            db.close();
        });

        await it('archive-once: records refs then refuses to overwrite the PDF ref', async () => {
            const db = fresh();
            const inv = finalizeInvoice(db, createInvoiceDraft(db, draft(), AT).id, ctx);
            const archived = setArchivedDocuments(
                db,
                inv.id,
                { dms: 'builtin', pdfDocumentId: 'doc-1', xmlDocumentId: 'doc-2' },
                AT,
            );
            expect(archived.archive.pdfDocumentId).toBe('doc-1');
            expect(() => setArchivedDocuments(db, inv.id, { dms: 'builtin', pdfDocumentId: 'doc-9' }, AT)).toThrow();
            // Re-setting the SAME ref is fine (idempotent re-run).
            expect(() =>
                setArchivedDocuments(db, inv.id, { dms: 'builtin', pdfDocumentId: 'doc-1' }, AT),
            ).not.toThrow();
            db.close();
        });

        await it('lists newest-first and filters by status', async () => {
            const db = fresh();
            const open = finalizeInvoice(db, createInvoiceDraft(db, draft({ issueDate: '2026-01-01' }), AT).id, ctx);
            createInvoiceDraft(db, draft({ issueDate: '2026-05-01' }), AT);
            const all = listInvoices(db, 'gbr');
            expect(all.length).toBe(2);
            expect(all[0].issueDate).toBe('2026-05-01'); // newest first
            const onlyOpen = listInvoices(db, 'gbr', { status: 'open' });
            expect(onlyOpen.length).toBe(1);
            expect(onlyOpen[0].id).toBe(open.id);
            db.close();
        });

        await it('appends an event per lifecycle step', async () => {
            const db = fresh();
            const inv = createInvoiceDraft(db, draft(), AT);
            finalizeInvoice(db, inv.id, ctx);
            markInvoicePaid(db, inv.id, { paidAt: '2026-03-20' }, AT);
            expect(getInvoiceEvents(db, inv.id).map((e) => e.action)).toStrictEqual(['created', 'finalized', 'paid']);
            db.close();
        });
    });
};
