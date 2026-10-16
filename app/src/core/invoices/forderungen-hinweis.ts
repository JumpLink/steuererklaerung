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
    handlungInOrdnung,
    BETROFFEN_MAX,
    hinweisFingerprint,
    type Hinweis,
    type HinweisBetroffen,
} from '../elster/hinweise.ts';
import { VERJAEHRUNG_WARNFENSTER_TAGE, verjaehrungDroht, type OffenerPosten } from './forderungen.ts';
import { _, _n, fmt as t } from '../lib/i18n.ts';

export const VERJAEHRUNG_HINWEIS_KEY = 'forderung-verjaehrung';

/** What the hint needs about the entity's open claims; `null` = they could not be read. */
export interface ForderungenHinweisDaten {
    posten: OffenerPosten[] | null;
    /** Why `posten` is null, phrased to follow „Nicht prüfbar, weil …". */
    weil?: string;
}

/** A function, not a constant: a constant resolves before the frontend registers its translator. */
function nichtVerfolgt(): string {
    return _(
        'The app does not track suspension or restart of the limitation period (§§ 203 ff., 212 BGB — e.g. through negotiations, acknowledgement or a court order for payment).',
    );
}

function zeile(p: OffenerPosten): string {
    const v = p.verjaehrung;
    const frist = v
        ? v.status === 'verjaehrt'
            ? t(_('probably time-barred since {date}'), { date: deDate(v.handelnBis) })
            : t(_('act by {date}'), { date: deDate(v.handelnBis) })
        : '';
    return `${p.nummer ?? _('no number')} · ${p.kunde} · ${fmtDe(p.offen)} € · ${frist}`;
}

export function verjaehrungHinweise(daten: ForderungenHinweisDaten | undefined): Hinweis[] {
    if (!daten) return [];
    const base = { key: VERJAEHRUNG_HINWEIS_KEY, begriff: 'verjaehrung', ref: '§§ 195, 199 BGB' } as const;
    if (daten.posten == null) {
        return [
            {
                ...base,
                level: 'info',
                title: _('Limitation of open receivables'),
                text: _('The open receivables could not be checked.'),
                status: 'nicht_pruefbar',
                weil: daten.weil ?? _('the invoices could not be read'),
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
                title: _('Limitation of open receivables'),
                text: _('No open receivable runs out of the regular limitation period in the foreseeable future.'),
                status: 'ohne_befund',
                geprueft: `${t(_('Regular period of three years from the end of the year the receivable arose; reported from {days} days before 31 December of that year.'), { days: VERJAEHRUNG_WARNFENSTER_TAGE })} ${nichtVerfolgt()}`,
            },
        ];
    }
    const verjaehrt = droht.filter((p) => p.verjaehrung?.status === 'verjaehrt').length;
    const bald = droht.length - verjaehrt;
    const fruehestes = droht.find((p) => p.verjaehrung?.status === 'bald')?.verjaehrung?.handelnBis;
    const teile: string[] = [];
    if (bald > 0 && fruehestes)
        teile.push(
            t(
                _n(
                    '{n} receivable probably becomes time-barred on {date} — act by then if it is still to be enforced.',
                    '{n} receivables probably become time-barred on {date} or later — act by then if they are still to be enforced.',
                    bald,
                ),
                { n: bald, date: deDate(fruehestes) },
            ),
        );
    if (verjaehrt > 0)
        teile.push(
            t(
                _n(
                    '{n} receivable is probably time-barred already; whether that applies here is to be clarified.',
                    '{n} receivables are probably time-barred already; whether that applies here is to be clarified.',
                    verjaehrt,
                ),
                { n: verjaehrt },
            ),
        );
    const betroffen: HinweisBetroffen[] = droht
        .slice(0, BETROFFEN_MAX)
        .map((p) => ({ art: 'rechnung', id: p.rechnungId, zeile: zeile(p) }));
    return [
        {
            ...base,
            level: 'warnung',
            title: _('Open receivables are close to the limitation period'),
            text: `${teile.join(' ')} ${nichtVerfolgt()} ${_('This is not legal advice.')}`,
            status: 'befund',
            betroffen,
            ...(droht.length > BETROFFEN_MAX ? { betroffenWeitere: droht.length - BETROFFEN_MAX } : {}),
            handlungen: [
                {
                    id: 'forderungen',
                    label: _('View receivables'),
                    target: { art: 'ansicht', ansicht: 'rechnungen', filter: 'forderungen' },
                },
                handlungInOrdnung(),
            ],
            fingerprint: hinweisFingerprint(droht.map((p) => `${p.rechnungId}:${p.verjaehrung?.handelnBis}`)),
        },
    ];
}
