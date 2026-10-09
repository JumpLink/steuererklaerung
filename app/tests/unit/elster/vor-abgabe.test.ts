import { describe, it, expect } from '@gjsify/unit';
import {
    pruefeUstAbweichung,
    ustZeitraeume,
    zeitraumVon,
    UST_ABWEICHUNG_MIN_EUR,
    type ErklaerteVoranmeldung,
    type UstZeile,
} from '../../../src/core/elster/ust-abweichung.ts';
import {
    pruefeBuchungenOhneUst,
    type OhneUstBeleg,
    type OhneUstZeile,
} from '../../../src/core/elster/ust-ohne-angabe.ts';
import {
    landAusIban,
    landAusUstId,
    pruefeReverseChargeKandidaten,
    reverseChargeKandidaten,
    type RcZeile,
} from '../../../src/core/elster/reverse-charge-kandidat.ts';
import {
    abschreibungsGrenzen,
    pruefeAnlagegutKandidaten,
    type AnlageZeile,
} from '../../../src/core/elster/anlagegut-kandidat.ts';
import { vorAbgabeHinweise } from '../../../src/core/elster/vor-abgabe.ts';
import type { Hinweis } from '../../../src/core/elster/hinweise.ts';
import { buildHomeModel } from '../../../src/core/elster/home.ts';
import { istErledigt } from '../../../src/core/actions/elster/hinweise.ts';
import { GLOSSARY } from '../../../src/core/lib/glossary.ts';

// Invented bookings, parties and IBANs only (zeroed digits like the other fixtures).
const IBAN_IE = 'IE00000000000000000042';
const IBAN_DE = 'DE00000000000000000777';

let n = 0;
const id = (p: string) => `${p}${n++}`;

/** One quarter's worth of USt: an income with `ust` collected. */
function einnahme(datum: string, ust: number): UstZeile {
    return {
        id: id('e'),
        bookingDate: datum,
        amount: round(ust / 0.19 + ust),
        kind: 'income',
        vat: ust,
        counterparty: 'Kunde',
    };
}
function ausgabeUst(datum: string, vorsteuer: number): UstZeile {
    return {
        id: id('a'),
        bookingDate: datum,
        amount: -round(vorsteuer / 0.19 + vorsteuer),
        kind: 'expense',
        vat: vorsteuer,
    };
}
const round = (x: number) => Math.round(x * 100) / 100;

function ust(zeilen: UstZeile[], opts: { erklaert?: ErklaerteVoranmeldung[]; today?: string; year?: number } = {}) {
    return pruefeUstAbweichung({
        year: opts.year ?? 2026,
        zeitraeume: ustZeitraeume({ zeilen, erklaert: opts.erklaert ?? [], rhythmus: 'quartal' }),
        zeilen,
        today: opts.today ?? '2026-12-31',
    });
}

/** Four quiet quarters of 2025 with a Zahllast of about 500 €. */
const ruhig2025 = () => ['2025-02-10', '2025-05-10', '2025-08-10', '2025-11-10'].map((d) => einnahme(d, 500));

function ohneUstZeile(over: Partial<OhneUstZeile> = {}): OhneUstZeile {
    return {
        id: id('o'),
        bookingDate: '2026-04-16',
        amount: -89.25,
        counterparty: 'Copyshop Beispiel',
        kind: 'expense',
        category: '4600 Werbe-/Marketingkosten',
        ...over,
    };
}
function beleg(txId: string, over: Partial<OhneUstBeleg> = {}): OhneUstBeleg {
    return { id: id('b'), direction: 'incoming', net: null, gross: 89.25, vat: null, linkedTxIds: [txId], ...over };
}

function rcZeile(over: Partial<RcZeile> = {}): RcZeile {
    return {
        id: id('r'),
        bookingDate: '2026-05-08',
        amount: -59,
        counterparty: 'Analytics Beispiel Ltd',
        kind: 'expense',
        category: '4964 Software/Lizenzen',
        ...over,
    };
}

function anlage(over: Partial<AnlageZeile> = {}): AnlageZeile {
    const gross = over.gross ?? 1428;
    return {
        id: id('g'),
        bookingDate: '2026-05-20',
        amount: -gross,
        counterparty: 'Technikhaus Beispiel GmbH',
        purpose: 'Workstation',
        kind: 'expense',
        category: '4930 Bürobedarf',
        net: round(gross / 1.19),
        gross,
        ...over,
    };
}
const gwg = (zeilen: AnlageZeile[], extra: Partial<Parameters<typeof pruefeAnlagegutKandidaten>[0]> = {}) =>
    pruefeAnlagegutKandidaten({ year: 2026, zeilen, anlagen: [], ...extra });

export default async () => {
    await describe('Prüfungen vor der Abgabe — USt-Abweichung', async () => {
        await it('period keys follow the register (quarter or month)', async () => {
            expect(zeitraumVon('2026-05-20', 'quartal')).toBe('2026-Q2');
            expect(zeitraumVon('2026-05-20', 'monat')).toBe('2026-05');
        });
        await it('a quarter far from the earlier ones is a befund with its largest USt items', async () => {
            const gross = einnahme('2026-02-03', 2000);
            const hs = ust([...ruhig2025(), gross, einnahme('2026-02-20', 10)]);
            expect(hs.length).toBe(1);
            const h = hs[0];
            expect(h.status).toBe('befund');
            expect(h.title).toBe('USt-Zahllast weicht ab: Q1/2026');
            expect(h.text).toContain('sonst um 500,00 €');
            expect(h.text).not.toContain('Fehler');
            expect(h.betroffen![0].id).toBe(gross.id);
            expect(h.handlungen!.map((a) => a.id)).toStrictEqual(['buchungen', 'in-ordnung']);
        });
        await it('a filed value wins over the computed one', async () => {
            const hs = ust([...ruhig2025(), einnahme('2026-02-03', 2000)], {
                erklaert: [{ period: '2026-Q1', zahllast: 520 }],
            });
            expect(hs[0].status).toBe('ohne_befund');
            const z = ustZeitraeume({
                zeilen: [einnahme('2026-02-03', 2000)],
                erklaert: [
                    { period: '2026-Q1', zahllast: 520 },
                    { period: '2026-03', zahllast: 1 },
                ],
                rhythmus: 'quartal',
            });
            expect(z.map((x) => [x.key, x.zahllast, x.quelle])).toStrictEqual([['2026-Q1', 520, 'erklaert']]);
        });
        await it('a deviation below the euro minimum is not marked, even at a large share', async () => {
            const klein = ['2025-02-10', '2025-05-10', '2025-08-10', '2025-11-10'].map((d) => einnahme(d, 100));
            const hs = ust([...klein, einnahme('2026-02-03', 100 + UST_ABWEICHUNG_MIN_EUR)]);
            expect(hs[0].status).toBe('ohne_befund');
            expect(hs[0].geprueft).toContain('Median');
        });
        await it('too little history is nicht prüfbar, a running quarter is not checked', async () => {
            const kurz = ust([einnahme('2025-11-10', 500), einnahme('2026-02-03', 3000)]);
            expect(kurz[0].status).toBe('nicht_pruefbar');
            expect(kurz[0].weil).toContain('weniger als 2');
            const laufend = ust([...ruhig2025(), einnahme('2026-02-03', 3000)], { today: '2026-03-15' });
            expect(laufend[0].status).toBe('nicht_pruefbar');
        });
        await it('a Kleinunternehmer has nothing to compare', async () => {
            const [h] = pruefeUstAbweichung({
                year: 2026,
                zeitraeume: [],
                zeilen: [],
                today: '2026-12-31',
                kleinunternehmer: true,
            });
            expect(h.status).toBe('nicht_pruefbar');
        });
        await it('Vorsteuer lowers the Zahllast; year-end adjustments stay out', async () => {
            const z = ustZeitraeume({
                zeilen: [
                    einnahme('2026-01-10', 300),
                    ausgabeUst('2026-02-10', 100),
                    { ...einnahme('2026-12-31', 999), accountKey: 'adjustment' },
                ],
                erklaert: [],
                rhythmus: 'quartal',
            });
            expect(z.map((x) => [x.key, x.zahllast])).toStrictEqual([['2026-Q1', 200]]);
        });
        await it('the fingerprint follows the deviating figure — a new figure brings the hint back', async () => {
            const a = ust([...ruhig2025(), einnahme('2026-02-03', 2000)])[0];
            const b = ust([...ruhig2025(), einnahme('2026-02-03', 2100)])[0];
            const geprueft = [{ hinweis: a.key, jahr: 2026, fingerprint: a.fingerprint!, geprueft_am: '2026-04-01' }];
            expect(istErledigt(a, 2026, geprueft)).toBe(true);
            expect(istErledigt(b, 2026, geprueft)).toBe(false);
        });
    });

    await describe('Prüfungen vor der Abgabe — Buchungen ohne USt-Angabe', async () => {
        await it('a receipt without VAT or net makes a befund — the Vorsteuer is a lower bound', async () => {
            const r = ohneUstZeile();
            const d = beleg(r.id);
            const [h] = pruefeBuchungenOhneUst({ year: 2026, zeilen: [r], belege: [d] });
            expect(h.status).toBe('befund');
            expect(h.text).toContain('Untergrenze');
            expect(h.betroffen!.map((b) => b.id)).toStrictEqual([r.id]);
            expect(h.handlungen![0].target).toStrictEqual({ art: 'dialog', dialog: 'beleg', ref: d.id });
        });
        await it('0 € VAT, net + gross, VAT-exempt categories, unclassified and § 13b candidates are no finding', async () => {
            const null0 = ohneUstZeile();
            const netto = ohneUstZeile();
            const versicherung = ohneUstZeile({ category: '4360 Versicherungen' });
            const unklar = ohneUstZeile({ category: '(unklassifiziert)' });
            const rc = ohneUstZeile();
            const [h] = pruefeBuchungenOhneUst({
                year: 2026,
                zeilen: [null0, netto, versicherung, unklar, rc],
                belege: [
                    beleg(null0.id, { vat: 0 }),
                    beleg(netto.id, { net: 75 }),
                    beleg(versicherung.id),
                    beleg(unklar.id),
                    beleg(rc.id),
                ],
                ausgenommen: new Set([rc.id]),
            });
            expect(h.status).toBe('ohne_befund');
            expect(h.geprueft).toContain('USt-freie Kategorien (1)');
            expect(h.geprueft).toContain('§ 13b-Kandidaten (1)');
        });
        await it('without any linked receipt it is nicht prüfbar; a Kleinunternehmer has nothing to miss', async () => {
            const [h] = pruefeBuchungenOhneUst({ year: 2026, zeilen: [ohneUstZeile()], belege: [] });
            expect(h.status).toBe('nicht_pruefbar');
            const r = ohneUstZeile();
            const [ku] = pruefeBuchungenOhneUst({
                year: 2026,
                zeilen: [r],
                belege: [beleg(r.id)],
                kleinunternehmer: true,
            });
            expect(ku.status).toBe('ohne_befund');
        });
        await it('one more booking gives a new fingerprint', async () => {
            const a = ohneUstZeile();
            const b = ohneUstZeile();
            const one = pruefeBuchungenOhneUst({ year: 2026, zeilen: [a], belege: [beleg(a.id)] })[0];
            const two = pruefeBuchungenOhneUst({ year: 2026, zeilen: [a, b], belege: [beleg(a.id), beleg(b.id)] })[0];
            expect(one.fingerprint === two.fingerprint).toBe(false);
        });
    });

    await describe('Prüfungen vor der Abgabe — § 13b-Kandidat nicht erkannt', async () => {
        await it('reads countries from IBAN and USt-IdNr', async () => {
            expect(landAusIban(IBAN_IE)).toBe('IE');
            expect(landAusIban('kein iban')).toBe(null);
            expect(landAusUstId('ATU00000000')).toBe('AT');
        });
        await it('a debit without VAT to a foreign IBAN is a warnung under § 13b Abs. 1', async () => {
            const r = rcZeile({ counterpartyIban: IBAN_IE });
            const hs = pruefeReverseChargeKandidaten({ year: 2026, zeilen: [r], belege: [] });
            expect(hs.length).toBe(1);
            expect(hs[0].level).toBe('warnung');
            expect(hs[0].status).toBe('befund');
            expect(hs[0].text).toContain('§ 13b Abs. 5 UStG (Abs. 1: Leistung aus der EU)');
            expect(hs[0].text).toContain('Gegenkonto in IE');
            expect(hs[0].handlungen!.map((a) => a.id)).toStrictEqual(['beleg-zuordnen', 'buchung', 'in-ordnung']);
        });
        await it('a contact abroad (third country) and an earlier § 13b booking of the same party are signals too', async () => {
            const us = rcZeile({ counterparty: 'Cloud Beispiel Inc.' });
            const [h] = pruefeReverseChargeKandidaten({
                year: 2026,
                zeilen: [us],
                belege: [],
                parteien: [{ name: 'Cloud Beispiel Inc', land: 'US' }],
            });
            expect(h.text).toContain('Abs. 2 Nr. 1: Drittland');
            const gebucht = rcZeile({ reverseCharge: 'gebucht', lieferantLand: 'NL', bookingDate: '2026-03-08' });
            const vergessen = rcZeile();
            const hs = pruefeReverseChargeKandidaten({ year: 2026, zeilen: [gebucht, vergessen], belege: [] });
            expect(hs[0].betroffen!.map((b) => b.id)).toStrictEqual([vergessen.id]);
            expect(hs[0].text).toContain('als § 13b eingeordnet');
        });
        await it('excluded: booked or held § 13b, a receipt with VAT, VAT-exempt categories, Germany on the receipt', async () => {
            const fremd = { counterpartyIban: IBAN_IE };
            const zeilen = [
                rcZeile({ ...fremd, reverseCharge: 'gebucht' }),
                rcZeile({ ...fremd, reverseCharge: 'pruefen' }),
                rcZeile({ ...fremd, id: 'mit-ust' }),
                rcZeile({ ...fremd, category: '4970 Nebenkosten Geldverkehr' }),
                rcZeile({ ...fremd, lieferantLand: 'DE' }),
                rcZeile({ counterpartyIban: IBAN_DE, counterparty: 'Inland Beispiel GmbH' }),
            ];
            const [h] = pruefeReverseChargeKandidaten({
                year: 2026,
                zeilen,
                belege: [{ id: 'b1', vat: 9.42, linkedTxIds: ['mit-ust'] }],
            });
            expect(h.status).toBe('ohne_befund');
            expect(h.geprueft).toContain('als § 13b eingeordnet: 1, zur Prüfung vorgemerkt: 1');
        });
        await it('no country known anywhere is nicht prüfbar', async () => {
            const [h] = pruefeReverseChargeKandidaten({ year: 2026, zeilen: [rcZeile()], belege: [] });
            expect(h.status).toBe('nicht_pruefbar');
        });
        await it('a Kleinunternehmer is checked too and told the tax is a real cost', async () => {
            const [h] = pruefeReverseChargeKandidaten({
                year: 2026,
                zeilen: [rcZeile({ counterpartyIban: IBAN_IE })],
                belege: [],
                kleinunternehmer: true,
            });
            expect(h.status).toBe('befund');
            expect(h.text).toContain('§ 18 Abs. 4a UStG');
        });
        await it('lists every candidate id (uncapped) so the other checks can leave them alone', async () => {
            const zeilen = Array.from({ length: 25 }, (_, i) =>
                rcZeile({ counterpartyIban: IBAN_IE, bookingDate: `2026-01-${String(i + 1).padStart(2, '0')}` }),
            );
            const r = reverseChargeKandidaten({ year: 2026, zeilen, belege: [] });
            expect(r.ids.size).toBe(25);
            expect(r.hinweise[0].betroffenWeitere).toBe(5);
        });
    });

    await describe('Prüfungen vor der Abgabe — Anlagegut-Kandidat', async () => {
        await it('the GWG limit comes from § 6 Abs. 2 EStG since 2018', async () => {
            expect(abschreibungsGrenzen(2026)).toStrictEqual({ gwg: 800, sammelVon: 250, sammelBis: 1000 });
            expect(abschreibungsGrenzen(2017)).toBe(null);
            expect(gwg([anlage({ bookingDate: '2017-05-01' })], { year: 2017 })[0].status).toBe('nicht_pruefbar');
        });
        await it('an expense above the limit outside the Anlageverzeichnis is a suggestion with a pre-filled dialog', async () => {
            const r = anlage();
            const [h] = gwg([r]);
            expect(h.status).toBe('befund');
            expect(h.key).toBe(`anlagegut-kandidat:${r.id}`);
            expect(h.title).toBe('Anlagegut? Technikhaus Beispiel GmbH, 1.200,00 €');
            const ziel = h.handlungen![0].target;
            expect(ziel).toStrictEqual({
                art: 'dialog',
                dialog: 'anlagegut-erfassen',
                ref: r.id,
                vorbelegung: { bezeichnung: 'Workstation', anschaffung: '2026-05-20', ahk: 1200, buchungIds: [r.id] },
            });
            expect(h.text).not.toContain('Sammelposten');
        });
        await it('exactly at the limit is still a GWG; one cent above is not', async () => {
            expect(gwg([anlage({ net: 800, gross: 952 })])[0].status).toBe('ohne_befund');
            const [h] = gwg([anlage({ net: 800.01, gross: 952.01 })]);
            expect(h.status).toBe('befund');
            expect(h.text).toContain('Sammelposten');
        });
        await it('instalments to the same dealer are one asset', async () => {
            const raten = ['2026-02-15', '2026-03-15', '2026-04-15'].map((d) =>
                anlage({ bookingDate: d, net: 350, gross: 416.5, purpose: 'Rate Plotter' }),
            );
            const hs = gwg(raten);
            expect(hs.length).toBe(1);
            expect(hs[0].betroffen!.length).toBe(3);
            expect(hs[0].text).toContain('3 Raten an Technikhaus Beispiel GmbH (monatlich)');
            const ziel = hs[0].handlungen![0].target as { vorbelegung?: { ahk: number; buchungIds: string[] } };
            expect(ziel.vorbelegung!.ahk).toBe(1050);
            expect(ziel.vorbelegung!.buchungIds.length).toBe(3);
        });
        await it('confirmed laufende Kosten, other categories and captured assets are excluded', async () => {
            const abo = anlage();
            const messe = anlage({ category: '4600 Werbe-/Marketingkosten' });
            const verknuepft = anlage();
            const gleich = anlage({ bookingDate: '2026-06-02' });
            const [h] = gwg([abo, messe, verknuepft, gleich], {
                laufendeKostenIds: new Set([abo.id]),
                anlagen: [
                    { anschaffung: '2026-01-01', ahk: 5, buchungIds: [verknuepft.id] },
                    { anschaffung: '2026-06-10', ahk: 1200 },
                ],
            });
            expect(h.status).toBe('ohne_befund');
            expect(h.geprueft).toContain('im Anlageverzeichnis (2)');
            expect(h.geprueft).toContain('bestätigte laufende Kosten (1)');
            const fern = gwg([anlage()], { anlagen: [{ anschaffung: '2025-01-10', ahk: 1200 }] });
            expect(fern[0].status).toBe('befund');
        });
        await it('a Kleinunternehmer measures gross (§ 9b EStG)', async () => {
            const r = anlage({ net: 800, gross: 952 });
            expect(gwg([r])[0].status).toBe('ohne_befund');
            const [ku] = gwg([r], { kleinunternehmer: true });
            expect(ku.status).toBe('befund');
            expect(ku.text).toContain('brutto');
        });
        await it('a new instalment changes the fingerprint', async () => {
            const a = anlage({ bookingDate: '2026-02-15', net: 900, gross: 1071 });
            const b = anlage({ bookingDate: '2026-02-15', net: 900, gross: 1071 });
            expect(gwg([a])[0].fingerprint === gwg([b])[0].fingerprint).toBe(false);
        });
    });

    await describe('Prüfungen vor der Abgabe — where they surface', async () => {
        const befund = (key: string, level: Hinweis['level'] = 'tipp'): Hinweis => ({
            key,
            level,
            title: key,
            text: '',
            status: 'befund',
            handlungen: [
                { id: 'buchungen', label: 'Buchungen öffnen', target: { art: 'ansicht', ansicht: 'buchungen' } },
            ],
        });
        await it('„Vor der Abgabe klären" takes the four checks and the Geld-Prüfungen warnings with a finding', async () => {
            const hs: Hinweis[] = [
                befund('ust-abweichung'),
                befund('anlagegut-kandidat:g1'),
                befund('reverse-charge-kandidat:x', 'warnung'),
                befund('iban-wechsel:hetzner', 'warnung'),
                { ...befund('ust-ohne-angabe'), status: 'ohne_befund' },
                befund('unklassifiziert', 'warnung'),
                befund('kleinunternehmer', 'warnung'),
            ];
            expect(vorAbgabeHinweise(hs).map((h) => h.key)).toStrictEqual([
                'ust-abweichung',
                'anlagegut-kandidat:g1',
                'reverse-charge-kandidat:x',
                'iban-wechsel:hetzner',
            ]);
        });
        await it('a finding with an action is a task in Als Nächstes', async () => {
            const m = buildHomeModel({
                year: 2026,
                txs: [],
                dashboard: null,
                hinweise: [befund('anlagegut-kandidat:g1')],
            });
            expect(m.tasks.some((t) => t.kind === 'hinweis' && t.ref === 'anlagegut-kandidat:g1')).toBe(true);
        });
        await it('the new words have a glossary entry', async () => {
            for (const k of ['anlagegut-kandidat', 'reverse-charge', 'gwg']) expect(!!GLOSSARY[k]).toBe(true);
        });
    });
};
