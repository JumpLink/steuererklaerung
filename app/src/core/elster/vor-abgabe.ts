/**
 * „Vor der Abgabe klären" — which of the year's Hinweise belong in front of a USt-VA or the annual
 * returns (Idee 10 in docs/ideen-nutzerfuehrung.md).
 *
 * The four Prüfungen vor der Abgabe (USt-Abweichung, Buchungen ohne USt-Angabe, § 13b-Kandidat,
 * Anlagegut-Kandidat) with a finding, plus the warnings of the Geld-Prüfungen (Idee 7): money that may
 * have gone to the wrong IBAN or out twice changes the figures that are about to be filed. A hint stays
 * a hint — the section shows it, the submission is not blocked.
 */

import type { Hinweis } from './hinweise.ts';

/** Keys (or `key:` prefixes) of the Prüfungen vor der Abgabe. */
export const VOR_ABGABE_PRUEFUNGEN = [
    'ust-abweichung',
    'ust-ohne-angabe',
    'reverse-charge-kandidat',
    'anlagegut-kandidat',
] as const;

/** Geld-Prüfungen whose warnings ride along (Idee 7 left the pre-submission warning to Idee 10). */
const GELD_PRUEFUNGEN = ['iban-wechsel', 'doppelte-rechnung', 'lieferant-doppelt-bezahlt'] as const;

const passt = (key: string, prefixes: readonly string[]) => prefixes.some((p) => key === p || key.startsWith(`${p}:`));

/** The findings to clear before a return goes out, in the order the hints came (already sorted). */
export function vorAbgabeHinweise<T extends Hinweis>(hints: readonly T[]): T[] {
    return hints.filter(
        (h) =>
            h.status === 'befund' &&
            (passt(h.key, VOR_ABGABE_PRUEFUNGEN) || (h.level === 'warnung' && passt(h.key, GELD_PRUEFUNGEN))),
    );
}
