// Shared display constants + helpers for the web views (avoids drift between the
// transactions list, the detail modal, and the PDF report).

import type { TxRow } from './api.ts';
import type { BhTxDetail } from '../components/bh-tx-detail.ts';

/** Month abbreviations for the BWA + Belege month grouping (index 1–12; [0] is unused). */
export { MONTHS } from '../../../../core/lib/format.ts';

/** A Vorsteuer-bearing expense with no linked receipt — the audit-relevant Beleg gap. */
export const isVstNoBeleg = (r: TxRow): boolean => r.kind === 'expense' && Math.abs(r.vat) > 0.005 && !r.receipt;

/** Await `ms` milliseconds (poll spacing for rebuild/status watchers). */
export const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** Read a File as raw base64 (strips the `data:…;base64,` prefix) for the upload API. */
export function readBase64(file: File): Promise<string> {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res((r.result as string).split(',')[1] ?? '');
        r.onerror = () => rej(r.error ?? new Error('Datei konnte nicht gelesen werden.'));
        r.readAsDataURL(file);
    });
}

/** Open (or reuse) the shared <bh-tx-detail> modal for a transaction row. */
export function openTxDetail(row: TxRow, base: string | null): void {
    let detail = document.querySelector('bh-tx-detail') as BhTxDetail | null;
    if (!detail) {
        detail = document.createElement('bh-tx-detail') as BhTxDetail;
        document.body.appendChild(detail);
    }
    detail.open(row, base);
}

/** Classification source → German label. */
export const SOURCE_LABEL: Record<string, string> = {
    document: 'Beleg',
    rule: 'Regel',
    unclassified: 'unklassifiziert',
};

/** EÜR kind → German label. */
export const KIND_LABEL: Record<string, string> = {
    income: 'Einnahme',
    expense: 'Ausgabe',
    neutral: 'neutral / durchlaufend',
};

/**
 * Split a Betriebsaufgabe `coverage.outsidePeriod` list into the kept §24 posts (in the
 * result, GewSt-free) vs the excluded successor/JumpLink posts, with the kept income/expense
 * sums. Used by both the transactions banner and the PDF report.
 */
export function aufgabeCoverage<T extends { included: boolean; kind: string; net: number }>(
    outside: T[],
): { kept: T[]; excluded: T[]; keptInc: number; keptExp: number } {
    const kept = outside.filter((o) => o.included);
    const excluded = outside.filter((o) => !o.included && o.kind !== 'neutral');
    return {
        kept,
        excluded,
        keptInc: kept.filter((o) => o.kind === 'income').reduce((s, o) => s + o.net, 0),
        keptExp: kept.filter((o) => o.kind === 'expense').reduce((s, o) => s + o.net, 0),
    };
}
