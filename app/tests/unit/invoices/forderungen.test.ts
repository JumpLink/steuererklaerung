import { describe, it, expect } from '@gjsify/unit';
import {
    ALTER_KLASSEN,
    alterKlasse,
    altersUebersicht,
    type ForderungMahnung,
    type ForderungRechnung,
    type ForderungZahlung,
    offenePosten,
    verjaehrung,
    zahlungsverhalten,
} from '../../../src/core/invoices/forderungen.ts';
import { verjaehrungHinweise } from '../../../src/core/invoices/forderungen-hinweis.ts';
import { mahnungEntwurf } from '../../../src/core/invoices/mahnung-text.ts';
import { zahlungenZuRechnungen, markiereMahnungVersandt } from '../../../src/core/actions/forderungen.ts';

// Invented data only: fake customers, round amounts, fake ids.
const inv = (over: Partial<ForderungRechnung>): ForderungRechnung => ({
    id: 'inv-1',
    number: 'RE-2026-0001',
    customer: 'Muster & Partner GbR',
    gross: 1000,
    currency: 'EUR',
    issueDate: '2026-03-01',
    dueDate: '2026-03-15',
    status: 'open',
    paidOn: null,
    ...over,
});
const paid = (id: string, due: string, paidOn: string, customer = 'Muster & Partner GbR'): ForderungRechnung =>
    inv({ id, number: `RE-${id}`, status: 'paid', dueDate: due, issueDate: due, paidOn, customer });

const TODAY = '2026-10-09';

export default async () => {
    await describe('zahlungsverhalten', async () => {
        await it('days = payment date − due date; mean, worst case and early payments (negative)', async () => {
            const v = zahlungsverhalten(
                [
                    paid('a', '2026-01-10', '2026-01-20'), // +10
                    paid('b', '2026-02-10', '2026-02-08'), // −2
                    paid('c', '2026-03-10', '2026-03-25'), // +15
                ],
                [],
            );
            expect(v.length).toBe(1);
            expect(v[0].kunde).toBe('Muster & Partner GbR');
            expect(v[0].anzahl).toBe(3);
            expect(v[0].mittel).toBe(7.7);
            expect(v[0].schlimmster).toBe(15);
            expect(v[0].trend).toBe(null); // fewer than 4 paid invoices: too little to compare
        });

        await it('trend: last 2 against all earlier ones, threshold 3 days', async () => {
            const slower = zahlungsverhalten(
                [
                    paid('a', '2026-01-10', '2026-01-10'), // 0
                    paid('b', '2026-02-10', '2026-02-11'), // +1
                    paid('c', '2026-03-10', '2026-03-20'), // +10
                    paid('d', '2026-04-10', '2026-04-24'), // +14
                ],
                [],
            );
            expect(slower[0].trend).toBe('langsamer');
            expect(slower[0].mittelFrueher).toBe(0.5);
            expect(slower[0].mittelLetzte).toBe(12);

            const faster = zahlungsverhalten(
                [
                    paid('a', '2026-01-10', '2026-01-25'),
                    paid('b', '2026-02-10', '2026-02-25'),
                    paid('c', '2026-03-10', '2026-03-11'),
                    paid('d', '2026-04-10', '2026-04-10'),
                ],
                [],
            );
            expect(faster[0].trend).toBe('schneller');

            const same = zahlungsverhalten(
                [
                    paid('a', '2026-01-10', '2026-01-20'),
                    paid('b', '2026-02-10', '2026-02-20'),
                    paid('c', '2026-03-10', '2026-03-21'),
                    paid('d', '2026-04-10', '2026-04-19'),
                ],
                [],
            );
            expect(same[0].trend).toBe('gleich');
        });

        await it('groups customers case-insensitively and lists the slowest payer first', async () => {
            const v = zahlungsverhalten(
                [
                    paid('a', '2026-01-10', '2026-01-12', 'Schnell GmbH'),
                    paid('b', '2026-02-10', '2026-02-12', 'schnell gmbh'),
                    paid('c', '2026-01-10', '2026-02-20', 'Langsam AG'),
                ],
                [],
            );
            expect(v.map((x) => x.kunde)).toStrictEqual(['Langsam AG', 'Schnell GmbH']);
            expect(v[1].anzahl).toBe(2);
        });

        await it('partial payments: only the payment that completes the amount dates the invoice', async () => {
            const rechnung = inv({ id: 'p', status: 'paid', dueDate: '2026-05-10', paidOn: null, gross: 1000 });
            const zahlungen: ForderungZahlung[] = [
                { rechnungId: 'p', date: '2026-05-12', amount: 400 }, // alone it settles nothing
                { rechnungId: 'p', date: '2026-06-09', amount: 600 },
            ];
            const v = zahlungsverhalten([rechnung], zahlungen);
            expect(v[0].mittel).toBe(30); // 10.05. → 09.06.
        });

        await it('a „bezahlt" date wins over the credits; an undated paid invoice is left out', async () => {
            const dated = inv({ id: 'p', status: 'paid', dueDate: '2026-05-10', paidOn: '2026-05-15' });
            const zahlungen: ForderungZahlung[] = [{ rechnungId: 'p', date: '2026-06-20', amount: 1000 }];
            expect(zahlungsverhalten([dated], zahlungen)[0].mittel).toBe(5);
            const undated = inv({ id: 'q', status: 'paid', dueDate: '2026-05-10', paidOn: null });
            expect(zahlungsverhalten([undated], [])).toStrictEqual([]);
        });
    });

    await describe('Alter der offenen Posten', async () => {
        await it('bucket boundaries: due today is not overdue; 30/31, 60/61, 90/91', async () => {
            expect(alterKlasse(null)).toBe('nicht_faellig');
            expect(alterKlasse(-5)).toBe('nicht_faellig');
            expect(alterKlasse(0)).toBe('nicht_faellig');
            expect(alterKlasse(1)).toBe('tage_1_30');
            expect(alterKlasse(30)).toBe('tage_1_30');
            expect(alterKlasse(31)).toBe('tage_31_60');
            expect(alterKlasse(60)).toBe('tage_31_60');
            expect(alterKlasse(61)).toBe('tage_61_90');
            expect(alterKlasse(90)).toBe('tage_61_90');
            expect(alterKlasse(91)).toBe('ueber_90');
            expect(ALTER_KLASSEN.length).toBe(5);
        });

        await it('sums per bucket, per customer and in total; most overdue first', async () => {
            const { posten } = offenePosten(
                [
                    inv({ id: 'a', number: 'A', customer: 'Kunde A', gross: 100, dueDate: '2026-10-09' }), // today: not yet
                    inv({ id: 'b', number: 'B', customer: 'Kunde A', gross: 200, dueDate: '2026-09-09' }), // 30
                    inv({ id: 'c', number: 'C', customer: 'Kunde B', gross: 300, dueDate: '2026-09-08' }), // 31
                    inv({ id: 'd', number: 'D', customer: 'Kunde B', gross: 400, dueDate: '2026-01-01' }), // >90
                    inv({ id: 'e', number: 'E', customer: 'Kunde A', gross: 50, status: 'paid', paidOn: '2026-09-01' }),
                    inv({ id: 'f', number: 'F', customer: 'Kunde A', gross: 70, status: 'draft' }),
                ],
                [],
                [],
                TODAY,
            );
            expect(posten.map((p) => p.nummer)).toStrictEqual(['D', 'C', 'B', 'A']);
            const u = altersUebersicht(posten);
            const summe = (k: string) => u.klassen.find((x) => x.key === k)?.summe;
            expect(summe('nicht_faellig')).toBe(100);
            expect(summe('tage_1_30')).toBe(200);
            expect(summe('tage_31_60')).toBe(300);
            expect(summe('tage_61_90')).toBe(0);
            expect(summe('ueber_90')).toBe(400);
            expect(u.gesamt).toStrictEqual({ anzahl: 4, summe: 1000 });
            expect(u.kunden.map((k) => [k.kunde, k.gesamt])).toStrictEqual([
                ['Kunde B', 700],
                ['Kunde A', 300],
            ]);
            expect(u.kunden[0].summen.ueber_90).toBe(400);
        });

        await it('partial payment: the rest is owed and aged; full coverage is „vermutlich bezahlt", not chased', async () => {
            const rechnungen = [
                inv({ id: 'a', number: 'RE-A-0001', gross: 1000, dueDate: '2026-08-01' }),
                inv({ id: 'b', number: 'RE-B-0001', gross: 500, dueDate: '2026-08-01' }),
            ];
            const zahlungen: ForderungZahlung[] = [
                { rechnungId: 'a', date: '2026-08-10', amount: 400 },
                { rechnungId: 'b', date: '2026-08-10', amount: 500 },
            ];
            const r = offenePosten(rechnungen, zahlungen, [], TODAY);
            expect(r.posten.length).toBe(1);
            expect(r.posten[0].bezahlt).toBe(400);
            expect(r.posten[0].offen).toBe(600);
            expect(r.vermutlichBezahlt.map((x) => x.nummer)).toStrictEqual(['RE-B-0001']);
        });

        await it('credits are matched by invoice number; a credit naming two invoices counts for neither', async () => {
            const rechnungen = [inv({ id: 'a', number: 'RE-2026-0001' }), inv({ id: 'b', number: 'RE-2026-0002' })];
            const z = zahlungenZuRechnungen(rechnungen, [
                { bookingDate: '2026-04-01', amount: 100, purpose: 'Rate zu RE-2026-0001' },
                { bookingDate: '2026-04-02', amount: 900, purpose: 'RE-2026-0001 und RE-2026-0002' },
                { bookingDate: '2026-04-03', amount: -50, purpose: 'RE-2026-0002 Rückzahlung' },
            ]);
            expect(z).toStrictEqual([{ rechnungId: 'a', date: '2026-04-01', amount: 100 }]);
        });
    });

    await describe('Mahnstufe', async () => {
        const rechnung = inv({ id: 'a', dueDate: '2026-08-01' });
        const row = (stufe: 1 | 2 | 3, over: Partial<ForderungMahnung> = {}): ForderungMahnung => ({
            rechnungId: 'a',
            stufe,
            entworfenAm: null,
            versandtAm: null,
            ...over,
        });

        await it('starts at 0 with stage 1 due once overdue', async () => {
            const p = offenePosten([rechnung], [], [], TODAY).posten[0];
            expect(p.mahnstufe).toBe(0);
            expect(p.naechsteStufe).toBe(1);
            expect(p.mahnungFaellig).toBe(true);
            const notDue = offenePosten([inv({ dueDate: '2026-10-09' })], [], [], TODAY).posten[0];
            expect(notDue.mahnungFaellig).toBe(false);
        });

        await it('a draft alone changes nothing: the stage only counts once confirmed as sent', async () => {
            const p = offenePosten([rechnung], [], [row(1, { entworfenAm: '2026-10-08T10:00:00Z' })], TODAY).posten[0];
            expect(p.mahnstufe).toBe(0);
            expect(p.letzteMahnungAm).toBe(null);
            expect(p.entworfenStufe).toBe(1);
            expect(p.naechsteStufe).toBe(1);
        });

        await it('progression 1 → 2 → 3 with a 14-day gap, and nothing after the last stage', async () => {
            const nach1 = offenePosten([rechnung], [], [row(1, { versandtAm: '2026-10-01' })], TODAY).posten[0];
            expect(nach1.mahnstufe).toBe(1);
            expect(nach1.naechsteStufe).toBe(2);
            expect(nach1.mahnungFaellig).toBe(false); // 8 days since stage 1

            const spaeter = offenePosten([rechnung], [], [row(1, { versandtAm: '2026-09-20' })], TODAY).posten[0];
            expect(spaeter.mahnungFaellig).toBe(true); // 19 days

            const nach3 = offenePosten(
                [rechnung],
                [],
                [
                    row(1, { versandtAm: '2026-08-20' }),
                    row(2, { versandtAm: '2026-09-05' }),
                    row(3, { versandtAm: '2026-09-22' }),
                ],
                TODAY,
            ).posten[0];
            expect(nach3.mahnstufe).toBe(3);
            expect(nach3.naechsteStufe).toBe(null);
            expect(nach3.mahnungFaellig).toBe(false);
            expect(nach3.letzteMahnungAm).toBe('2026-09-22');
        });

        await it('markiereMahnungVersandt refuses a stage that does not exist, before touching anything', async () => {
            let message = '';
            try {
                await markiereMahnungVersandt('gbr', 'x', 4);
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message).toBe('Mahnstufe 4 gibt es nicht (1–3).');
        });
    });

    await describe('Mahnung-Entwurf', async () => {
        const basis = {
            nummer: 'RE-2026-0007',
            kunde: 'Muster & Partner GbR',
            issueDate: '2026-03-01',
            dueDate: '2026-03-15',
            brutto: 1190,
            bezahlt: 0,
            currency: 'EUR',
            heute: '2026-10-09',
            fruehere: [] as { stufe: 1 | 2; versandtAm: string }[],
        };

        await it('names the invoice number, date, amount, due date and a deadline — in every stage', async () => {
            for (const stufe of [1, 2, 3] as const) {
                const d = mahnungEntwurf({
                    ...basis,
                    stufe,
                    fruehere: [
                        { stufe: 1, versandtAm: '2026-09-01' },
                        { stufe: 2, versandtAm: '2026-09-20' },
                    ],
                });
                expect(d.text).toContain('RE-2026-0007');
                expect(d.text).toContain('01.03.2026');
                expect(d.text).toContain('15.03.2026');
                expect(d.text).toContain('1.190,00 €');
                expect(d.text).toContain('16.10.2026'); // 7 days after the draft date
                expect(d.zahlungsfrist).toBe('2026-10-16');
            }
        });

        await it('tone rises and quotes the earlier reminders; no interest or fee is stated', async () => {
            const fruehere: { stufe: 1 | 2; versandtAm: string }[] = [
                { stufe: 1, versandtAm: '2026-09-01' },
                { stufe: 2, versandtAm: '2026-09-20' },
            ];
            const s1 = mahnungEntwurf({ ...basis, stufe: 1 });
            const s2 = mahnungEntwurf({ ...basis, stufe: 2, fruehere });
            const s3 = mahnungEntwurf({ ...basis, stufe: 3, fruehere });
            expect(s1.betreff).toBe('Zahlungserinnerung: Rechnung RE-2026-0007');
            expect(s2.betreff).toBe('Mahnung: Rechnung RE-2026-0007');
            expect(s3.betreff).toBe('Letzte Mahnung: Rechnung RE-2026-0007');
            expect(s2.text).toContain('Zahlungserinnerung vom 01.09.2026');
            expect(s3.text).toContain('Mahnung vom 20.09.2026');
            for (const d of [s1, s2, s3]) {
                expect(d.text.includes('Zinsen')).toBe(false);
                expect(d.text.includes('Gebühr')).toBe(false);
                expect(d.text.includes('Inkasso')).toBe(false);
            }
        });

        await it('a partial payment is named and only the rest is asked for', async () => {
            const d = mahnungEntwurf({ ...basis, stufe: 1, bezahlt: 190 });
            expect(d.text).toContain('Rechnungsbetrag: 1.190,00 €');
            expect(d.text).toContain('Bereits eingegangen: 190,00 €');
            expect(d.text).toContain('Offen: 1.000,00 €');
        });

        await it('refuses an invoice that is not yet due', async () => {
            let message = '';
            try {
                mahnungEntwurf({ ...basis, stufe: 1, dueDate: '2026-10-09' });
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message).toBe('Die Rechnung ist noch nicht fällig.');
        });
    });

    await describe('Verjährung', async () => {
        await it('ends 31 December of the third year after the year the claim arose', async () => {
            expect(verjaehrung({ issueDate: '2023-01-15', dueDate: null }, TODAY)?.handelnBis).toBe('2026-12-31');
            expect(verjaehrung({ issueDate: '2023-12-31', dueDate: null }, TODAY)?.handelnBis).toBe('2026-12-31');
            expect(verjaehrung({ issueDate: '2024-01-01', dueDate: null }, TODAY)?.handelnBis).toBe('2027-12-31');
        });

        await it('the earlier of issue and due date counts (never later than the real one)', async () => {
            const v = verjaehrung({ issueDate: '2023-12-20', dueDate: '2024-01-10' }, TODAY);
            expect(v?.anspruchsjahr).toBe(2023);
            expect(v?.handelnBis).toBe('2026-12-31');
            expect(verjaehrung({ issueDate: null, dueDate: null }, TODAY)).toBe(null);
        });

        await it('warning window: 180 days before the deadline, the deadline day itself, then „verjährt"', async () => {
            const claim = { issueDate: '2023-06-01', dueDate: null };
            expect(verjaehrung(claim, '2026-07-04')?.status).toBe('bald'); // 180 days
            expect(verjaehrung(claim, '2026-07-03')?.status).toBe('laufend'); // 181 days
            expect(verjaehrung(claim, '2026-12-31')?.status).toBe('bald'); // still „Handeln bis"
            expect(verjaehrung(claim, '2027-01-01')?.status).toBe('verjaehrt');
            expect(verjaehrung(claim, TODAY)?.tageBis).toBe(83);
        });

        await it('the hint: befund with the invoice, „vermutlich", Hemmung/Neubeginn named, an action', async () => {
            const { posten } = offenePosten(
                [
                    inv({ id: 'old', number: 'RE-2023-0004', issueDate: '2023-05-02', dueDate: '2023-05-16' }),
                    inv({ id: 'new' }),
                ],
                [],
                [],
                TODAY,
            );
            const [h] = verjaehrungHinweise({ posten });
            expect(h.status).toBe('befund');
            expect(h.level).toBe('warnung');
            expect(h.text).toContain('vermutlich');
            expect(h.text).toContain('31.12.2026');
            expect(h.text).toContain('§§ 203 ff., 212 BGB');
            expect(h.betroffen?.length).toBe(1);
            expect(h.betroffen?.[0].id).toBe('old');
            expect(h.handlungen?.some((a) => a.id === 'forderungen')).toBe(true);
            expect(h.fingerprint).toBeDefined();
        });

        await it('no hint without open claims; „ohne Befund" with them but far from the limit; „nicht prüfbar" when unreadable', async () => {
            expect(verjaehrungHinweise({ posten: [] })).toStrictEqual([]);
            expect(verjaehrungHinweise(undefined)).toStrictEqual([]);
            const ruhig = offenePosten([inv({ id: 'new' })], [], [], TODAY).posten;
            expect(verjaehrungHinweise({ posten: ruhig })[0].status).toBe('ohne_befund');
            const h = verjaehrungHinweise({ posten: null, weil: 'das Back-End nicht antwortet' })[0];
            expect(h.status).toBe('nicht_pruefbar');
            expect(h.weil).toBe('das Back-End nicht antwortet');
        });
    });
};
