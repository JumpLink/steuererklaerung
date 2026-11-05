import { describe, it, expect } from '@gjsify/unit';
import {
    declaredAmountOf,
    eingangIsoDate,
    parseGermanNumber,
    parseUebertragungsprotokoll,
} from '../../../src/core/elster/uebertragungsprotokoll.ts';
import { entityForSteuernummer, planProtokollImport } from '../../../src/core/actions/filing-import.ts';

const HEAD = `Datenübermittler: Beispiel GbR        Eingang auf Server: 15.07.2026, 12:47:31
Steuernummer: 12/345/67890       Transferticket: ep0000abcdefghijklmnopqrstuvwxyz
Finanzamt: Beispielstadt                Erstellungsdatum: 15.07.2026
`;

const UST_JAHR = `${HEAD}
Umsatzsteuererklärung 2025
Kalenderjahr   2025
 3 Berichtigte Steuererklärung
 22      Lieferungen und sonstige Leistungen zu 19 %           15.030                                                 2.855,70
 35 Veräußerungs- / Aufgabegewinne aus dem Gesamthandsvermögen -1.291,85
 43 Ende der Gesellschaft / Gemeinschaft 31.10.2025
 118     Verbleibende Umsatzsteuer                                                                            1.091,16
 120     Noch an die Finanzkasse zu entrichten – Abschlusszahlung - Erstattungsanspruch                            1.091,16
Seite 1 von 3
${HEAD}
`;

const USTVA = `${HEAD}
Umsatzsteuer-Voranmeldung
Jahr   2025
Zeitraum   IV. Kalendervierteljahr
zum Steuersatz von 19 Prozent                                     81                             2.708 €
Vorsteuerbeträge aus Rechnungen von anderen Unternehmern (§ 15 Absatz 1 Satz 1 Nummer 1                  66            73,95 €
Verbleibende Umsatzsteuer-Vorauszahlung beziehungsweise verbleibender Überschuss                    83               440,57 €
`;

export default async () => {
    await describe('Übertragungsprotokoll parser', async () => {
        await it('parses German numbers', async () => {
            expect(parseGermanNumber('1.234,56')).toBe(1234.56);
            expect(parseGermanNumber('-1.291,85')).toBe(-1291.85);
            expect(parseGermanNumber('15.030')).toBe(15030);
            expect(parseGermanNumber('31.10.2025')).toBe(null);
            expect(parseGermanNumber('abc')).toBe(null);
        });

        await it('reads a berichtigte USt-Jahr in Zeile layout', async () => {
            const p = parseUebertragungsprotokoll(UST_JAHR);
            expect(p.kind).toBe('ust-jahr');
            expect(p.period).toBe('2025');
            expect(p.berichtigt).toBe(true);
            expect(p.steuernummer).toBe('12/345/67890');
            expect(p.transferticket).toBe('ep0000abcdefghijklmnopqrstuvwxyz');
            expect(eingangIsoDate(p)).toBe('2026-07-15');
            const z22 = p.zeilen.find((z) => z.zeile === 22)!;
            expect(z22.values.length).toBe(2);
            expect(z22.values[0]).toBe(15030);
            expect(z22.values[1]).toBe(2855.7);
            expect(p.zeilen.find((z) => z.zeile === 35)!.values[0]).toBe(-1291.85);
            expect(p.zeilen.find((z) => z.zeile === 43)!.values[0]).toBe('31.10.2025');
            expect(declaredAmountOf(p)).toBe(1091.16);
        });

        await it('reads a USt-VA in Kennzahl layout with Quartal', async () => {
            const p = parseUebertragungsprotokoll(USTVA);
            expect(p.kind).toBe('ustva');
            expect(p.period).toBe('2025-Q4');
            expect(p.berichtigt).toBe(false);
            expect(p.kennzahlen.find((k) => k.kz === 81)!.value).toBe(2708);
            expect(p.kennzahlen.find((k) => k.kz === 66)!.value).toBe(73.95);
            expect(declaredAmountOf(p)).toBe(440.57);
        });

        await it('maps a month name to YYYY-MM', async () => {
            const p = parseUebertragungsprotokoll(USTVA.replace('IV. Kalendervierteljahr', 'März'));
            expect(p.period).toBe('2025-03');
        });

        await it('detects Dauerfrist before the Voranmeldung it mentions', async () => {
            const text = `${HEAD}\nAntrag auf Dauerfristverlängerung\nAnmeldung der Sondervorauszahlung\nUmsatzsteuer-Voranmeldung\nJahr   2026\n`;
            const p = parseUebertragungsprotokoll(text);
            expect(p.kind).toBe('dauerfrist');
            expect(p.period).toBe('2026');
        });

        await it('keeps a USt-Jahr whose Zeile 119 mentions the Sondervorauszahlung', async () => {
            const text = UST_JAHR.replace(
                ' 120 ',
                ' 119     Vorauszahlungssoll 2025 (einschließlich Sondervorauszahlung)          440,57\n 120 ',
            );
            expect(parseUebertragungsprotokoll(text).kind).toBe('ust-jahr');
        });

        await it('detects a Dauerfrist titled as Umsatzsteuer-Voranmeldung', async () => {
            const text = `${HEAD}\nUmsatzsteuer-Voranmeldung\nJahr   2026\nI. Antrag auf Dauerfristverlängerung\n`;
            expect(parseUebertragungsprotokoll(text).kind).toBe('dauerfrist');
        });

        await it('reads the year from the wrapped Feststellung title', async () => {
            const text = `${HEAD}\nErklärung zur gesonderten und einheitlichen Feststellung von\nGrundlagen für die Einkommensbesteuerung 2025\nHauptvordruck ESt 1 B\n`;
            const p = parseUebertragungsprotokoll(text);
            expect(p.kind).toBe('feststellung');
            expect(p.period).toBe('2025');
        });

        await it('rejects an unknown form', async () => {
            expect(() => parseUebertragungsprotokoll(`${HEAD}\nIrgendein Formular 2025\n`)).toThrow();
        });
    });

    await describe('Übertragungsprotokoll import planning', async () => {
        const entities = [
            { id: 'a', taxNumber: '99/999/99999' },
            { id: 'b', taxNumber: '12 345 67890' },
        ];

        await it('matches the entity by normalised Steuernummer', async () => {
            expect(entityForSteuernummer(entities, '12/345/67890')).toBe('b');
            expect(() => entityForSteuernummer(entities, '11/111/11111')).toThrow();
        });

        await it('lets the latest Eingang win and records the superseded file', async () => {
            const early = parseUebertragungsprotokoll(UST_JAHR.replaceAll('12:47:31', '09:00:00'));
            const late = parseUebertragungsprotokoll(
                UST_JAHR.replaceAll('15.07.2026, 12:47:31', '16.07.2026, 08:00:00'),
            );
            const plan = planProtokollImport(
                [
                    { file: 'late.pdf', protokoll: late },
                    { file: 'early.pdf', protokoll: early },
                ],
                entities,
            );
            expect(plan.length).toBe(1);
            expect(plan[0].file).toBe('late.pdf');
            expect(plan[0].supersedes[0]).toBe('early.pdf');
            expect(plan[0].input.filedAt).toBe('2026-07-16');
            expect(plan[0].input.declaredAmount).toBe(1091.16);
            expect(plan[0].input.note).toBe('ELSTER ep0000abcdefghijklmnopqrstuvwxyz · berichtigt');
        });
    });
};
