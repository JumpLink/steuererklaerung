/**
 * Dokumentregeln (Idee 11), the pure part: which rule a receipt matches, what it sets, how it says so.
 * Every sender, file and category below is invented.
 */
import { describe, it, expect } from '@gjsify/unit';
import {
    behalteRegelFelder,
    danachGilt,
    dokumentRegelId,
    findeDokumentRegel,
    herkunftSatz,
    regelAusDokument,
    regelZeile,
    suggestDokumentMuster,
    wendeDokumentRegelAn,
    type DokumentRegel,
} from '../../../src/core/dokumentregeln/regeln.ts';

const strom: DokumentRegel = {
    muster: 'Stadtwerke Beispielstadt',
    korrespondent: 'Stadtwerke Beispielstadt GmbH',
    dokumenttyp: 'Rechnung',
    kategorie: '4240 Gas, Strom, Wasser',
    richtung: 'incoming',
};
const leer = { correspondent: null, documentType: null, category: null, direction: null } as const;

export default async () => {
    await describe('Dokumentregeln — Treffer', async () => {
        await it('matches sender, title, file name and text, ignoring case', async () => {
            const p = { id: 'd1', correspondent: null, title: null };
            expect(findeDokumentRegel({ ...p, correspondent: 'STADTWERKE BEISPIELSTADT GmbH' }, [strom])).toBe(strom);
            expect(findeDokumentRegel({ ...p, title: 'Rechnung der stadtwerke beispielstadt' }, [strom])).toBe(strom);
            expect(findeDokumentRegel({ ...p, filename: 'Stadtwerke Beispielstadt 2026-03.pdf' }, [strom])).toBe(strom);
            expect(findeDokumentRegel({ ...p, text: 'Ihre Stadtwerke Beispielstadt senden...' }, [strom])).toBe(strom);
            expect(findeDokumentRegel({ ...p, title: 'Etwas ganz anderes' }, [strom])).toBe(null);
        });

        await it('the first matching rule wins', async () => {
            const allgemein: DokumentRegel = { muster: 'Stadtwerke', dokumenttyp: 'Sonstiges' };
            const probe = { id: 'd1', correspondent: 'Stadtwerke Beispielstadt', title: null };
            expect(findeDokumentRegel(probe, [strom, allgemein])).toBe(strom);
            expect(findeDokumentRegel(probe, [allgemein, strom])).toBe(allgemein);
        });

        await it('ignores a pattern shorter than three characters', async () => {
            const kurz: DokumentRegel = { muster: 'ab', dokumenttyp: 'X' };
            expect(findeDokumentRegel({ id: 'd1', correspondent: 'abc', title: null }, [kurz])).toBe(null);
        });

        await it('leaves out a receipt listed in ausnahmen', async () => {
            const mit: DokumentRegel = { ...strom, ausnahmen: ['d2'] };
            const probe = (id: string) => ({ id, correspondent: 'Stadtwerke Beispielstadt', title: null });
            expect(findeDokumentRegel(probe('d1'), [mit])).toBe(mit);
            expect(findeDokumentRegel(probe('d2'), [mit])).toBe(null);
        });
    });

    await describe('Dokumentregeln — was eine Regel setzt', async () => {
        await it('fills every empty field and names them in the origin', async () => {
            const { patch, origin } = wendeDokumentRegelAn(leer, strom);
            expect(patch).toStrictEqual({
                correspondent: 'Stadtwerke Beispielstadt GmbH',
                documentType: 'Rechnung',
                category: '4240 Gas, Strom, Wasser',
                direction: 'incoming',
            });
            expect(origin?.id).toBe(dokumentRegelId('Stadtwerke Beispielstadt'));
            expect(origin?.label).toBe('„Stadtwerke Beispielstadt“');
            expect(origin?.fields).toStrictEqual(['correspondent', 'documentType', 'category', 'direction']);
        });

        await it('never overwrites a field that already has a value (e-invoice, hand edit)', async () => {
            const { patch, origin } = wendeDokumentRegelAn(
                { correspondent: 'Aus der E-Rechnung', documentType: null, category: null, direction: 'outgoing' },
                strom,
            );
            expect(patch).toStrictEqual({ documentType: 'Rechnung', category: '4240 Gas, Strom, Wasser' });
            expect(origin?.fields).toStrictEqual(['documentType', 'category']);
        });

        await it('sets nothing and claims nothing when the receipt is already complete', async () => {
            const full = { correspondent: 'A', documentType: 'B', category: 'C', direction: 'incoming' as const };
            const res = wendeDokumentRegelAn(full, strom);
            expect(res.origin).toBe(null);
            expect(Object.keys(res.patch).length).toBe(0);
        });

        await it('a rule with only a document type sets only that', async () => {
            const nur: DokumentRegel = { muster: 'Kanzlei Muster', dokumenttyp: 'Honorarnote' };
            const { patch, origin } = wendeDokumentRegelAn(leer, nur);
            expect(patch).toStrictEqual({ documentType: 'Honorarnote' });
            expect(origin?.fields).toStrictEqual(['documentType']);
        });
    });

    await describe('Dokumentregeln — Herkunft in Worten', async () => {
        const origin = {
            id: 'beleg:regeln:x',
            label: '„Stadtwerke Beispielstadt“',
            fields: ['documentType', 'category'] as const,
        };

        await it('says via Regel and lists the fields in German', async () => {
            expect(herkunftSatz({ ...origin, fields: [...origin.fields] })).toBe(
                'via Regel „Stadtwerke Beispielstadt“ gesetzt: Dokumenttyp und Kategorie',
            );
            expect(herkunftSatz({ ...origin, fields: ['correspondent', 'documentType', 'direction'] })).toBe(
                'via Regel „Stadtwerke Beispielstadt“ gesetzt: Korrespondent, Dokumenttyp und Richtung',
            );
        });

        await it('„Danach gilt" names the empty fields and who fills them', async () => {
            const satz = danachGilt({ ...origin, fields: [...origin.fields] });
            expect(satz).toContain('Danach gilt: Dokumenttyp und Kategorie sind nicht gesetzt');
            expect(satz).toContain('KI');
            expect(danachGilt({ ...origin, fields: ['category'] })).toContain('Kategorie ist nicht gesetzt');
        });

        await it('prints a rule on one line', async () => {
            expect(regelZeile({ ...strom, ausnahmen: ['a', 'b'] })).toBe(
                '„Stadtwerke Beispielstadt“ → Korrespondent Stadtwerke Beispielstadt GmbH · Dokumenttyp Rechnung · Kategorie 4240 Gas, Strom, Wasser · Eingang (Ausgabe) (2 Ausnahmen)',
            );
        });
    });

    await describe('Dokumentregeln — von Hand geändert gewinnt', async () => {
        const origin = {
            id: 'beleg:regeln:x',
            label: '„X“',
            fields: ['documentType', 'category', 'direction'] as Array<'documentType' | 'category' | 'direction'>,
        };
        const vorher = {
            correspondent: 'X',
            documentType: 'Rechnung',
            category: '4240',
            direction: 'incoming' as const,
        };

        await it('a changed field leaves the origin, an unchanged one stays', async () => {
            const rest = behalteRegelFelder(origin, vorher, {
                documentType: 'Mahnung',
                category: '4240',
                direction: 'incoming',
            });
            expect(rest?.fields).toStrictEqual(['category', 'direction']);
        });

        await it('a field not part of the edit stays', async () => {
            expect(behalteRegelFelder(origin, vorher, {})?.fields).toStrictEqual([
                'documentType',
                'category',
                'direction',
            ]);
        });

        await it('when every ruled field was changed there is no origin left', async () => {
            expect(
                behalteRegelFelder(origin, vorher, { documentType: null, category: 'z', direction: 'outgoing' }),
            ).toBe(null);
        });
    });

    await describe('Dokumentregeln — Als Regel merken', async () => {
        await it('suggests the sender, never the title', async () => {
            expect(suggestDokumentMuster({ correspondent: '  Stadtwerke Beispielstadt  ' })).toBe(
                'Stadtwerke Beispielstadt',
            );
            expect(suggestDokumentMuster({ correspondent: null })).toBe('');
        });

        await it('builds the rule from what the receipt shows now', async () => {
            const regel = regelAusDokument({
                correspondent: 'Kanzlei Muster',
                documentType: 'Honorarnote',
                category: null,
                direction: 'incoming',
            });
            expect(regel).toStrictEqual({
                muster: 'Kanzlei Muster',
                korrespondent: 'Kanzlei Muster',
                dokumenttyp: 'Honorarnote',
                richtung: 'incoming',
            });
        });
    });
};
