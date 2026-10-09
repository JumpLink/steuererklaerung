/**
 * Which Paperless rule assigned a value — the explanation, against invented API fixtures shaped like
 * `/api/correspondents/`, `/api/document_types/` and `/api/tags/` (id, name, match, matching_algorithm,
 * is_insensitive). No real Paperless data.
 */
import { describe, it, expect } from '@gjsify/unit';
import {
    erklaereZuordnung,
    paperlessRegelTrifft,
    zuordnungKopf,
    type PaperlessKatalog,
} from '../../../src/core/dokumentregeln/paperless-erklaerung.ts';

const katalog: PaperlessKatalog = {
    correspondents: [
        {
            id: 1,
            name: 'Stadtwerke Beispielstadt',
            match: 'stadtwerke beispielstadt',
            matching_algorithm: 3,
            is_insensitive: true,
        },
        { id: 2, name: 'Kanzlei Muster', match: 'Kanzlei', matching_algorithm: 3, is_insensitive: true },
    ],
    documentTypes: [
        { id: 10, name: 'Rechnung', match: 'rechnung rechnungsnummer', matching_algorithm: 1, is_insensitive: true },
        { id: 11, name: 'Vertrag', match: '', matching_algorithm: 0, is_insensitive: true },
    ],
    tags: [
        { id: 20, name: 'Energie', match: 'strom gas', matching_algorithm: 2, is_insensitive: true },
        { id: 21, name: 'Gelernt', match: '', matching_algorithm: 6, is_insensitive: true },
        { id: 22, name: 'Unscharf', match: 'beispielstadt', matching_algorithm: 5, is_insensitive: true },
        { id: 23, name: 'Regex', match: 'RE-\\d{4}', matching_algorithm: 4, is_insensitive: false },
    ],
};

const content = 'Stadtwerke Beispielstadt — Rechnung RE-2026 für Strom und Gas, Rechnungsnummer 4711.';

export default async () => {
    await describe('Paperless-Regeln nachrechnen', async () => {
        await it('literal: whole phrase, case-insensitive by flag', async () => {
            const obj = { id: 1, name: 'X', match: 'Beispielstadt', matching_algorithm: 3, is_insensitive: true };
            expect(paperlessRegelTrifft(obj, 'die stadtwerke BEISPIELSTADT gmbh')).toBe(true);
            expect(paperlessRegelTrifft({ ...obj, is_insensitive: false }, 'die stadtwerke BEISPIELSTADT gmbh')).toBe(
                false,
            );
        });

        await it('matches whole words only, also next to umlauts', async () => {
            const obj = { id: 1, name: 'X', match: 'Müller', matching_algorithm: 3, is_insensitive: true };
            expect(paperlessRegelTrifft(obj, 'Rechnung von Müller KG')).toBe(true);
            expect(paperlessRegelTrifft(obj, 'Rechnung von Müllerei KG')).toBe(false);
            expect(paperlessRegelTrifft({ ...obj, match: 'Mühl' }, 'Rechnung von Mühle KG')).toBe(false);
        });

        await it('any / all split the pattern into words, quotes keep a phrase together', async () => {
            const any = { id: 1, name: 'X', match: 'strom wasser', matching_algorithm: 1, is_insensitive: true };
            expect(paperlessRegelTrifft(any, 'nur Strom')).toBe(true);
            expect(paperlessRegelTrifft(any, 'weder noch')).toBe(false);
            const all = { ...any, matching_algorithm: 2 };
            expect(paperlessRegelTrifft(all, 'nur Strom')).toBe(false);
            expect(paperlessRegelTrifft(all, 'Strom und Wasser')).toBe(true);
            const phrase = { ...any, match: '"Gas Wasser"', matching_algorithm: 2 };
            expect(paperlessRegelTrifft(phrase, 'Gas   Wasser Kosten')).toBe(true);
        });

        await it('regex, and „cannot be recomputed" for fuzzy, auto and broken patterns', async () => {
            expect(
                paperlessRegelTrifft(
                    { id: 1, name: 'X', match: 'RE-\\d{4}', matching_algorithm: 4, is_insensitive: false },
                    'RE-2026',
                ),
            ).toBe(true);
            expect(paperlessRegelTrifft({ id: 1, name: 'X', match: 'x', matching_algorithm: 5 }, 'x')).toBe(null);
            expect(paperlessRegelTrifft({ id: 1, name: 'X', match: 'x', matching_algorithm: 6 }, 'x')).toBe(null);
            expect(paperlessRegelTrifft({ id: 1, name: 'X', match: '(', matching_algorithm: 4 }, 'x')).toBe(null);
        });

        await it('algorithm none and an empty pattern never match', async () => {
            expect(paperlessRegelTrifft({ id: 1, name: 'X', match: 'x', matching_algorithm: 0 }, 'x')).toBe(false);
            expect(paperlessRegelTrifft({ id: 1, name: 'X', match: '  ', matching_algorithm: 3 }, 'x')).toBe(false);
        });
    });

    await describe('Paperless-Zuordnung erklärt', async () => {
        const doc = { correspondent: 1, document_type: 10, tags: [20, 21, 22, 23, 99], content };
        const eintraege = erklaereZuordnung(doc, katalog);
        const by = (name: string) => eintraege.find((e) => e.name === name)!;

        await it('reports one entry per correspondent, type and known tag, in that order', async () => {
            expect(eintraege.map((e) => `${e.art}:${e.name}`)).toStrictEqual([
                'Korrespondent:Stadtwerke Beispielstadt',
                'Dokumenttyp:Rechnung',
                'Schlagwort:Energie',
                'Schlagwort:Gelernt',
                'Schlagwort:Unscharf',
                'Schlagwort:Regex',
            ]);
        });

        await it('a hit is „vermutlich" and names kind, value, pattern and algorithm', async () => {
            const k = by('Stadtwerke Beispielstadt');
            expect(k.ergebnis).toBe('vermutlich');
            expect(k.satz).toContain('Zugeordnet durch Paperless-Regel: Korrespondent Stadtwerke Beispielstadt');
            expect(k.satz).toContain('Muster „stadtwerke beispielstadt“');
            expect(k.satz).toContain('enthält genau diesen Text');
            expect(k.satz).toContain('vermutlich');
            expect(by('Rechnung').ergebnis).toBe('vermutlich');
            expect(by('Energie').ergebnis).toBe('vermutlich');
            expect(by('Regex').ergebnis).toBe('vermutlich');
        });

        await it('learned and fuzzy rules are said to be un-checkable, not guessed', async () => {
            expect(by('Gelernt').ergebnis).toBe('automatisch');
            expect(by('Unscharf').ergebnis).toBe('nicht-pruefbar');
            expect(by('Unscharf').satz).toContain('nicht nachprüfbar');
        });

        await it('a rule that does not hit the text says the value came from elsewhere', async () => {
            const e = erklaereZuordnung({ ...doc, correspondent: 2, document_type: 11, tags: [] }, katalog);
            expect(e[0].ergebnis).toBe('trifft-nicht');
            expect(e[0].satz).toContain('trifft den Text nicht');
            expect(e[1].ergebnis).toBe('ohne-regel');
            expect(e[1].satz).toContain('keine Regel');
        });

        await it('without text nothing can be checked', async () => {
            const e = erklaereZuordnung({ ...doc, content: null, tags: [] }, katalog);
            expect(e[0].ergebnis).toBe('nicht-pruefbar');
            expect(e[0].satz).toContain('keinen Text');
        });

        await it('the headline lists the likely rules, or says none is recognisable', async () => {
            expect(zuordnungKopf(eintraege)).toBe(
                'Zugeordnet durch Paperless-Regel (vermutlich): Korrespondent Stadtwerke Beispielstadt, Dokumenttyp Rechnung, Schlagwort Energie, Schlagwort Regex',
            );
            expect(
                zuordnungKopf(erklaereZuordnung({ ...doc, correspondent: 2, document_type: 11, tags: [] }, katalog)),
            ).toContain('Keine Paperless-Regel als Ursache erkennbar');
            expect(zuordnungKopf([])).toContain('keinen Korrespondenten');
        });
    });
};
