/**
 * Unit tests for custom-field value coercion (core/lib/custom-fields.ts).
 *
 * The CLI's `--custom-field name=value` parsing always yields strings, so a boolean field
 * carried "true" and a monetary field "57.60" — Paperless rejected the type mismatch with
 * HTTP 500. resolveCustomFieldEntries / coerceCustomFieldValue now cast each non-select value
 * to its Paperless data_type before building the entry. These tests use fictional field ids
 * and values only (no live Paperless).
 */

import { describe, it, expect } from '@gjsify/unit';
import {
    resolveCustomFieldEntries,
    coerceCustomFieldValue,
} from '../../../src/core/lib/custom-fields.ts';
import { parseMonetaryValue } from '@steuererklaerung/paperless';
import type { SyncConfig } from '../../../src/core/config/index.ts';

// Fictional field-id map covering one field of each relevant data_type + one select field.
const fakeConfig = {
    custom_field_ids: {
        reverse_charge: 10, // boolean
        total_net: 20, // monetary
        tax_amount: 21, // monetary
        qonto_transaction_amount: 30, // float
        invoice_date: 40, // date
        invoice_number: 50, // string
        invoice_currency: 60, // string (also drives the monetary default currency)
        related_documents: 65, // documentlink
        data_scope: 70, // select
    },
    select_field_options: { data_scope: { privat: '7', geschäftlich: '8', gemischt: '9' } },
} as unknown as SyncConfig;

/** Convenience: resolve a single friendly field and return its written value. */
function valueOf(fields: Record<string, unknown>, key: string): unknown {
    const id = (fakeConfig.custom_field_ids as Record<string, number>)[key];
    const entries = resolveCustomFieldEntries(fields, fakeConfig);
    return entries.find((e) => e.field === id)?.value;
}

export default async () => {
    await describe('custom-field type coercion', async () => {
        await describe('boolean', async () => {
            await it('coerces truthy string literals to true', async () => {
                for (const s of ['true', '1', 'yes', 'ja', 'TRUE', ' Ja ']) {
                    expect(valueOf({ reverse_charge: s }, 'reverse_charge')).toBe(true);
                }
            });
            await it('coerces falsy string literals to false', async () => {
                for (const s of ['false', '0', 'no', 'nein', 'FALSE']) {
                    expect(valueOf({ reverse_charge: s }, 'reverse_charge')).toBe(false);
                }
            });
            await it('passes an actual boolean through unchanged', async () => {
                expect(valueOf({ reverse_charge: true }, 'reverse_charge')).toBe(true);
                expect(valueOf({ reverse_charge: false }, 'reverse_charge')).toBe(false);
            });
            await it('skips an unrecognised boolean literal instead of sending a 500-triggering string', async () => {
                const entries = resolveCustomFieldEntries({ reverse_charge: 'maybe' }, fakeConfig);
                expect(entries.length).toBe(0);
            });
        });

        await describe('monetary', async () => {
            await it('formats a plain-number string as "<CUR><amount>" with 2 decimals (default EUR)', async () => {
                expect(valueOf({ total_net: '57.60' }, 'total_net')).toBe('EUR57.60');
                expect(valueOf({ total_net: '57.6' }, 'total_net')).toBe('EUR57.60');
                expect(valueOf({ tax_amount: '0' }, 'tax_amount')).toBe('EUR0.00');
            });
            await it('round-trips a currency-prefixed value (USD57.60 → parse → USD57.60)', async () => {
                const written = valueOf({ total_net: 'USD57.60' }, 'total_net');
                expect(written).toBe('USD57.60');
                const parsed = parseMonetaryValue(written);
                expect(parsed?.amount).toBe(57.6);
                expect(parsed?.currency).toBe('USD');
            });
            await it('uses invoice_currency from the same batch as the default currency', async () => {
                expect(valueOf({ total_net: '100', invoice_currency: 'CHF' }, 'total_net')).toBe('CHF100.00');
            });
            await it('formats a programmatic { amount, currency } object', async () => {
                expect(coerceCustomFieldValue('monetary', { amount: 57.6, currency: 'USD' })).toStrictEqual({
                    value: 'USD57.60',
                });
            });
            await it('formats a plain number with the default currency', async () => {
                expect(coerceCustomFieldValue('monetary', 12)).toStrictEqual({ value: 'EUR12.00' });
            });
            await it('skips an unparseable monetary value', async () => {
                expect(coerceCustomFieldValue('monetary', 'abc')).toBeNull();
            });
        });

        await describe('integer / float', async () => {
            await it('coerces a float field string to a number', async () => {
                expect(valueOf({ qonto_transaction_amount: '57.60' }, 'qonto_transaction_amount')).toBe(57.6);
            });
            await it('truncates an integer field and rejects NaN', async () => {
                expect(coerceCustomFieldValue('integer', '42.9')).toStrictEqual({ value: 42 });
                expect(coerceCustomFieldValue('integer', 'x')).toBeNull();
                expect(coerceCustomFieldValue('float', 'x')).toBeNull();
            });
        });

        await describe('date / string pass-through', async () => {
            await it('passes an ISO date string through unchanged', async () => {
                expect(valueOf({ invoice_date: '2026-07-15' }, 'invoice_date')).toBe('2026-07-15');
            });
            await it('passes a string field through unchanged', async () => {
                expect(valueOf({ invoice_number: 'INV-1' }, 'invoice_number')).toBe('INV-1');
            });
        });

        await describe('documentlink', async () => {
            await it('parses a single-id CLI string into a one-element list', async () => {
                // Paperless 400s ("Value must be a list") on the raw string the CLI hands in.
                expect(valueOf({ related_documents: '3081' }, 'related_documents')).toStrictEqual([3081]);
            });
            await it('parses a comma-separated CLI string into an id list', async () => {
                expect(valueOf({ related_documents: '3081, 3082' }, 'related_documents')).toStrictEqual([
                    3081, 3082,
                ]);
            });
            await it('passes a programmatic id array through, dropping non-numeric entries', async () => {
                expect(coerceCustomFieldValue('documentlink', [3081, 'x', 3082])).toStrictEqual({
                    value: [3081, 3082],
                });
            });
            await it('skips a value without any parseable id', async () => {
                expect(coerceCustomFieldValue('documentlink', 'abc')).toBeNull();
                const entries = resolveCustomFieldEntries({ related_documents: 'abc' }, fakeConfig);
                expect(entries.length).toBe(0);
            });
        });

        await describe('select unchanged', async () => {
            await it('still resolves a select label to its numeric option id', async () => {
                expect(valueOf({ data_scope: 'privat' }, 'data_scope')).toBe(7);
            });
        });
    });
};
