import { describe, it, expect } from '@gjsify/unit';
import { buildEdsEnvelope, escapeXml } from '../../../src/core/elster/eds-envelope.ts';

/**
 * Every free-form text field the EDS envelope interpolates must be XML-escaped.
 *
 * The TransferHeader's `<DatenLieferant>` was the one field inserted raw while
 * its NutzdatenHeader twin went through `escapeXml`. That is invisible for most
 * Datenlieferanten and fatal for one shaped like "Meier & Schulz GbR": ERiC
 * rejects the whole document with ERIC_IO_PARSE_FEHLER (610301006), "expected
 * entity name for reference", so NO return of that entity could ever be
 * transmitted. It surfaced only when the GbR's Anlage EÜR was validated.
 *
 * So the test below is a sweep, not a single-field assertion: it pushes the
 * hostile payload through every string option at once and demands the result
 * contain no bare `&`. A newly added field that forgets `escapeXml` fails here.
 */

/** The characters that must never reach the output unescaped. */
const HOSTILE = 'A & B <c> "d" \'e\'';

/**
 * Find a `&` that does not open one of the five XML entity references.
 * A correctly escaped document has none.
 */
function bareAmpersandAt(xml: string): number {
    const entity = /&(amp|lt|gt|quot|apos);/g;
    for (let i = 0; i < xml.length; i++) {
        if (xml[i] !== '&') continue;
        entity.lastIndex = i;
        const m = entity.exec(xml);
        if (!m || m.index !== i) return i;
        i = entity.lastIndex - 1;
    }
    return -1;
}

export default async () => {
    await describe('EDS envelope XML escaping', async () => {
        await it('escapes an ampersand in the TransferHeader DatenLieferant', async () => {
            // The exact regression: an ampersand in the company name is the payload.
            const xml = buildEdsEnvelope({
                verfahren: 'ElsterErklaerung',
                datenArt: 'EUER',
                vorgang: 'send-Auth',
                testMode: true,
                herstellerId: '39542',
                datenLieferant: 'Meier & Schulz GbR',
                empfaenger: '2318',
                nutzdaten: '                <Payload />\n',
            });

            expect(xml.includes('<DatenLieferant>Meier &amp; Schulz GbR</DatenLieferant>')).toBe(true);
            // The raw form is what ERiC choked on — it must be gone entirely.
            expect(xml.includes('<DatenLieferant>Meier & Schulz GbR</DatenLieferant>')).toBe(false);
            expect(bareAmpersandAt(xml)).toBe(-1);
        });

        await it('leaves no bare ampersand when every text field is hostile', async () => {
            // The mechanism: one payload through every string option at once.
            const xml = buildEdsEnvelope({
                verfahren: 'ElsterErklaerung',
                datenArt: 'EUER',
                vorgang: 'send-Auth',
                testMode: false,
                herstellerId: HOSTILE,
                datenLieferant: HOSTILE,
                empfaenger: HOSTILE,
                empfaengerZiel: HOSTILE,
                produktName: HOSTILE,
                produktVersion: HOSTILE,
                nutzdatenLieferant: HOSTILE,
                // Nutzdaten is inserted verbatim by contract (the form builders
                // escape their own values), so it carries no hostile payload here.
                nutzdaten: '                <Payload />\n',
            });

            const at = bareAmpersandAt(xml);
            expect(at).toBe(-1);
            // Every hostile field really did land in the document, escaped —
            // otherwise the assertion above would pass on an empty envelope.
            const escaped = escapeXml(HOSTILE);
            expect(xml.split(escaped).length - 1).toBe(7);
        });

        await it('escapes the five XML metacharacters and nothing else', async () => {
            expect(escapeXml('A & B <c> "d" \'e\'')).toBe('A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;');
            // Umlauts are UTF-8, not entities — the Datenlieferant keeps them.
            expect(escapeXml('Größenprüfung')).toBe('Größenprüfung');
        });
    });
};
