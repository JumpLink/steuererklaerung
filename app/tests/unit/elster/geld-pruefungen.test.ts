import { describe, it, expect } from '@gjsify/unit';
import { findeSerien, parteiSchluessel, type SerienPosten } from '../../../src/core/elster/serie.ts';
import {
    maskiereIban,
    normalisiereIban,
    pruefeIbanWechsel,
    type IbanBuchung,
} from '../../../src/core/elster/iban-wechsel.ts';
import { pruefeDoppelteRechnungen, type RechnungsBeleg } from '../../../src/core/elster/doppelte-rechnung.ts';
import { pruefeLieferantDoppeltBezahlt, type ZahlBuchung } from '../../../src/core/elster/lieferant-doppelt-bezahlt.ts';
import { sortHinweise, type Hinweis } from '../../../src/core/elster/hinweise.ts';
import { buildHomeModel } from '../../../src/core/elster/home.ts';
import { GLOSSARY } from '../../../src/core/lib/glossary.ts';
import { normalizeQonto } from '../../../src/core/lib/transactions/normalize-qonto.ts';

// Invented IBANs only — the documented example pattern with zeroed digits.
const IBAN_A = 'DE00 0000 0000 0000 0001 11';
const IBAN_B = 'DE00000000000000000222';
const IBAN_C = 'DE00000000000000000333';
const EIGEN = 'DE00000000000000000999';

let n = 0;
function debit(over: Partial<IbanBuchung>): IbanBuchung {
    return {
        id: `d${n++}`,
        accountKey: 'camt:test',
        source: 'camt',
        bookingDate: '2025-06-01',
        amount: -100,
        counterparty: 'Muster Hosting GmbH',
        ...over,
    };
}

const iban = (buchungen: IbanBuchung[], eigeneIbans: string[] = []) =>
    pruefeIbanWechsel({ year: 2025, buchungen, eigeneIbans });

function beleg(over: Partial<RechnungsBeleg>): RechnungsBeleg {
    return {
        id: `b${n++}`,
        direction: 'incoming',
        correspondent: 'Büro Beispiel GmbH',
        invoiceNumber: null,
        gross: 238,
        created: '2025-05-10',
        linkedTxIds: [],
        ...over,
    };
}

function zahlung(over: Partial<ZahlBuchung>): ZahlBuchung {
    return { id: `z${n++}`, bookingDate: '2025-05-20', amount: -238, counterparty: 'Büro Beispiel GmbH', ...over };
}

const posten = (datum: string, betrag = -9.99, partei = 'Muster Abo AG'): SerienPosten => ({
    id: `p${n++}`,
    datum,
    betrag,
    partei,
});

export default async () => {
    await describe('Serien (shared with Idee 8)', async () => {
        await it('monthly with a few days of jitter is a series', async () => {
            const s = findeSerien([posten('2025-01-03'), posten('2025-02-05'), posten('2025-03-02')]);
            expect(s.length).toBe(1);
            expect(s[0].abstand).toBe('monatlich');
            expect(s[0].ids.length).toBe(3);
        });
        await it('quarterly and yearly are found too', async () => {
            const q = findeSerien([
                posten('2025-01-10'),
                posten('2025-04-12'),
                posten('2025-07-09'),
                posten('2025-10-11'),
            ]);
            expect(q.map((x) => x.abstand)).toStrictEqual(['vierteljaehrlich']);
            const y = findeSerien([posten('2023-03-11'), posten('2024-03-13'), posten('2025-03-10')]);
            expect(y.map((x) => x.abstand)).toStrictEqual(['jaehrlich']);
        });
        await it('fewer than three hits, other amounts or too much jitter are no series', async () => {
            expect(findeSerien([posten('2025-01-03'), posten('2025-02-03')]).length).toBe(0);
            expect(findeSerien([posten('2025-01-03'), posten('2025-02-03', -10), posten('2025-03-03')]).length).toBe(0);
            expect(findeSerien([posten('2025-01-03'), posten('2025-02-15'), posten('2025-03-27')]).length).toBe(0);
        });
        await it('compares names by their normalised key', async () => {
            expect(parteiSchluessel('HETZNER ONLINE GMBH')).toBe(parteiSchluessel('Hetzner Online GmbH'));
            const s = findeSerien([
                posten('2025-01-03', -5, 'ABO AG'),
                posten('2025-02-03', -5, 'Abo AG'),
                posten('2025-03-03', -5, 'abo-ag'),
            ]);
            expect(s.length).toBe(1);
        });
        await it('a second booking off the beat stays outside the series', async () => {
            const extra = posten('2025-02-05');
            const s = findeSerien([posten('2025-01-03'), posten('2025-02-03'), extra, posten('2025-03-03')]);
            expect(s.length).toBe(1);
            expect(s[0].ids.includes(extra.id)).toBe(false);
        });
    });

    await describe('IBAN-Wechsel', async () => {
        await it('normalises and masks IBANs', async () => {
            expect(normalisiereIban(' de00 0000 0000 0000 0001 11 ')).toBe('DE00000000000000000111');
            expect(maskiereIban(IBAN_A)).toBe('DE…0111');
        });
        await it('a known supplier paid to a new IBAN is a befund with vorrang', async () => {
            const neu = debit({ bookingDate: '2025-03-01', counterpartyIban: IBAN_B });
            const [h] = iban([
                debit({ bookingDate: '2024-11-01', counterpartyIban: IBAN_A }),
                debit({ bookingDate: '2025-01-01', counterpartyIban: 'de00000000000000000111' }),
                neu,
            ]);
            expect(h.status).toBe('befund');
            expect(h.level).toBe('warnung');
            expect(h.vorrang).toBe(true);
            expect(h.key).toBe('iban-wechsel:musterhostinggmbh');
            expect(h.betroffen?.[0].id).toBe(neu.id);
            expect(h.text).toContain('bisher bekannten');
            expect(h.text).toContain('DE…0222');
            expect(h.text.includes(normalisiereIban(IBAN_B))).toBe(false);
            expect(h.handlungen?.map((a) => a.id)).toStrictEqual(['buchung', 'in-ordnung']);
            expect(h.begriff).toBe('iban-wechsel');
        });
        await it('a third IBAN gives a new fingerprint, so a dismissed finding comes back', async () => {
            const base = [
                debit({ bookingDate: '2024-11-01', counterpartyIban: IBAN_A }),
                debit({ bookingDate: '2025-03-01', counterpartyIban: IBAN_B }),
            ];
            const [vorher] = iban(base);
            const [nachher] = iban([...base, debit({ bookingDate: '2025-05-01', counterpartyIban: IBAN_C })]);
            expect(typeof vorher.fingerprint).toBe('string');
            expect(nachher.fingerprint === vorher.fingerprint).toBe(false);
            const [gleich] = iban([...base, debit({ bookingDate: '2025-05-01', counterpartyIban: IBAN_B })]);
            expect(gleich.fingerprint).toBe(vorher.fingerprint);
        });
        await it('the first payment ever is no finding', async () => {
            const [h] = iban([debit({ counterpartyIban: IBAN_A })]);
            expect(h.status).toBe('ohne_befund');
            expect(h.geprueft).toContain('erste Zahlung an einen Empfänger (1)');
        });
        await it('own accounts and Umbuchungen are excluded', async () => {
            const [h] = iban(
                [
                    debit({ bookingDate: '2024-11-01', counterparty: 'Fischer', counterpartyIban: IBAN_A }),
                    debit({ bookingDate: '2025-03-01', counterparty: 'Fischer', counterpartyIban: EIGEN }),
                ],
                [EIGEN],
            );
            expect(h.status).toBe('ohne_befund');
            expect(h.geprueft).toContain('Umbuchungen (1)');
        });
        await it('an established second account used alternately is excluded', async () => {
            const [h] = iban([
                debit({ bookingDate: '2024-02-01', counterpartyIban: IBAN_A }),
                debit({ bookingDate: '2024-05-01', counterpartyIban: IBAN_B }),
                debit({ bookingDate: '2025-02-01', counterpartyIban: IBAN_A }),
                debit({ bookingDate: '2025-05-01', counterpartyIban: IBAN_B }),
            ]);
            expect(h.status).toBe('ohne_befund');
            expect(h.geprueft).toContain('zweite IBAN (2)');
        });
        await it('nicht_pruefbar when no debit carries a counterparty IBAN; PayPal is skipped', async () => {
            const [h] = iban([
                debit({ counterpartyIban: undefined }),
                debit({ source: 'paypal', accountKey: 'paypal:x', counterpartyIban: IBAN_A }),
            ]);
            expect(h.status).toBe('nicht_pruefbar');
            expect(h.weil).toContain('keine IBAN der Gegenseite');
            expect(iban([debit({ source: 'paypal', accountKey: 'paypal:x', counterpartyIban: IBAN_A })]).length).toBe(
                0,
            );
        });
        await it('ohne_befund names the accounts it could not check', async () => {
            const [h] = iban([
                debit({ counterpartyIban: IBAN_A }),
                debit({ accountKey: 'qonto:alt', source: 'qonto', counterpartyIban: undefined }),
            ]);
            expect(h.status).toBe('ohne_befund');
            expect(h.geprueft).toContain('nicht geprüft: qonto:alt');
        });
    });

    await describe('Doppelte Rechnung', async () => {
        await it('same sender + same invoice number is a befund', async () => {
            const a = beleg({ invoiceNumber: 'BB-2025-17', gross: 238 });
            const b = beleg({ invoiceNumber: 'bb 2025 17', gross: 240, created: '2025-08-01' });
            const [h] = pruefeDoppelteRechnungen({ year: 2025, belege: [a, b] });
            expect(h.status).toBe('befund');
            expect(h.text).toContain('gleiche Rechnungsnummer');
            expect(h.betroffen?.map((x) => x.art)).toStrictEqual(['beleg', 'beleg']);
            expect(h.handlungen?.map((x) => x.id)).toStrictEqual(['beleg', 'in-ordnung']);
        });
        await it('same sender + same gross within the window is a befund, outside it is not', async () => {
            const [h] = pruefeDoppelteRechnungen({
                year: 2025,
                belege: [beleg({ created: '2025-05-10' }), beleg({ created: '2025-05-24' })],
            });
            expect(h.status).toBe('befund');
            const [ok] = pruefeDoppelteRechnungen({
                year: 2025,
                belege: [beleg({ created: '2025-05-10' }), beleg({ created: '2025-07-10' })],
            });
            expect(ok.status).toBe('ohne_befund');
        });
        await it('a subscription series is excluded', async () => {
            const belege = ['2025-01-28', '2025-02-25', '2025-03-28', '2025-04-27'].map((created) =>
                beleg({ created, gross: 49.95, correspondent: 'Telefon AG' }),
            );
            const [h] = pruefeDoppelteRechnungen({ year: 2025, belege });
            expect(h.status).toBe('ohne_befund');
            expect(h.geprueft).toContain('Serien wie Abos');
            expect(h.geprueft).toContain('2 Paar(e)');
        });
        await it('a third copy changes the fingerprint', async () => {
            const a = beleg({ created: '2025-05-10' });
            const b = beleg({ created: '2025-05-12' });
            const [eins] = pruefeDoppelteRechnungen({ year: 2025, belege: [a, b] });
            const [zwei] = pruefeDoppelteRechnungen({ year: 2025, belege: [a, b, beleg({ created: '2025-05-14' })] });
            expect(zwei.betroffen?.length).toBe(3);
            expect(zwei.fingerprint === eins.fingerprint).toBe(false);
        });
        await it('nicht_pruefbar without incoming invoices or without senders', async () => {
            const [leer] = pruefeDoppelteRechnungen({ year: 2025, belege: [beleg({ direction: 'outgoing' })] });
            expect(leer.status).toBe('nicht_pruefbar');
            const [ohne] = pruefeDoppelteRechnungen({ year: 2025, belege: [beleg({ correspondent: null })] });
            expect(ohne.weil).toContain('kein');
        });
    });

    await describe('Lieferant doppelt bezahlt', async () => {
        await it('a linked payment plus a second one quoting the number is a befund', async () => {
            const z1 = zahlung({ purpose: 'Rechnung BB-2025-77' });
            const z2 = zahlung({ bookingDate: '2025-05-27', purpose: 'BB-2025-77' });
            const d = beleg({ invoiceNumber: 'BB-2025-77', linkedTxIds: [z1.id] });
            const [h] = pruefeLieferantDoppeltBezahlt({ year: 2025, belege: [d], buchungen: [z1, z2] });
            expect(h.status).toBe('befund');
            expect(h.text).toContain('238,00 € zu viel');
            expect(h.betroffen?.map((x) => x.art)).toStrictEqual(['beleg', 'buchung', 'buchung']);
            expect(h.handlungen?.map((x) => x.id)).toStrictEqual(['rechnung', 'in-ordnung']);
            // A third payment is a new finding.
            const z3 = zahlung({ bookingDate: '2025-06-03', purpose: 'BB-2025-77' });
            const [h3] = pruefeLieferantDoppeltBezahlt({ year: 2025, belege: [d], buchungen: [z1, z2, z3] });
            expect(h3.fingerprint === h.fingerprint).toBe(false);
        });
        await it('one payment above the gross is a befund', async () => {
            const z = zahlung({ amount: -300 });
            const [h] = pruefeLieferantDoppeltBezahlt({
                year: 2025,
                belege: [beleg({ linkedTxIds: [z.id] })],
                buchungen: [z],
            });
            expect(h.status).toBe('befund');
            expect(h.text).toContain('62,00 € zu viel');
        });
        await it('partial payments and Anzahlung + Rest are excluded', async () => {
            const a = zahlung({ amount: -100, purpose: 'Anzahlung BB-2025-78' });
            const b = zahlung({ amount: -138, purpose: 'Rest BB-2025-78' });
            const [h] = pruefeLieferantDoppeltBezahlt({
                year: 2025,
                belege: [beleg({ invoiceNumber: 'BB-2025-78' })],
                buchungen: [a, b],
            });
            expect(h.status).toBe('ohne_befund');
            expect(h.geprueft).toContain('Anzahlung + Rest (1)');
        });
        await it('a later refund credit from the supplier is excluded', async () => {
            const z1 = zahlung({});
            const z2 = zahlung({ bookingDate: '2025-05-22' });
            const back = zahlung({ bookingDate: '2025-06-15', amount: 238 });
            const [h] = pruefeLieferantDoppeltBezahlt({
                year: 2025,
                belege: [beleg({ linkedTxIds: [z1.id, z2.id] })],
                buchungen: [z1, z2, back],
            });
            expect(h.status).toBe('ohne_befund');
            expect(h.geprueft).toContain('später erstattet (1)');
        });
        await it('a series quoting one contract number is excluded', async () => {
            const zs = ['2025-01-05', '2025-02-05', '2025-03-05'].map((bookingDate) =>
                zahlung({ bookingDate, amount: -10, counterparty: 'Abo AG', purpose: 'Vertrag K-12345' }),
            );
            const [h] = pruefeLieferantDoppeltBezahlt({
                year: 2025,
                belege: [beleg({ correspondent: 'Abo AG', invoiceNumber: 'K-12345', gross: 10 })],
                buchungen: zs,
            });
            expect(h.status).toBe('ohne_befund');
            expect(h.geprueft).toContain('Serien wie Abos (1)');
        });
        await it('a combined payment quoting two invoices is left alone', async () => {
            const z = zahlung({ amount: -476, purpose: 'BB-2025-80 BB-2025-81' });
            const [h] = pruefeLieferantDoppeltBezahlt({
                year: 2025,
                belege: [beleg({ invoiceNumber: 'BB-2025-80' }), beleg({ invoiceNumber: 'BB-2025-81' })],
                buchungen: [z],
            });
            expect(h.status).toBe('nicht_pruefbar');
        });
        await it('nicht_pruefbar when no invoice has a payment', async () => {
            const [h] = pruefeLieferantDoppeltBezahlt({ year: 2025, belege: [beleg({})], buchungen: [] });
            expect(h.status).toBe('nicht_pruefbar');
            expect(h.weil).toContain('keine Eingangsrechnung');
        });
    });

    await describe('Geld-Prüfungen — ordering and wiring', async () => {
        const warnung: Hinweis = { key: 'a', level: 'warnung', title: 'A', text: '' };
        const vorrang: Hinweis = {
            key: 'iban-wechsel:x',
            level: 'warnung',
            title: 'IBAN',
            text: '',
            vorrang: true,
            status: 'befund',
            handlungen: [{ id: 'buchung', label: 'Buchung öffnen', target: { art: 'dialog', dialog: 'buchung' } }],
        };
        await it('IBAN-Wechsel sorts first among the hints', async () => {
            expect(sortHinweise([warnung, { ...warnung, key: 'b' }, vorrang]).map((h) => h.key)[0]).toBe(
                'iban-wechsel:x',
            );
        });
        await it('IBAN-Wechsel is the first task in Als Nächstes, ahead of double payments', async () => {
            const home = buildHomeModel({
                year: 2025,
                txs: [],
                dashboard: null,
                doppelzahlungVerdacht: [{ rechnungId: 'r1', rechnungNummer: 'RE-1', zuViel: 10 }],
                hinweise: [vorrang],
            });
            expect(home.tasks[0].ref).toBe('iban-wechsel:x');
            expect(home.tasks[1].kind).toBe('doppelzahlung');
        });
        await it('every begriff a check sets is in the glossary', async () => {
            const hints = [
                ...iban([debit({ counterpartyIban: IBAN_A })]),
                ...iban([debit({ counterpartyIban: undefined })]),
            ];
            for (const h of hints) if (h.begriff) expect(!!GLOSSARY[h.begriff]).toBe(true);
            expect(!!GLOSSARY['iban-wechsel']).toBe(true);
        });
        await it('Qonto rows carry the counterparty IBAN of transfers, not of card payments', async () => {
            const base = {
                id: 'q1',
                amount_cents: 1000,
                currency: 'EUR',
                side: 'debit' as const,
                emitted_at: '2025-01-01T10:00:00Z',
                updated_at: '2025-01-01T10:00:00Z',
            };
            const transfer = normalizeQonto('qonto:x', undefined, {
                ...base,
                transfer: { counterparty_account_number: IBAN_B, counterparty_account_number_format: 'IBAN' },
            });
            expect(transfer.counterpartyIban).toBe(IBAN_B);
            expect(normalizeQonto('qonto:x', undefined, base).counterpartyIban).toBe(undefined);
            const bban = normalizeQonto('qonto:x', undefined, {
                ...base,
                transfer: { counterparty_account_number: '123456', counterparty_account_number_format: 'BBAN' },
            });
            expect(bban.counterpartyIban).toBe(undefined);
        });
    });
};
