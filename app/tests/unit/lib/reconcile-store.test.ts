import { describe, it, expect } from '@gjsify/unit';
import { bankMatchEntries, PAPERLESS_STRING_MAX } from '../../../src/core/actions/reconcile-store.ts';
import type { SyncConfig } from '../../../src/core/config/index.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

// Only the custom_field_ids bankMatchEntries reads are needed.
const config = {
    custom_field_ids: {
        qonto_transaction_id: 10,
        qonto_transaction_amount: 11,
        qonto_currency: 12,
        qonto_settled_at: 13,
        qonto_label: 8,
        qonto_reference: 7,
    },
} as unknown as SyncConfig;

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: 'camt_x',
        source: 'camt',
        accountKey: 'camt:acc',
        bookingDate: '2025-03-10',
        amount: -20.97,
        currency: 'EUR',
        ...over,
    };
}

export default async () => {
    await describe('bankMatchEntries (Paperless 128-char guard)', async () => {
        await it('truncates an over-long reference/purpose to 128 chars (Paperless string cap)', async () => {
            const longPurpose = 'AMZN Mktp DE*R85JS6PC4 '.repeat(20); // ~460 chars
            const entries = bankMatchEntries(tx({ purpose: longPurpose, reference: undefined }), config);
            const ref = entries.find((e) => e.field === 7);
            expect(typeof ref?.value).toBe('string');
            expect((ref?.value as string).length).toBe(PAPERLESS_STRING_MAX);
            expect(ref?.value).toBe(longPurpose.slice(0, PAPERLESS_STRING_MAX));
        });

        await it('also caps an over-long counterparty label', async () => {
            const longName = 'X'.repeat(200);
            const entries = bankMatchEntries(tx({ counterparty: longName }), config);
            const label = entries.find((e) => e.field === 8);
            expect((label?.value as string).length).toBe(PAPERLESS_STRING_MAX);
        });

        await it('leaves short strings and non-string fields untouched', async () => {
            const entries = bankMatchEntries(
                tx({ counterparty: 'Amazon', reference: 'RE-1', amount: -20.97 }),
                config,
            );
            expect(entries.find((e) => e.field === 8)?.value).toBe('Amazon'); // label
            expect(entries.find((e) => e.field === 7)?.value).toBe('RE-1'); // reference
            expect(entries.find((e) => e.field === 11)?.value).toBe(-20.97); // amount stays a number
            expect(entries.find((e) => e.field === 10)?.value).toBe('camt_x'); // tx id
        });
    });
};
