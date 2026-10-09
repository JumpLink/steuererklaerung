import { describe, it, expect } from '@gjsify/unit';
import { buildEpcPayload, normalizeIban } from '../../../src/core/lib/sepa-qr.ts';

export default async () => {
    await describe('normalizeIban', async () => {
        await it('strips spaces and upper-cases', async () => {
            expect(normalizeIban('de89 3704 0044 0532 0130 00')).toBe('DE89370400440532013000');
        });
    });

    await describe('buildEpcPayload', async () => {
        const base = { name: 'Stadtwerke Musterstadt', iban: 'DE89 3704 0044 0532 0130 00' };

        await it('produces the 12-line EPC069-12 structure with amount + remittance', async () => {
            const payload = buildEpcPayload({ ...base, amount: 85.93, remittance: 'Kundennr 12345' });
            const lines = payload.split('\n');
            expect(lines).toHaveLength(12);
            expect(lines[0]).toBe('BCD'); // service tag
            expect(lines[1]).toBe('002'); // version
            expect(lines[2]).toBe('1'); // UTF-8
            expect(lines[3]).toBe('SCT'); // SEPA credit transfer
            expect(lines[5]).toBe('Stadtwerke Musterstadt'); // beneficiary
            expect(lines[6]).toBe('DE89370400440532013000'); // normalized IBAN
            expect(lines[7]).toBe('EUR85.93'); // amount, 2 decimals
            expect(lines[9]).toBe(''); // structured remittance unused
            expect(lines[10]).toBe('Kundennr 12345'); // unstructured remittance
        });

        await it('omits the amount line for an open-amount code', async () => {
            const lines = buildEpcPayload(base).split('\n');
            expect(lines[7]).toBe('');
        });

        await it('rejects an invalid IBAN', async () => {
            expect(() => buildEpcPayload({ ...base, iban: 'NOTANIBAN' })).toThrow(/IBAN/);
        });

        await it('rejects a missing beneficiary name', async () => {
            expect(() => buildEpcPayload({ name: '  ', iban: base.iban })).toThrow(/name/i);
        });

        await it('rejects non-EUR currency', async () => {
            expect(() => buildEpcPayload({ ...base, currency: 'USD' })).toThrow(/EUR/);
        });

        await it('rejects an out-of-range amount', async () => {
            expect(() => buildEpcPayload({ ...base, amount: 0.001 })).toThrow(/between/);
        });

        await it('truncates remittance to 140 chars', async () => {
            const long = 'x'.repeat(200);
            const lines = buildEpcPayload({ ...base, remittance: long }).split('\n');
            expect(lines[10]).toHaveLength(140);
        });
    });
};
