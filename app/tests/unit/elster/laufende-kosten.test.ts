import { describe, it, expect } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    erkenneLaufendeKosten,
    erwarteteZahlungen,
    istSerienPaar,
    laufendeKostenIds,
    laufendeKostenUebersicht,
    preisaenderungHinweise,
    LAUFENDE_KOSTEN_MIN_TREFFER,
    type LkBuchung,
    type LkEntscheidung,
} from '../../../src/core/elster/laufende-kosten.ts';
import { pruefeDoppelteRechnungen, type RechnungsBeleg } from '../../../src/core/elster/doppelte-rechnung.ts';
import { pruefeLieferantDoppeltBezahlt } from '../../../src/core/elster/lieferant-doppelt-bezahlt.ts';
import { computeFreiVerfuegbar, FAELLIG_FENSTER_TAGE } from '../../../src/core/elster/frei-verfuegbar.ts';
import { buildHomeModel } from '../../../src/core/elster/home.ts';
import { GLOSSARY } from '../../../src/core/lib/glossary.ts';
import { loadLaufendeKostenEntscheidungen, saveLaufendeKostenEntscheidung } from '../../../src/core/config/index.ts';

// Invented parties and amounts only.
let n = 0;
const ab = (bookingDate: string, amount: number, counterparty = 'Muster Software GmbH'): LkBuchung => ({
    id: `t${n++}`,
    bookingDate,
    amount,
    counterparty,
});
const monate = (von: number, bis: number, jahr: number, tag: string, betrag: number, wer?: string) =>
    Array.from({ length: bis - von + 1 }, (_, i) =>
        ab(`${jahr}-${String(von + i).padStart(2, '0')}-${tag}`, betrag, wer),
    );

const entscheide = (
    key: string,
    status: LkEntscheidung['status'],
    over: Partial<LkEntscheidung> = {},
): LkEntscheidung => ({
    key,
    status,
    ...over,
});

export default async () => {
    await describe('laufende Kosten — erkennen', async () => {
        await it('finds a monthly series despite a few days of jitter, with last paid and next expected', async () => {
            const k = erkenneLaufendeKosten([
                ab('2025-01-01', -500, 'Hausverwaltung Beispiel'),
                ab('2025-02-03', -500, 'Hausverwaltung Beispiel'),
                ab('2025-02-28', -500, 'Hausverwaltung Beispiel'),
                ab('2025-04-02', -500, 'Hausverwaltung Beispiel'),
            ]);
            expect(k.length).toBe(1);
            expect(k[0].key).toBe('hausverwaltungbeispiel:monatlich');
            expect(k[0].abstand).toBe('monatlich');
            expect(k[0].betrag).toBe(500);
            expect(k[0].zuletzt).toBe('2025-04-02');
            expect(k[0].naechste).toBe('2025-05-02');
            expect(k[0].aktiv).toBe(true);
            expect(k[0].status).toBe('vorschlag');
            expect(k[0].zahlungen.length).toBe(4);
        });

        await it('recognises quarterly, half-yearly and yearly intervals', async () => {
            const q = erkenneLaufendeKosten([ab('2025-01-15', -90), ab('2025-04-14', -90), ab('2025-07-16', -90)]);
            expect(q.map((x) => x.abstand)).toStrictEqual(['vierteljaehrlich']);
            const h = erkenneLaufendeKosten([ab('2025-03-10', -40), ab('2025-09-12', -40)]);
            expect(h.map((x) => x.abstand)).toStrictEqual(['halbjaehrlich']);
            const y = erkenneLaufendeKosten([ab('2024-03-01', -289.17), ab('2025-03-03', -289.17)]);
            expect(y.map((x) => x.abstand)).toStrictEqual(['jaehrlich']);
            expect(y[0].naechste).toBe('2026-03-03');
        });

        await it('needs three hits monthly and quarterly, two yearly — and nothing off the beat', async () => {
            expect(LAUFENDE_KOSTEN_MIN_TREFFER.jaehrlich).toBe(2);
            expect(erkenneLaufendeKosten([ab('2025-01-05', -20), ab('2025-02-05', -20)]).length).toBe(0);
            expect(erkenneLaufendeKosten([ab('2025-01-05', -20), ab('2025-04-05', -20)]).length).toBe(0);
            expect(erkenneLaufendeKosten([ab('2024-03-01', -289)]).length).toBe(0);
            expect(
                erkenneLaufendeKosten([ab('2025-01-05', -20), ab('2025-02-20', -20), ab('2025-04-01', -20)]).length,
            ).toBe(0);
        });

        await it('ignores credits — an incoming series is no cost', async () => {
            expect(erkenneLaufendeKosten(monate(1, 6, 2025, '15', 1200, 'Kunde Beispiel')).length).toBe(0);
        });

        await it('keeps a series through a price change and reports from → to with its date', async () => {
            const k = erkenneLaufendeKosten([...monate(1, 5, 2025, '14', -29.75), ...monate(6, 12, 2025, '14', -35.7)]);
            expect(k.length).toBe(1);
            expect(k[0].preisaenderung).toStrictEqual({
                von: 29.75,
                auf: 35.7,
                datum: '2025-06-14',
                id: k[0].zahlungen[5].id,
            });
            expect(k[0].letzterBetrag).toBe(35.7);
            expect(k[0].betrag).toBe(35.7);
            expect(k[0].typischerBetrag).toBe(35.7);
        });

        await it('starts a second series for an amount beyond the drift, keyed apart', async () => {
            const k = erkenneLaufendeKosten([...monate(1, 4, 2025, '03', -10), ...monate(1, 4, 2025, '05', -60)]);
            expect(k.length).toBe(2);
            expect(k.map((x) => x.key).sort()).toStrictEqual([
                'mustersoftwaregmbh:monatlich:1000',
                'mustersoftwaregmbh:monatlich:6000',
            ]);
        });

        await it('groups by the normalised name, as the Geld-Prüfungen do', async () => {
            const k = erkenneLaufendeKosten([
                ab('2025-01-07', -12.44, 'CLOUD-PROVIDER EU'),
                ab('2025-02-07', -12.44, 'Cloud-Provider EU'),
                ab('2025-03-07', -12.44, 'cloud provider eu'),
            ]);
            expect(k.length).toBe(1);
            expect(k[0].empfaenger).toBe('cloud provider eu');
        });

        await it('marks a series „beendet?" after 1.5 intervals without payment, measured against the data', async () => {
            const serie = monate(1, 4, 2025, '01', -50);
            // Newest booking 10 May: 39 days after the last payment → still active.
            expect(erkenneLaufendeKosten([...serie, ab('2025-05-10', 99, 'Kunde')])[0].aktiv).toBe(true);
            // Newest booking 20 May: 49 days > 1.5 × 30 → stopped.
            expect(erkenneLaufendeKosten([...serie, ab('2025-05-20', 99, 'Kunde')])[0].aktiv).toBe(false);
            // A yearly one is not stopped after a few months.
            expect(
                erkenneLaufendeKosten([ab('2024-03-01', -289), ab('2025-03-03', -289), ab('2025-11-01', 5, 'X')])[0]
                    .aktiv,
            ).toBe(true);
        });
    });

    await describe('laufende Kosten — Entscheidungen', async () => {
        const buchungen = [
            ...monate(1, 6, 2025, '01', -500, 'Hausverwaltung'),
            ...monate(1, 6, 2025, '12', -87, 'Markt'),
        ];

        await it('splits into proposals, confirmed, rejected and ended', async () => {
            const u = laufendeKostenUebersicht(buchungen, [
                entscheide('hausverwaltung:monatlich', 'bestaetigt'),
                entscheide('markt:monatlich', 'abgelehnt'),
            ]);
            expect(u.vorschlaege.length).toBe(0);
            expect(u.bestaetigt.map((k) => k.key)).toStrictEqual(['hausverwaltung:monatlich']);
            expect(u.abgelehnt.map((k) => k.key)).toStrictEqual(['markt:monatlich']);
            const e = laufendeKostenUebersicht(buchungen, [entscheide('markt:monatlich', 'beendet')]);
            expect(e.beendet.length).toBe(1);
            expect(e.vorschlaege.length).toBe(1);
        });

        await it('applies a correction of interval and amount to the next date and amount', async () => {
            const u = laufendeKostenUebersicht(buchungen, [
                entscheide('hausverwaltung:monatlich', 'bestaetigt', { abstand: 'vierteljaehrlich', betrag: 520 }),
            ]);
            const k = u.bestaetigt[0];
            expect(k.abstand).toBe('vierteljaehrlich');
            expect(k.erkannterAbstand).toBe('monatlich');
            expect(k.betrag).toBe(520);
            expect(k.naechste).toBe('2025-09-01');
            expect(k.korrigiert).toBe(true);
        });

        await it('persists per entity in the manifest and takes a decision back', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'bh-lk-'));
            const path = join(dir, 'steuererklaerung.json');
            try {
                writeFileSync(
                    path,
                    JSON.stringify({
                        version: 1,
                        entities: [{ id: 'test', name: 'Test', kind: 'privat', accounts: [] }],
                    }),
                );
                saveLaufendeKostenEntscheidung(
                    'test',
                    'markt:monatlich',
                    entscheide('markt:monatlich', 'abgelehnt'),
                    path,
                );
                saveLaufendeKostenEntscheidung(
                    'test',
                    'hausverwaltung:monatlich',
                    entscheide('hausverwaltung:monatlich', 'bestaetigt', { entschieden_am: '2025-07-01' }),
                    path,
                );
                saveLaufendeKostenEntscheidung(
                    'test',
                    'markt:monatlich',
                    entscheide('markt:monatlich', 'beendet'),
                    path,
                );
                const list = loadLaufendeKostenEntscheidungen('test', path);
                expect(list.length).toBe(2);
                expect(list.find((d) => d.key === 'markt:monatlich')!.status).toBe('beendet');
                saveLaufendeKostenEntscheidung('test', 'markt:monatlich', null, path);
                saveLaufendeKostenEntscheidung('test', 'hausverwaltung:monatlich', null, path);
                expect(loadLaufendeKostenEntscheidungen('test', path).length).toBe(0);
                expect(JSON.parse(readFileSync(path, 'utf8')).entities[0].laufende_kosten).toBe(undefined);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        await it('raises a Preisänderung only for a change after the confirmation, in its year', async () => {
            const b = [...monate(1, 6, 2025, '14', -29.75), ...monate(7, 9, 2025, '14', -35.7)];
            const key = 'mustersoftwaregmbh:monatlich';
            const vorher = laufendeKostenUebersicht(b, [
                entscheide(key, 'bestaetigt', { entschieden_am: '2025-03-01' }),
            ]);
            const h = preisaenderungHinweise(vorher.bestaetigt, 2025);
            expect(h.length).toBe(1);
            expect(h[0].title).toBe('Preisänderung bei Muster Software GmbH');
            expect(h[0].status).toBe('befund');
            expect(h[0].handlungen!.map((x) => x.id)).toStrictEqual(['buchung', 'in-ordnung']);
            expect(preisaenderungHinweise(vorher.bestaetigt, 2026).length).toBe(0);
            const nachher = laufendeKostenUebersicht(b, [
                entscheide(key, 'bestaetigt', { entschieden_am: '2025-08-01' }),
            ]);
            expect(preisaenderungHinweise(nachher.bestaetigt, 2025).length).toBe(0);
        });
    });

    await describe('laufende Kosten — Frei verfügbar', async () => {
        const STICHTAG = '2025-07-10';
        const buchungen = [
            ...monate(1, 7, 2025, '01', -500, 'Hausverwaltung'),
            ...monate(1, 7, 2025, '05', -20, 'Software'),
            ab('2023-07-19', -300, 'Versicherung'),
            ab('2024-07-20', -300, 'Versicherung'),
        ];
        const input = (entscheidungen: LkEntscheidung[]) => {
            const u = laufendeKostenUebersicht(buchungen, entscheidungen);
            return computeFreiVerfuegbar({
                stichtag: STICHTAG,
                entityId: 'e',
                entityName: 'E',
                konten: [{ name: 'Konto', accountKey: 'k', saldo: 5000, letzteBuchung: '2025-07-05' }],
                ust: { status: 'entfaellt', grund: 'x' },
                steuerzahlungen: { status: 'ok', daten: [] },
                eingangsrechnungen: { status: 'ok', daten: { regel: 'r', posten: [] } },
                laufendeKosten: { status: 'ok', daten: { bestaetigt: u.bestaetigt, offen: u.vorschlaege.length } },
                ruecklage: {
                    jahr: 2025,
                    est: { status: 'entfaellt', grund: 'x' },
                    gewst: { status: 'entfaellt', grund: 'x' },
                },
            });
        };
        const term = (m: ReturnType<typeof input>) => m.freiVerfuegbar.terme.find((t) => t.key === 'laufende-kosten')!;

        await it('deducts nothing for unconfirmed proposals, but names them', async () => {
            const m = input([]);
            expect(term(m).betrag).toBe(0);
            expect(m.freiVerfuegbar.betrag).toBe(5000);
            expect(term(m).zeilen.some((z) => z.label.startsWith('3 erkannte Serien noch nicht bestätigt'))).toBe(true);
        });

        await it(`deducts each expected payment of a confirmed series within ${FAELLIG_FENSTER_TAGE} days`, async () => {
            const m = input([
                entscheide('hausverwaltung:monatlich', 'bestaetigt'),
                entscheide('versicherung:jaehrlich', 'bestaetigt'),
                entscheide('software:monatlich', 'abgelehnt'),
            ]);
            const t = term(m);
            expect(t.label).toBe(`Laufende Kosten (nächste ${FAELLIG_FENSTER_TAGE} Tage)`);
            // Rent 1 Aug (within 30 days of 10 Jul) + insurance 20 Jul; rent 1 Sep is outside.
            expect(t.betrag).toBe(800);
            expect(t.zeilen.filter((z) => z.betrag != null && z.label !== t.zeilen[0].label).length).toBe(2);
            expect(m.freiVerfuegbar.betrag).toBe(4200);
            expect(m.freiVerfuegbar.formel).toContain('laufende Kosten');
        });

        await it('keeps the first-version figure visible in the derivation', async () => {
            const t = term(input([entscheide('hausverwaltung:monatlich', 'bestaetigt')]));
            expect(t.zeilen[0].label).toBe('Frei verfügbar ohne laufende Kosten (erste Fassung)');
            expect(t.zeilen[0].betrag).toBe(5000);
        });

        await it('counts an expected payment that is overdue but not booked yet', async () => {
            const lk = laufendeKostenUebersicht(buchungen, [entscheide('hausverwaltung:monatlich', 'bestaetigt')])
                .bestaetigt[0];
            const z = erwarteteZahlungen(lk, '2025-08-03', 30);
            expect(z.map((x) => x.datum)).toStrictEqual(['2025-08-01', '2025-09-01']);
            expect(z[0].ueberfaellig).toBe(true);
        });

        await it('tells a missed payment from one after the last import', async () => {
            const lk = laufendeKostenUebersicht(buchungen, [entscheide('hausverwaltung:monatlich', 'bestaetigt')])
                .bestaetigt[0];
            // Import up to 15 Jul, Stichtag 10 Oct: Aug and Sep are after the import, not „missed".
            const z = erwarteteZahlungen(lk, '2025-10-10', 30, '2025-07-15');
            expect(z.map((x) => x.datum)).toStrictEqual(['2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01']);
            expect(z.map((x) => x.ueberfaellig)).toStrictEqual([false, false, false, false]);
            expect(z.map((x) => x.nachDatenstand)).toStrictEqual([true, true, true, false]);
            const m = computeFreiVerfuegbar({
                stichtag: '2025-10-10',
                entityId: 'e',
                entityName: 'E',
                konten: [{ name: 'Konto', accountKey: 'k', saldo: 5000, letzteBuchung: '2025-07-15' }],
                ust: { status: 'entfaellt', grund: 'x' },
                steuerzahlungen: { status: 'ok', daten: [] },
                eingangsrechnungen: { status: 'ok', daten: { regel: 'r', posten: [] } },
                laufendeKosten: { status: 'ok', daten: { bestaetigt: [lk], offen: 0, datenstand: '2025-07-15' } },
                ruecklage: {
                    jahr: 2025,
                    est: { status: 'entfaellt', grund: 'x' },
                    gewst: { status: 'entfaellt', grund: 'x' },
                },
            });
            const t = m.freiVerfuegbar.terme.find((x) => x.key === 'laufende-kosten')!;
            expect(t.betrag).toBe(2000);
            expect(
                t.zeilen.some((x) =>
                    x.label.startsWith('Umsätze nur bis 15.07.2025 importiert: 3 erwartete Zahlungen'),
                ),
            ).toBe(true);
            expect(t.zeilen.some((x) => (x.herkunft ?? '').includes('nach dem letzten Import'))).toBe(true);
        });

        await it('does not deduct a confirmed series that has stopped', async () => {
            const alt = [...monate(1, 4, 2025, '01', -500, 'Hausverwaltung'), ab('2025-07-05', 10, 'Kunde')];
            const u = laufendeKostenUebersicht(alt, [entscheide('hausverwaltung:monatlich', 'bestaetigt')]);
            expect(u.bestaetigt[0].aktiv).toBe(false);
            const m = computeFreiVerfuegbar({
                stichtag: STICHTAG,
                entityId: 'e',
                entityName: 'E',
                konten: [{ name: 'Konto', accountKey: 'k', saldo: 100, letzteBuchung: null }],
                ust: { status: 'entfaellt', grund: 'x' },
                steuerzahlungen: { status: 'ok', daten: [] },
                eingangsrechnungen: { status: 'ok', daten: { regel: 'r', posten: [] } },
                laufendeKosten: { status: 'ok', daten: { bestaetigt: u.bestaetigt, offen: 0 } },
                ruecklage: {
                    jahr: 2025,
                    est: { status: 'entfaellt', grund: 'x' },
                    gewst: { status: 'entfaellt', grund: 'x' },
                },
            });
            const t = m.freiVerfuegbar.terme.find((x) => x.key === 'laufende-kosten')!;
            expect(t.betrag).toBe(0);
            expect(t.zeilen.some((z) => (z.herkunft ?? '').startsWith('beendet?'))).toBe(true);
        });
    });

    await describe('laufende Kosten — weniger Fehlalarme in den Geld-Prüfungen', async () => {
        const beleg = (created: string, over: Partial<RechnungsBeleg> = {}): RechnungsBeleg => ({
            id: `b${n++}`,
            direction: 'incoming',
            correspondent: 'Muster Software',
            invoiceNumber: null,
            gross: 35.7,
            created,
            linkedTxIds: [],
            ...over,
        });
        const bank = [...monate(1, 2, 2025, '14', -29.75), ...monate(3, 6, 2025, '14', -35.7)];
        const bestaetigt = laufendeKostenUebersicht(bank, [
            entscheide('mustersoftwaregmbh:monatlich', 'bestaetigt'),
        ]).bestaetigt;

        await it('two invoices one month apart of a confirmed subscription are no Doppelte Rechnung', async () => {
            const belege = [beleg('2025-05-14'), beleg('2025-06-13')];
            const ohne = pruefeDoppelteRechnungen({ year: 2025, belege });
            expect(ohne[0].status).toBe('befund');
            const mit = pruefeDoppelteRechnungen({ year: 2025, belege, laufendeKosten: bestaetigt });
            expect(mit[0].status).toBe('ohne_befund');
            expect(mit[0].geprueft).toContain('bestätigte laufende Kosten: 1 Paar(e)');
        });

        await it('a copy a few days later still is a finding', async () => {
            expect(istSerienPaar(bestaetigt, 'Muster Software', 35.7, '2025-06-13', '2025-06-16')).toBe(false);
            const h = pruefeDoppelteRechnungen({
                year: 2025,
                belege: [beleg('2025-06-13'), beleg('2025-06-16')],
                laufendeKosten: bestaetigt,
            });
            expect(h[0].status).toBe('befund');
        });

        await it('payments of a confirmed series quoting one contract number are no Lieferant doppelt bezahlt', async () => {
            // A price change breaks the exact-amount series of Idee 7; the confirmed one holds.
            const zahlungen = [
                {
                    id: 'z1',
                    bookingDate: '2025-02-14',
                    amount: -29.75,
                    counterparty: 'Muster Software GmbH',
                    purpose: 'Vertrag MS-77',
                },
                {
                    id: 'z2',
                    bookingDate: '2025-03-14',
                    amount: -35.7,
                    counterparty: 'Muster Software GmbH',
                    purpose: 'Vertrag MS-77',
                },
                {
                    id: 'z3',
                    bookingDate: '2025-04-14',
                    amount: -35.7,
                    counterparty: 'Muster Software GmbH',
                    purpose: 'Vertrag MS-77',
                },
            ];
            const lk = laufendeKostenUebersicht(zahlungen, [
                entscheide('mustersoftwaregmbh:monatlich', 'bestaetigt'),
            ]).bestaetigt;
            const belege = [beleg('2025-02-01', { invoiceNumber: 'MS-77', gross: 35.7 })];
            const ohne = pruefeLieferantDoppeltBezahlt({ year: 2025, belege, buchungen: zahlungen });
            expect(ohne[0].status).toBe('befund');
            const mit = pruefeLieferantDoppeltBezahlt({
                year: 2025,
                belege,
                buchungen: zahlungen,
                laufendeKostenIds: laufendeKostenIds(lk),
            });
            expect(mit[0].status).toBe('ohne_befund');
            expect(mit[0].geprueft).toContain('bestätigte laufende Kosten (1)');
        });
    });

    await describe('laufende Kosten — Als Nächstes und Glossar', async () => {
        await it('one task for all undecided series, none when everything is decided', async () => {
            const m = buildHomeModel({ year: 2025, txs: [], dashboard: null, laufendeKostenOffen: 3 });
            const t = m.tasks.filter((x) => x.kind === 'laufende-kosten');
            expect(t.length).toBe(1);
            expect(t[0].title).toBe('3 laufende Kosten zu bestätigen');
            expect(buildHomeModel({ year: 2025, txs: [], dashboard: null, laufendeKostenOffen: 0 }).tasks.length).toBe(
                0,
            );
        });

        await it('the glossary sets it apart from the wiederkehrende Rechnungen', async () => {
            expect(GLOSSARY['laufende-kosten'].text).toContain('wiederkehrenden Rechnungen');
        });
    });
};
