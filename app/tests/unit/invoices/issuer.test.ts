import { describe, it, expect } from '@gjsify/unit';
import { resolveInvoiceIssuer, elsterIssuerFallback, type IssuerFallback } from '../../../src/core/invoices/issuer.ts';
import type { IssuerConfig } from '../../../src/core/config/index.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

export default async () => {
    await describe('resolveInvoiceIssuer', async () => {
        const fallback: IssuerFallback = {
            name: 'Betrieb aus ELSTER',
            address: 'Betriebsweg 9',
            zip: '11111',
            city: 'Betriebstadt',
            taxNumber: '99/999/99999',
        };

        await it('uses the ELSTER fallback when the config issuer is empty', async () => {
            const s = resolveInvoiceIssuer(null, fallback);
            expect(s.name).toBe('Betrieb aus ELSTER');
            expect(s.address).toBe('Betriebsweg 9');
            expect(s.taxNumber).toBe('99/999/99999');
            expect(s.countryCode).toBe('DE');
            expect(s.kleinunternehmer).toBe(false);
        });

        await it('lets an explicit issuer field win over the fallback', async () => {
            const issuer: IssuerConfig = { name: 'JumpLink', taxNumber: '12/345/67890', vatId: 'DE123456789' };
            const s = resolveInvoiceIssuer(issuer, fallback);
            expect(s.name).toBe('JumpLink'); // config wins
            expect(s.address).toBe('Betriebsweg 9'); // still falls back
            expect(s.taxNumber).toBe('12/345/67890');
            expect(s.vatId).toBe('DE123456789');
        });

        await it('carries invoice-only fields (kleinunternehmer, bank) and normalises the IBAN', async () => {
            const issuer: IssuerConfig = {
                name: 'Klein',
                kleinunternehmer: true,
                bank: { iban: 'DE02 1203 0000 0000 2020 51', bankName: 'Beispielbank' },
            };
            const s = resolveInvoiceIssuer(issuer, {});
            expect(s.kleinunternehmer).toBe(true);
            expect(s.bank?.iban).toBe('DE02120300000000202051');
            expect(s.bank?.bankName).toBe('Beispielbank');
            expect(s.bank?.bic).toBe(null);
        });
    });

    await describe('elsterIssuerFallback', async () => {
        await it('maps betrieb + tax_number, tolerating a missing betrieb', async () => {
            const elster = {
                tax_number: '99/999/99999',
                betrieb: { name: 'GbR', strasse: 'Weg 1', plz: '12345', ort: 'Stadt' },
            } as unknown as ElsterConfig;
            expect(elsterIssuerFallback(elster)).toStrictEqual({
                name: 'GbR',
                address: 'Weg 1',
                zip: '12345',
                city: 'Stadt',
                taxNumber: '99/999/99999',
            });
            expect(elsterIssuerFallback(undefined)).toStrictEqual({});
        });
    });
};
