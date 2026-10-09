import { describe, it, expect } from '@gjsify/unit';
import {
    normalizeInvoiceStatus,
    displayInvoiceStatus,
    INVOICE_STATUS_LABEL,
    INVOICE_STATUS_TONE,
} from '../../../src/core/invoices/status.ts';

export default async () => {
    await describe('invoice status', async () => {
        await it('normalizes both back-ends onto the shared lifecycle', async () => {
            expect(normalizeInvoiceStatus('unpaid')).toBe('open'); // Qonto
            expect(normalizeInvoiceStatus('open')).toBe('open'); // self
            expect(normalizeInvoiceStatus('canceled')).toBe('cancelled'); // Qonto spelling
            expect(normalizeInvoiceStatus('cancelled')).toBe('cancelled'); // self spelling
            expect(normalizeInvoiceStatus('paid')).toBe('paid');
            expect(normalizeInvoiceStatus('draft')).toBe('draft');
        });

        await it('derives overdue for an open invoice past its due date', async () => {
            expect(displayInvoiceStatus('open', '2026-06-01', '2026-07-01')).toBe('overdue');
            expect(displayInvoiceStatus('open', '2026-08-01', '2026-07-01')).toBe('open');
            expect(displayInvoiceStatus('paid', '2026-01-01', '2026-07-01')).toBe('paid'); // paid is never overdue
            expect(displayInvoiceStatus('open', null, '2026-07-01')).toBe('open');
        });

        await it('has a German label + tone for every display state', async () => {
            for (const s of ['draft', 'open', 'overdue', 'paid', 'cancelled'] as const) {
                expect(INVOICE_STATUS_LABEL[s].length).toBeGreaterThan(0);
                expect(INVOICE_STATUS_TONE[s]).toBeDefined();
            }
            expect(INVOICE_STATUS_TONE.overdue).toBe('error');
            expect(INVOICE_STATUS_LABEL.overdue).toBe('Überfällig');
        });
    });
};
