import { describe, it, expect } from '@gjsify/unit';
import {
    deriveEntlastungAlleinerziehende,
    ENTLASTUNG_FRAGEN,
    deriveKinderbetreuung,
    deriveHaushalt,
    deriveLohnersatz,
    frageAktiv,
    aktiveFragen,
} from '../../../src/core/actions/elster/est-intake.ts';
import {
    INTAKE_TOPICS,
    intakeTopic,
    describeIntakeTopics,
    buildProposal,
} from '../../../src/core/actions/elster/est-intake-topics.ts';

// The deterministic heart of the Steuer-Wizard: plain-language answers → §24b config (monate/weitere
// Kinder) with the eligibility branching. Pure — the GUI/AI adapters render ENTLASTUNG_FRAGEN and call this.
export default async () => {
    await describe('ESt-Intake — §24b deriveEntlastungAlleinerziehende', async () => {
        await it('0 Monate wenn nicht alleinerziehend', async () => {
            expect(deriveEntlastungAlleinerziehende({ alleinstehendMitKind: false }).monate).toBe(0);
        });

        await it('0 Monate (+ Hinweis) wenn eine andere volljährige Person im Haushalt wohnt', async () => {
            const d = deriveEntlastungAlleinerziehende({
                alleinstehendMitKind: true,
                von: '2025-01',
                andererVolljaehrigerImHaushalt: true,
            });
            expect(d.monate).toBe(0);
            expect(d.hinweise.some((h) => h.includes('alleinstehend'))).toBe(true);
        });

        await it('leitet 2 Monate aus „ab November" ab (Nov–Dez) + trägt das Kind durch', async () => {
            const d = deriveEntlastungAlleinerziehende({
                alleinstehendMitKind: true,
                von: '2025-11',
                kindIdnr: '11122233344',
            });
            expect(d.monate).toBe(2);
            expect(d.kind_idnr).toBe('11122233344');
        });

        await it('ganzjährig (keine Monatsgrenzen) → 12', async () => {
            expect(deriveEntlastungAlleinerziehende({ alleinstehendMitKind: true }).monate).toBe(12);
        });

        await it('ein einzelner Monat (von = bis)', async () => {
            expect(
                deriveEntlastungAlleinerziehende({ alleinstehendMitKind: true, von: '2025-08', bis: '2025-08' }).monate,
            ).toBe(1);
        });

        await it('reicht weitere_kinder durch (ganze Zahl, nie negativ)', async () => {
            expect(deriveEntlastungAlleinerziehende({ alleinstehendMitKind: true, weitereKinder: 2 }).weitere_kinder).toBe(2);
            expect(deriveEntlastungAlleinerziehende({ alleinstehendMitKind: true, weitereKinder: -3 }).weitere_kinder).toBe(0);
        });

        await it('exponiert die Frageliste für GUI/AI (mit Verzweigung)', async () => {
            expect(ENTLASTUNG_FRAGEN[0].id).toBe('alleinstehendMitKind');
            expect(ENTLASTUNG_FRAGEN.some((q) => q.wennId === 'alleinstehendMitKind')).toBe(true);
        });
    });

    await describe('ESt-Intake — Kinderbetreuung deriveKinderbetreuung (Aufteilung getrennter Eltern)', async () => {
        await it('kein Eintrag ohne Kosten', async () => {
            expect(deriveKinderbetreuung({ hatKosten: false, abzug: 'ich' }).eintrag).toBe(null);
        });

        await it('kein Eintrag, wenn das Kind nicht im Haushalt war (+ Hinweis §10 Nr. 5)', async () => {
            const d = deriveKinderbetreuung({ hatKosten: true, betragGesamt: 1434, kindImHaushalt: false, abzug: 'ich' });
            expect(d.eintrag).toBe(null);
            expect(d.hinweise.some((h) => h.includes('Haushalt'))).toBe(true);
        });

        await it('„nur der andere Elternteil" → 0 (Doppelabzug-Guard)', async () => {
            const d = deriveKinderbetreuung({ hatKosten: true, betragGesamt: 1434, abzug: 'anderer' });
            expect(d.eintrag).toBe(null);
            expect(d.hinweise.some((h) => h.includes('Doppelabzug'))).toBe(true);
        });

        await it('„nur ich" → voller Betrag als von_mir', async () => {
            const d = deriveKinderbetreuung({ hatKosten: true, betragGesamt: 1434, abzug: 'ich', dienstleister: 'Kita' });
            expect(d.eintrag?.von_mir).toBe(1434);
            expect(d.eintrag?.betrag).toBe(1434);
            expect(d.eintrag?.bezeichnung).toContain('Kita');
        });

        await it('„hälftig" → der halbe Betrag als von_mir', async () => {
            const d = deriveKinderbetreuung({ hatKosten: true, betragGesamt: 1434, abzug: 'haelftig' });
            expect(d.eintrag?.von_mir).toBe(717);
            expect(d.eintrag?.betrag).toBe(1434);
        });
    });

    // The shared separation timeline: ONE set of answers → KBK Haushalt block (TT.MM-TT.MM) AND §24b months.
    await describe('ESt-Intake — Haushalts-/Trennungs-Zeitachse deriveHaushalt', async () => {
        await it('keine Trennung → ganzjährig gemeinsam, 0 §24b-Monate', async () => {
            const d = deriveHaushalt({ getrenntGelebt: false }, 2025);
            expect(d.alleinstehend_monate).toBe(0);
            expect(d.haushalt?.gemeinsam_zeitraum).toBe('01.01-31.12');
            expect(d.haushalt?.gemeinsam_kind_zeitraum).toBe('01.01-31.12');
            expect(d.haushalt?.getrennt_zeitraum).toBe(undefined);
        });

        await it('Trennung ab November, Kind bei mir → getrennt + gemeinsam + kind_bei_mir + 2 §24b-Monate', async () => {
            const d = deriveHaushalt({ getrenntGelebt: true, getrenntAb: '2025-11', kindBeiWem: 'ich' }, 2025);
            expect(d.haushalt?.gemeinsam_zeitraum).toBe('01.01-31.10');
            expect(d.haushalt?.getrennt_zeitraum).toBe('01.11-31.12');
            expect(d.haushalt?.kind_bei_mir_zeitraum).toBe('01.11-31.12');
            expect(d.alleinstehend_monate).toBe(2);
            expect(d.alleinstehend_von).toBe('2025-11');
            expect(d.alleinstehend_bis).toBe(undefined);
        });

        await it('Kind beim anderen Elternteil → kind_beim_anderen + 0 §24b-Monate', async () => {
            const d = deriveHaushalt({ getrenntGelebt: true, getrenntAb: '2025-11', kindBeiWem: 'anderer' }, 2025);
            expect(d.haushalt?.kind_beim_anderen_zeitraum).toBe('01.11-31.12');
            expect(d.haushalt?.kind_bei_mir_zeitraum).toBe(undefined);
            expect(d.alleinstehend_monate).toBe(0);
        });

        await it('ganzjährig getrennt (Kind bei mir) → 12 §24b-Monate, kein gemeinsam-Zeitraum', async () => {
            const d = deriveHaushalt({ getrenntGelebt: true, kindBeiWem: 'ich' }, 2025);
            expect(d.haushalt?.getrennt_zeitraum).toBe('01.01-31.12');
            expect(d.haushalt?.gemeinsam_zeitraum).toBe(undefined);
            expect(d.alleinstehend_monate).toBe(12);
        });

        await it('unterjährig wieder zusammengezogen (Trennung Jan–Juni) → gemeinsam ab Juli', async () => {
            const d = deriveHaushalt({ getrenntGelebt: true, getrenntBis: '2025-06', kindBeiWem: 'ich' }, 2025);
            expect(d.haushalt?.getrennt_zeitraum).toBe('01.01-30.06');
            expect(d.haushalt?.gemeinsam_zeitraum).toBe('01.07-31.12');
            expect(d.alleinstehend_monate).toBe(6);
            expect(d.alleinstehend_bis).toBe('2025-06');
        });

        await it('Monatsende ist schaltjahr-genau (Februar 2024 → 29., 2025 → 28.)', async () => {
            expect(deriveHaushalt({ getrenntGelebt: true, getrenntBis: '2024-02' }, 2024).haushalt?.getrennt_zeitraum).toBe(
                '01.01-29.02',
            );
            expect(deriveHaushalt({ getrenntGelebt: true, getrenntBis: '2025-02' }, 2025).haushalt?.getrennt_zeitraum).toBe(
                '01.01-28.02',
            );
        });
    });

    // §32b Lohnersatz: netto (erhalten − zurückgezahlt), Abflussprinzip; a negative netto is allowed.
    await describe('ESt-Intake — §32b Lohnersatz deriveLohnersatz', async () => {
        await it('keine Leistungen → 0 (kein Progressionsvorbehalt)', async () => {
            const d = deriveLohnersatz({ hatLohnersatz: false });
            expect(d.netto).toBe(0);
            expect(d.hinweise.some((h) => h.includes('kein Progressionsvorbehalt'))).toBe(true);
        });

        await it('nur erhalten → positives Netto (erhöht den Steuersatz)', async () => {
            const d = deriveLohnersatz({ hatLohnersatz: true, erhalten: 8400 });
            expect(d.netto).toBe(8400);
            expect(d.zurueckgezahlt).toBe(0);
        });

        await it('nur zurückgezahlt (Elterngeld aus Vorjahr) → negatives Netto', async () => {
            const d = deriveLohnersatz({ hatLohnersatz: true, zurueckgezahlt: 538.53, art: 'Elterngeld' });
            expect(d.erhalten).toBe(0);
            expect(d.netto).toBe(-538.53);
            expect(d.hinweise.some((h) => h.includes('negativer Progressionsvorbehalt'))).toBe(true);
        });

        await it('erhalten und zurückgezahlt → Differenz', async () => {
            const d = deriveLohnersatz({ hatLohnersatz: true, erhalten: 2000, zurueckgezahlt: 1200 });
            expect(d.netto).toBe(800);
        });

        await it('klemmt negative Eingaben auf 0 (Richtung steckt in den zwei Feldern)', async () => {
            const d = deriveLohnersatz({ hatLohnersatz: true, erhalten: -100, zurueckgezahlt: -50 });
            expect(d.erhalten).toBe(0);
            expect(d.zurueckgezahlt).toBe(0);
            expect(d.netto).toBe(0);
        });
    });

    // The branching helpers (wennId/wennWert) — the GUI wizard AND the AI copilot decide through them
    // which question is shown/asked next. The branching logic lives in ONE place.
    await describe('ESt-Intake — frageAktiv / aktiveFragen (Verzweigung)', async () => {
        await it('ungated Frage ist immer aktiv', async () => {
            expect(frageAktiv({ id: 'x', frage: '?', typ: 'boolean' }, {})).toBe(true);
        });

        await it('gated Frage nur bei passender Vorantwort', async () => {
            const q = { id: 'von', frage: '?', typ: 'monat' as const, wennId: 'a', wennWert: true };
            expect(frageAktiv(q, { a: true })).toBe(true);
            expect(frageAktiv(q, { a: false })).toBe(false);
            expect(frageAktiv(q, {})).toBe(false);
        });

        await it('aktiveFragen filtert §24b: „nein" → nur die erste Frage, „ja" → alle', async () => {
            expect(aktiveFragen(ENTLASTUNG_FRAGEN, { alleinstehendMitKind: false })).toHaveLength(1);
            expect(aktiveFragen(ENTLASTUNG_FRAGEN, { alleinstehendMitKind: true }).length).toBe(ENTLASTUNG_FRAGEN.length);
        });
    });

    // The uniform topic registry: ONE interface over the four derive/apply pairs (GUI + AI copilot).
    await describe('ESt-Intake — Topic-Registry INTAKE_TOPICS', async () => {
        await it('enthält die vier Themen mit stabilen ids', async () => {
            // @gjsify/unit toEqual = `==` (reference comparison) → check arrays via the joined string.
            expect(INTAKE_TOPICS.map((t) => t.id).join(',')).toBe('entlastung,kinderbetreuung,haushalt,lohnersatz');
        });

        await it('markiert die per-Kind-Themen (proKind) korrekt', async () => {
            expect(intakeTopic('kinderbetreuung')?.proKind).toBe(true);
            expect(intakeTopic('haushalt')?.proKind).toBe(true);
            expect(intakeTopic('entlastung')?.proKind).toBe(false);
            expect(intakeTopic('lohnersatz')?.proKind).toBe(false);
        });

        await it('jede vorschau() liefert eine Ergebnis-Zeile + Hinweise (reine Ableitung, kein Write)', async () => {
            const ctx = { entityId: 'privat', year: 2025 };
            const v = intakeTopic('lohnersatz')!.vorschau({ hatLohnersatz: true, zurueckgezahlt: 538.53 }, ctx);
            expect(v.ergebnis).toBe('netto -538.53 €');
            expect(v.hinweise.length).toBeGreaterThan(0);
        });

        await it('vorschau der Haushalts-Zeitachse nutzt das Jahr aus dem Kontext', async () => {
            const v = intakeTopic('haushalt')!.vorschau(
                { getrenntGelebt: true, getrenntAb: '2025-11', kindBeiWem: 'ich' },
                { entityId: 'privat', year: 2025, kindIdnr: '11122233344' },
            );
            expect(v.ergebnis).toBe('§24b: 2 Monat(e) alleinstehend');
        });

        await it('§24b-vorschau rechnet den Entlastungsbetrag (2/12 von 4.260 €)', async () => {
            const v = intakeTopic('entlastung')!.vorschau(
                { alleinstehendMitKind: true, von: '2025-11', kindIdnr: '11122233344' },
                { entityId: 'privat', year: 2025 },
            );
            expect(v.ergebnis).toBe('2 Monat(e) → 710 €');
        });

        await it('describeIntakeTopics nennt Themen + Frage-ids (für den KI-Assistenten)', async () => {
            const d = describeIntakeTopics();
            expect(d.includes('entlastung')).toBe(true);
            expect(d.includes('alleinstehendMitKind')).toBe(true);
            expect(d.includes('lohnersatz')).toBe(true);
            expect(d.includes('kindIdnr nötig')).toBe(true); // proKind marker
        });

        await it('buildProposal baut einen serialisierbaren Vorschlag (reine Vorschau, kein Write)', async () => {
            const p = buildProposal(
                'lohnersatz',
                { hatLohnersatz: true, zurueckgezahlt: 538.53 },
                { entityId: 'privat', year: 2025 },
            );
            expect(p?.topicId).toBe('lohnersatz');
            expect(p?.vorschau.ergebnis).toBe('netto -538.53 €');
            expect(buildProposal('unbekannt', {}, { entityId: 'privat', year: 2025 })).toBe(null);
        });
    });
};
