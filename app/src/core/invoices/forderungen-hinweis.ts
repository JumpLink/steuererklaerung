/**
 * The Hinweis for Verjährung (Idee 12, in the form of Idee 4): open claims whose regular limitation
 * (§§ 195, 199 BGB) ends soon or already has. Pure — the open items come in, one hint goes out.
 *
 * Wording is „vermutlich", never legal advice: the app computes only the regular three years from the
 * end of the year the claim arose; Hemmung and Neubeginn (§§ 203 ff., 212 BGB) it does not track.
 */

import { deDate } from '../lib/format.ts';
import { fmtDe } from '../lib/money.ts';
import {
    HANDLUNG_IN_ORDNUNG,
    BETROFFEN_MAX,
    hinweisFingerprint,
    type Hinweis,
    type HinweisBetroffen,
} from '../elster/hinweise.ts';
import { VERJAEHRUNG_WARNFENSTER_TAGE, verjaehrungDroht, type OffenerPosten } from './forderungen.ts';

export const VERJAEHRUNG_HINWEIS_KEY = 'forderung-verjaehrung';

/** What the hint needs about the entity's open claims; `null` = they could not be read. */
export interface ForderungenHinweisDaten {
    posten: OffenerPosten[] | null;
    /** Why `posten` is null, phrased to follow „Nicht prüfbar, weil …". */
    weil?: string;
}

const NICHT_VERFOLGT =
    'Hemmung und Neubeginn der Verjährung (§§ 203 ff., 212 BGB — etwa durch Verhandlungen, Anerkenntnis oder Mahnbescheid) verfolgt die App nicht.';

function zeile(p: OffenerPosten): string {
    const v = p.verjaehrung;
    const frist = v
        ? v.status === 'verjaehrt'
            ? `vermutlich verjährt seit ${deDate(v.handelnBis)}`
            : `Handeln bis ${deDate(v.handelnBis)}`
        : '';
    return `${p.nummer ?? 'ohne Nr.'} · ${p.kunde} · ${fmtDe(p.offen)} € · ${frist}`;
}

export function verjaehrungHinweise(daten: ForderungenHinweisDaten | undefined): Hinweis[] {
    if (!daten) return [];
    const base = { key: VERJAEHRUNG_HINWEIS_KEY, begriff: 'verjaehrung', ref: '§§ 195, 199 BGB' } as const;
    if (daten.posten == null) {
        return [
            {
                ...base,
                level: 'info',
                title: 'Verjährung offener Forderungen',
                text: 'Die offenen Forderungen konnten nicht geprüft werden.',
                status: 'nicht_pruefbar',
                weil: daten.weil ?? 'die Rechnungen nicht gelesen werden konnten',
            },
        ];
    }
    if (daten.posten.length === 0) return [];
    const droht = daten.posten
        .filter(verjaehrungDroht)
        .sort((a, b) => (a.verjaehrung?.tageBis ?? 0) - (b.verjaehrung?.tageBis ?? 0));
    if (droht.length === 0) {
        return [
            {
                ...base,
                level: 'info',
                title: 'Verjährung offener Forderungen',
                text: 'Keine offene Forderung läuft in absehbarer Zeit aus der regelmäßigen Verjährung.',
                status: 'ohne_befund',
                geprueft: `Regelfrist drei Jahre ab Ende des Jahres, in dem die Forderung entstand; gemeldet wird ab ${VERJAEHRUNG_WARNFENSTER_TAGE} Tagen vor dem 31.12. des Fristjahres. ${NICHT_VERFOLGT}`,
            },
        ];
    }
    const verjaehrt = droht.filter((p) => p.verjaehrung?.status === 'verjaehrt').length;
    const bald = droht.length - verjaehrt;
    const fruehestes = droht.find((p) => p.verjaehrung?.status === 'bald')?.verjaehrung?.handelnBis;
    const teile: string[] = [];
    if (bald > 0 && fruehestes)
        teile.push(
            `${bald === 1 ? 'Eine Forderung verjährt' : `${bald} Forderungen verjähren`} vermutlich zum ${deDate(fruehestes)}${bald > 1 ? ' oder später' : ''} — bis dahin handeln, wenn sie noch durchgesetzt werden sollen.`,
        );
    if (verjaehrt > 0)
        teile.push(
            `${verjaehrt === 1 ? 'Eine Forderung ist' : `${verjaehrt} Forderungen sind`} vermutlich bereits verjährt; ob das hier gilt, ist zu klären.`,
        );
    const betroffen: HinweisBetroffen[] = droht
        .slice(0, BETROFFEN_MAX)
        .map((p) => ({ art: 'rechnung', id: p.rechnungId, zeile: zeile(p) }));
    return [
        {
            ...base,
            level: 'warnung',
            title: 'Verjährung droht bei offenen Forderungen',
            text: `${teile.join(' ')} ${NICHT_VERFOLGT} Das ist keine Rechtsberatung.`,
            status: 'befund',
            betroffen,
            ...(droht.length > BETROFFEN_MAX ? { betroffenWeitere: droht.length - BETROFFEN_MAX } : {}),
            handlungen: [
                {
                    id: 'forderungen',
                    label: 'Forderungen ansehen',
                    target: { art: 'ansicht', ansicht: 'rechnungen', filter: 'forderungen' },
                },
                HANDLUNG_IN_ORDNUNG,
            ],
            fingerprint: hinweisFingerprint(droht.map((p) => `${p.rechnungId}:${p.verjaehrung?.handelnBis}`)),
        },
    ];
}
