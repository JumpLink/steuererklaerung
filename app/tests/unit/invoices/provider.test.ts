import { describe, it, expect } from '@gjsify/unit';
import {
    commonInvoiceProblems,
    type CreateInvoiceInput,
    makeOutgoingInvoiceProvider,
    MAX_QONTO_ITEM_TITLE_LENGTH,
    QontoOutgoingInvoiceProvider,
} from '../../../src/core/invoices/provider.ts';

function baseInput(over: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput {
    return {
        issueDate: '2026-06-12',
        dueDate: '2026-06-27',
        currency: 'EUR',
        iban: 'DE13370400440532013010',
        clientId: 'client-1',
        items: [{ title: 'Beratung', quantity: 2, unit: 'Std', unit_price: 100, vat_rate: 19 }],
        ...over,
    };
}

export default async () => {
    await describe('makeOutgoingInvoiceProvider', async () => {
        await it('selects the back-end by config type', async () => {
            expect(makeOutgoingInvoiceProvider({ type: 'qonto' }).type).toBe('qonto');
            expect(makeOutgoingInvoiceProvider({ type: 'self' }).type).toBe('self');
        });
    });

    await describe('commonInvoiceProblems', async () => {
        await it('passes a well-formed input', async () => {
            expect(commonInvoiceProblems(baseInput())).toStrictEqual([]);
        });

        await it('flags missing dates/currency and an empty item list', async () => {
            const problems = commonInvoiceProblems(baseInput({ issueDate: '', currency: '', items: [] }));
            expect(problems.length).toBeGreaterThan(0);
            expect(problems.some((p) => p.includes('issueDate'))).toBe(true);
            expect(problems.some((p) => p.includes('Position'))).toBe(false); // no items → no per-item rows
        });

        await it('flags a missing title, non-positive quantity and unparseable price/VAT', async () => {
            const problems = commonInvoiceProblems(
                baseInput({ items: [{ title: '  ', quantity: 0, unit_price: 'abc', vat_rate: 'xx' }] }),
            );
            expect(problems.some((p) => p.includes('Titel fehlt'))).toBe(true);
            expect(problems.some((p) => p.includes('Menge'))).toBe(true);
            expect(problems.some((p) => p.includes('Einzelpreis'))).toBe(true);
            expect(problems.some((p) => p.includes('USt-Satz'))).toBe(true);
        });
    });

    await describe('QontoOutgoingInvoiceProvider.validate', async () => {
        const provider = new QontoOutgoingInvoiceProvider();

        await it('accepts a valid content input (clientId is NOT a content concern)', async () => {
            expect(provider.validate(baseInput({ clientId: undefined }))).toStrictEqual([]);
        });

        await it('flags a missing IBAN', async () => {
            const problems = provider.validate(baseInput({ iban: '' }));
            expect(problems.some((p) => p.includes('IBAN'))).toBe(true);
        });

        await it(`flags a line-item title longer than ${MAX_QONTO_ITEM_TITLE_LENGTH} chars`, async () => {
            const problems = provider.validate(
                baseInput({ items: [{ title: 'x'.repeat(41), quantity: 1, unit_price: 1, vat_rate: 19 }] }),
            );
            expect(problems.some((p) => p.includes('Qonto-Limit'))).toBe(true);
        });
    });

    await describe('provider capabilities', async () => {
        await it('exposes Qonto capabilities (hosted PDF, no form create/edit/finalize/markPaid/storno)', async () => {
            const caps = new QontoOutgoingInvoiceProvider().capabilities;
            expect(caps.pdf).toBe('hosted');
            // The interactive form + edit are Qonto-incompatible → must be false so the UIs hide them.
            expect(caps.createDraft).toBe(false);
            expect(caps.editDraft).toBe(false);
            expect(caps.finalize).toBe(false);
            expect(caps.markPaid).toBe(false);
            expect(caps.cancelStorno).toBe(false);
        });

        await it('exposes self capabilities (local PDF + XML, full lifecycle)', async () => {
            const caps = makeOutgoingInvoiceProvider({ type: 'self' }).capabilities;
            expect(caps.pdf).toBe('local');
            expect(caps.xml).toBe(true);
            expect(caps.finalize).toBe(true);
            expect(caps.cancelStorno).toBe(true);
        });
    });

    await describe('self guard provider (no entity id)', async () => {
        const provider = makeOutgoingInvoiceProvider({ type: 'self' }); // no ctx.entityId

        await it('validates content but rejects createDraft with a clear error', async () => {
            expect(provider.validate(baseInput())).toStrictEqual([]);
            let msg = '';
            try {
                await provider.createDraft(baseInput());
            } catch (e) {
                msg = e instanceof Error ? e.message : String(e);
            }
            expect(msg.includes('Entität')).toBe(true);
        });
    });
};
