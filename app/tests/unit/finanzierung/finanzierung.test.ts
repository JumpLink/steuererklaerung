import { describe, expect, it } from '@gjsify/unit';

import {
    berechneBedarf,
    berechneHaushalt,
    berechneSzenarien,
    berechneUnterlagen,
} from '../../../src/core/actions/finanzierung/index.ts';
import { FinanzierungSectionSchema } from '../../../src/core/config/schema/finanzierung.ts';

/** Parse through the schema so the defaults under test are the REAL ones. */
function cfg(raw: unknown) {
    return FinanzierungSectionSchema.parse(raw);
}

export default async () => {
    await describe('berechneBedarf', async () => {
        await it('derives the Kaufpreis from Ablösung + Auszahlung when none is given', async () => {
            const c = cfg({ bedarf: { abloesung: 100000, auszahlung_verkaeufer: 70000 } });
            const b = berechneBedarf(c.bedarf);
            expect(b.kaufpreis).toBe(170000);
        });

        await it('applies the Niedersachsen default rates to the Kaufpreis', async () => {
            const c = cfg({ bedarf: { abloesung: 100000, auszahlung_verkaeufer: 70000 } });
            const b = berechneBedarf(c.bedarf);
            // 5 % GrESt + 2 % Notar/Grundbuch on 170.000, no Makler by default.
            expect(b.nebenkosten.grunderwerbsteuer).toBe(8500);
            expect(b.nebenkosten.notarGrundbuch).toBe(3400);
            expect(b.nebenkosten.makler).toBe(0);
            expect(b.nebenkosten.summe).toBe(11900);
        });

        await it('sums the total requirement including the renovation tranche', async () => {
            const c = cfg({
                bedarf: { abloesung: 100000, auszahlung_verkaeufer: 70000, sanierung: 50000 },
            });
            const b = berechneBedarf(c.bedarf);
            expect(b.darlehensbedarf).toBe(170000 + 11900 + 50000);
        });

        await it('subtracts Eigenkapital', async () => {
            const c = cfg({
                bedarf: {
                    abloesung: 100000,
                    auszahlung_verkaeufer: 70000,
                    sanierung: 50000,
                    eigenkapital: 20000,
                },
            });
            expect(berechneBedarf(c.bedarf).darlehensbedarf).toBe(170000 + 11900 + 50000 - 20000);
        });

        await it('honours the per-scenario overrides and re-derives the Nebenkosten', async () => {
            const c = cfg({
                bedarf: { abloesung: 100000, auszahlung_verkaeufer: 70000, sanierung: 50000 },
            });
            const b = berechneBedarf(c.bedarf, { auszahlungVerkaeufer: 50000, sanierung: 25000 });
            // A smaller payout means a smaller Kaufpreis, hence smaller Nebenkosten too.
            expect(b.kaufpreis).toBe(150000);
            expect(b.nebenkosten.summe).toBe(10500);
            expect(b.darlehensbedarf).toBe(150000 + 10500 + 25000);
        });

        await it('keeps an explicit Kaufpreis as the Nebenkosten basis', async () => {
            const c = cfg({
                bedarf: { abloesung: 100000, auszahlung_verkaeufer: 70000, kaufpreis: 200000 },
            });
            const b = berechneBedarf(c.bedarf);
            expect(b.kaufpreis).toBe(200000);
            expect(b.nebenkosten.grunderwerbsteuer).toBe(10000);
        });
    });

    await describe('berechneHaushalt', async () => {
        const haushalt = {
            erwachsene: 1,
            kinder: 2,
            einnahmen: [
                { bezeichnung: 'Nettogehalt', betrag_monat: 3500 },
                { bezeichnung: 'Nebeneinkünfte', betrag_monat: 500, sicher: false },
            ],
            ausgaben: [
                { bezeichnung: 'Miete', betrag_monat: 1000, entfaellt_nach_kauf: true },
                { bezeichnung: 'Nebenkosten', betrag_monat: 500, entfaellt_nach_kauf: true },
                { bezeichnung: 'Versicherungen', betrag_monat: 200 },
                { bezeichnung: 'Lebensmittel', betrag_monat: 600, in_pauschale: true },
            ],
        };

        /**
         * The real shape of a family handover: the rent goes away, but gas/water are
         * ALREADY paid directly and stay, and ownership adds Grundsteuer + insurance +
         * Instandhaltung. Rent-vs-instalment would misjudge this by 500 € a month.
         */
        const uebernahme = {
            einnahmen: [{ bezeichnung: 'Nettogehalt', betrag_monat: 3500 }],
            ausgaben: [
                { bezeichnung: 'Miete an Eltern', betrag_monat: 1000, entfaellt_nach_kauf: true },
                { bezeichnung: 'Gas', betrag_monat: 150 },
                { bezeichnung: 'Wasser/Abwasser', betrag_monat: 50 },
                { bezeichnung: 'Grundsteuer', betrag_monat: 60, erst_nach_kauf: true },
                { bezeichnung: 'Gebäudeversicherung', betrag_monat: 70, erst_nach_kauf: true },
                { bezeichnung: 'Instandhaltungsrücklage', betrag_monat: 200, erst_nach_kauf: true },
            ],
        };

        await it('separates all income from the income a lender counts', async () => {
            const h = berechneHaushalt(cfg({ haushalt }).haushalt);
            expect(h.einnahmenGesamt).toBe(4000);
            expect(h.einnahmenSicher).toBe(3500);
        });

        await it('drops the costs that disappear with the purchase', async () => {
            const h = berechneHaushalt(cfg({ haushalt }).haushalt);
            expect(h.ausgabenGesamt).toBe(2300);
            expect(h.ausgabenNachKauf).toBe(800);
            expect(h.entfallend.length).toBe(2);
        });

        await it('computes the Ist-Rechnung and withholds the Puffer', async () => {
            const h = berechneHaushalt(cfg({ haushalt }).haushalt);
            expect(h.freiHeute).toBe(1700); // 4000 − 2300
            expect(h.freiNachKauf).toBe(3200); // 4000 − 800
            // Default Puffer is 10 %.
            expect(h.puffer).toBe(320);
            expect(h.tragbareRate).toBe(2880);
        });

        await it('replaces the living-cost items with the flat rate in the Bank-Sicht', async () => {
            const h = berechneHaushalt(cfg({ haushalt }).haushalt);
            // Defaults: 700 first adult + 2 × 250 children = 1200.
            expect(h.lebenshaltungPauschale).toBe(1200);
            // 3500 safe − 200 remaining non-living − 1200 flat rate = 2100.
            expect(h.freiNachKaufBankSicht).toBe(2100);
            expect(h.tragbareRateBankSicht).toBe(1890);
        });

        await it('does not double-count an item marked as living cost', async () => {
            const h = berechneHaushalt(cfg({ haushalt }).haushalt);
            // Lebensmittel (600) must NOT appear on top of the 1200 flat rate.
            expect(h.freiNachKaufBankSicht).toBe(3500 - 200 - 1200);
        });

        await it('keeps ownership-only costs out of today’s total', async () => {
            const h = berechneHaushalt(cfg({ haushalt: uebernahme }).haushalt);
            // Today: 1000 rent + 150 gas + 50 water. Grundsteuer & co. are NOT paid yet.
            expect(h.ausgabenGesamt).toBe(1200);
        });

        await it('adds ownership-only costs to the after-purchase total', async () => {
            const h = berechneHaushalt(cfg({ haushalt: uebernahme }).haushalt);
            // After: 150 + 50 stay, rent gone, +60 +70 +200 arrive.
            expect(h.ausgabenNachKauf).toBe(530);
            expect(h.hinzukommend.length).toBe(3);
        });

        await it('counts only the rent as falling away, not the self-paid utilities', async () => {
            const h = berechneHaushalt(cfg({ haushalt: uebernahme }).haushalt);
            expect(h.entfallend.length).toBe(1);
            expect(h.entfallend[0]!.betragMonat).toBe(1000);
        });

        await it('reflects the ownership costs in the carrying capacity', async () => {
            const h = berechneHaushalt(cfg({ haushalt: uebernahme }).haushalt);
            // 3500 − 530 = 2970 free, minus the 10 % Puffer.
            expect(h.freiNachKauf).toBe(2970);
            expect(h.tragbareRate).toBe(2673);
        });

        await it('never reports a negative carrying capacity', async () => {
            const broke = cfg({
                haushalt: {
                    einnahmen: [{ bezeichnung: 'Gehalt', betrag_monat: 500 }],
                    ausgaben: [{ bezeichnung: 'Fixkosten', betrag_monat: 2000 }],
                },
            }).haushalt;
            const h = berechneHaushalt(broke);
            expect(h.freiNachKauf < 0).toBeTruthy(); // the truth is reported…
            expect(h.tragbareRate).toBe(0); // …but the capacity floors at 0
        });
    });

    await describe('berechneSzenarien', async () => {
        const base = {
            bedarf: { abloesung: 100000, auszahlung_verkaeufer: 70000, sanierung: 50000 },
            haushalt: {
                einnahmen: [{ bezeichnung: 'Nettogehalt', betrag_monat: 3500 }],
                ausgaben: [
                    { bezeichnung: 'Miete', betrag_monat: 1000, entfaellt_nach_kauf: true },
                    { bezeichnung: 'Nebenkosten', betrag_monat: 500, entfaellt_nach_kauf: true },
                ],
            },
            angebote: [{ bank: 'Testbank', sollzins: 3.9, tilgung: 2, zinsbindung_jahre: 10 }],
        };

        await it('varies both levers and orders them from largest to smallest', async () => {
            const r = berechneSzenarien(cfg(base));
            // 3 payout steps × 3 renovation steps.
            expect(r.varianten.length).toBe(9);
            const first = r.varianten[0]!;
            const last = r.varianten[r.varianten.length - 1]!;
            expect(first.bedarf.darlehensbedarf > last.bedarf.darlehensbedarf).toBeTruthy();
            expect(first.rate > last.rate).toBeTruthy();
        });

        await it('compares each variant against today’s housing cost', async () => {
            const r = berechneSzenarien(cfg(base));
            expect(r.wohnkostenHeute).toBe(1500);
            for (const v of r.varianten) {
                expect(Math.abs(v.differenzZuHeute - (v.rate - 1500)) < 0.02).toBeTruthy();
            }
        });

        await it('nets the new ownership costs into the comparison, not just the rate', async () => {
            const mitEigentumskosten = {
                ...base,
                haushalt: {
                    einnahmen: [{ bezeichnung: 'Nettogehalt', betrag_monat: 3500 }],
                    ausgaben: [
                        { bezeichnung: 'Miete', betrag_monat: 1000, entfaellt_nach_kauf: true },
                        { bezeichnung: 'Grundsteuer', betrag_monat: 60, erst_nach_kauf: true },
                        { bezeichnung: 'Instandhaltung', betrag_monat: 200, erst_nach_kauf: true },
                    ],
                },
            };
            const r = berechneSzenarien(cfg(mitEigentumskosten));
            expect(r.wohnkostenHeute).toBe(1000);
            expect(r.zusatzkostenNachKauf).toBe(260);
            for (const v of r.varianten) {
                // Rate + 260 − 1000, NOT rate − 1000.
                expect(Math.abs(v.differenzZuHeute - (v.rate + 260 - 1000)) < 0.02).toBeTruthy();
            }
            // The netting must make the deal look WORSE than the naive rate-vs-rent view —
            // that is the whole point of tracking the ownership costs.
            for (const v of r.varianten) {
                expect(v.differenzZuHeute > v.rate - r.wohnkostenHeute).toBeTruthy();
            }
        });

        await it('flags tragbar against both views', async () => {
            const r = berechneSzenarien(cfg(base));
            for (const v of r.varianten) {
                expect(v.tragbar).toBe(v.rate <= r.haushalt.tragbareRate);
                expect(v.tragbarBankSicht).toBe(v.rate <= r.haushalt.tragbareRateBankSicht);
            }
        });

        await it('lets an explicit Angebot override the configured one', async () => {
            const cheap = berechneSzenarien(cfg(base), {
                angebot: {
                    bank: 'Günstiger',
                    sollzins: 2.5,
                    tilgung: 2,
                    zinsbindung_jahre: 10,
                    sondertilgung_pro_jahr: 0,
                    disagio_prozent: 0,
                    gebuehren: 0,
                },
            });
            const standard = berechneSzenarien(cfg(base));
            expect(cheap.varianten[0]!.rate < standard.varianten[0]!.rate).toBeTruthy();
        });

        await it('restricts the matrix to the levers passed in', async () => {
            const r = berechneSzenarien(cfg(base), { auszahlungen: [70000], sanierungen: [0] });
            expect(r.varianten.length).toBe(1);
            expect(r.varianten[0]!.sanierung).toBe(0);
        });

        await it('fails with a clear message when no Angebot exists', async () => {
            const noQuote = cfg({ bedarf: { abloesung: 100000 } });
            expect(() => berechneSzenarien(noQuote)).toThrow();
        });
    });

    await describe('berechneUnterlagen', async () => {
        await it('returns the standard checklist as all-open by default', async () => {
            const r = berechneUnterlagen(cfg({}));
            expect(r.eintraege.length > 15).toBeTruthy();
            expect(r.zusammenfassung.offen).toBe(r.eintraege.length);
            expect(r.offen.length).toBe(r.eintraege.length);
        });

        await it('lets a configured entry override its standard counterpart', async () => {
            const r = berechneUnterlagen(
                cfg({
                    unterlagen: [{ bezeichnung: 'SCHUFA-Selbstauskunft', status: 'vorhanden', paperless_id: 3063 }],
                }),
            );
            const schufa = r.eintraege.filter((e) => e.bezeichnung === 'SCHUFA-Selbstauskunft');
            // Exactly one entry — the override must not duplicate the standard one.
            expect(schufa.length).toBe(1);
            expect(schufa[0]!.status).toBe('vorhanden');
            expect(schufa[0]!.paperlessId).toBe(3063);
            expect(schufa[0]!.standard).toBeFalsy();
        });

        await it('matches an override despite differing punctuation and case', async () => {
            const r = berechneUnterlagen(
                cfg({ unterlagen: [{ bezeichnung: 'schufa selbstauskunft', status: 'eingereicht' }] }),
            );
            expect(r.eintraege.filter((e) => e.status === 'eingereicht').length).toBe(1);
            expect(r.zusammenfassung.eingereicht).toBe(1);
        });

        await it('keeps a bank-specific extra the standard list does not know', async () => {
            const r = berechneUnterlagen(
                cfg({ unterlagen: [{ bezeichnung: 'Sondertilgungsvereinbarung', status: 'angefordert' }] }),
            );
            const extra = r.eintraege.find((e) => e.bezeichnung === 'Sondertilgungsvereinbarung');
            expect(extra).toBeDefined();
            expect(extra!.status).toBe('angefordert');
        });

        await it('counts vorhanden/eingereicht as no longer open', async () => {
            const r = berechneUnterlagen(
                cfg({
                    unterlagen: [
                        { bezeichnung: 'Arbeitsvertrag', status: 'eingereicht' },
                        { bezeichnung: 'Grundbuchauszug', status: 'vorhanden' },
                    ],
                }),
            );
            const offenLabels = r.offen.map((e) => e.bezeichnung);
            expect(offenLabels.includes('Arbeitsvertrag')).toBeFalsy();
            expect(offenLabels.includes('Grundbuchauszug')).toBeFalsy();
        });
    });
};
