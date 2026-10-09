/**
 * „Kontoauszug lückenlos?" — per account and year: do the statements chain without a hole, and does
 * every month that should have bookings have some? A missing CAMT file otherwise shrinks the EÜR
 * without anything looking wrong (Idee 4 in docs/ideen-nutzerfuehrung.md).
 *
 * Two kinds of evidence, the stronger one first:
 * 1. **Statements with balances** (CAMT; FinTS statements carry them too): opening + Σ entries =
 *    closing per statement, closing = next opening, the running numbers without a hole, and Σ of the
 *    statements = Σ of the stored bookings over the same days (a statement imported, its bookings
 *    not). A balance chain is far more reliable than counting bookings.
 * 2. **Months without bookings** on an account that is otherwise busy — the only evidence for an
 *    account without statements (Qonto via API, PayPal is enrichment and skipped). Without balances
 *    such an account is `nicht_pruefbar`, unless a month gap shows anyway.
 *
 * Not a gap: the months before the account's first booking, the time after the account was closed
 * (a last statement ending at 0 €) or after the Betriebsaufgabe (`business_end_date`), and the
 * not-yet-imported end of the running year. Pure — the caller loads store + statements.
 */

import { fmtDe as fmt } from '../lib/money.ts';
import { HANDLUNG_IN_ORDNUNG, hinweisFingerprint, type Hinweis, type HinweisHandlung } from './hinweise.ts';

/** Rounding slack when comparing balances: one cent. */
export const SALDO_TOLERANZ = 0.01;

/**
 * Bookings per month an account must average before an empty month counts as suspicious. An app
 * threshold, not a legal number: an account with a booking every few months is no evidence of a gap,
 * one with rent, phone and fees every month is.
 */
export const MIN_UMSAETZE_JE_MONAT = 2;

/** Sources that are no bank account of their own and so have no statements to chain. */
const OHNE_KONTOAUSZUG = new Set(['paypal']);

/** One statement's metadata (structurally `StatementMeta` from the store). */
export interface KontoauszugStatement {
    from: string;
    to: string;
    opening?: number;
    closing?: number;
    seq?: number;
    sum: number;
}

export interface KontoauszugKonto {
    accountKey: string;
    /** Display name, e.g. „Qonto" or the configured account label. */
    label: string;
    source: string;
    /** ALL the account's bookings (any year) — the years around tell where the account starts and ends. */
    txs: { bookingDate: string; amount: number }[];
    statements: KontoauszugStatement[];
}

export interface KontoauszugInput {
    year: number;
    konten: KontoauszugKonto[];
    /** Last day of business (Betriebsaufgabe); nothing after it is a gap. */
    businessEndDate?: string;
    /** Reference date YYYY-MM-DD — decides whether the year is over. */
    today: string;
}

const MONATE = [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
];

const HANDLUNG_IMPORT = (accountKey: string): HinweisHandlung => ({
    id: 'kontoauszug-importieren',
    label: 'Kontoauszug importieren',
    target: { art: 'dialog', dialog: 'kontoauszug-import', ref: accountKey },
});

function deDate(iso: string): string {
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}.${m}.${y}`;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function lastDayOfMonth(year: number, month: number): string {
    const d = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function firstDayOfMonth(year: number, month: number): string {
    return `${year}-${String(month).padStart(2, '0')}-01`;
}

function monthRun(year: number, months: number[]): string {
    if (months.length === 1) return `${MONATE[months[0] - 1]} ${year}`;
    return `${MONATE[months[0] - 1]} bis ${MONATE[months[months.length - 1] - 1]} ${year}`;
}

/** Group sorted month numbers into consecutive runs. */
function runs(months: number[]): number[][] {
    const out: number[][] = [];
    for (const m of months) {
        const last = out[out.length - 1];
        if (last && last[last.length - 1] === m - 1) last.push(m);
        else out.push([m]);
    }
    return out;
}

function pruefeKonto(k: KontoauszugKonto, i: KontoauszugInput): Hinweis | null {
    const year = i.year;
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const txs = [...k.txs].sort((a, b) => (a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0));
    const stmts = [...k.statements].sort((a, b) =>
        a.from !== b.from ? (a.from < b.from ? -1 : 1) : (a.seq ?? 0) - (b.seq ?? 0),
    );
    const inYear = txs.filter((t) => t.bookingDate >= yearStart && t.bookingDate <= yearEnd);
    const stmtsYear = stmts.filter((s) => s.to >= yearStart && s.from <= yearEnd);
    const dataBefore = txs.some((t) => t.bookingDate < yearStart) || stmts.some((s) => s.from < yearStart);
    const dataAfter = txs.some((t) => t.bookingDate > yearEnd) || stmts.some((s) => s.to > yearEnd);

    const key = `kontoauszug:${k.accountKey}`;
    const findings: string[] = [];
    const parts: string[] = [];

    // ── Where the account is alive this year ──
    let end = yearEnd;
    if (i.businessEndDate && i.businessEndDate >= yearStart && i.businessEndDate < end) end = i.businessEndDate;
    const lastStmt = stmts[stmts.length - 1];
    const closedAt =
        lastStmt &&
        lastStmt.closing != null &&
        Math.abs(lastStmt.closing) < 0.005 &&
        !txs.some((t) => t.bookingDate > lastStmt.to)
            ? lastStmt.to
            : undefined;
    if (closedAt && closedAt >= yearStart && closedAt < end) end = closedAt;

    if (inYear.length === 0 && stmtsYear.length === 0) {
        if (!(dataBefore && dataAfter) || (closedAt && closedAt < yearStart)) return null;
        findings.push(
            `Im ganzen Jahr ${year} weder Umsätze noch Auszug, obwohl das Konto davor und danach Umsätze hat`,
        );
        parts.push(`jahr:${year}`);
    }

    // ── 1. Statements ──
    const hasBalances = stmtsYear.some((s) => s.opening != null && s.closing != null);
    for (const s of stmtsYear) {
        if (s.opening == null || s.closing == null) continue;
        const diff = round2(s.opening + s.sum - s.closing);
        if (Math.abs(diff) > SALDO_TOLERANZ) {
            findings.push(
                `Auszug ${deDate(s.from)}–${deDate(s.to)}: Anfangssaldo ${fmt(s.opening)} € + Umsätze ${fmt(s.sum)} € ≠ Endsaldo ${fmt(s.closing)} € (Differenz ${fmt(diff)} €)`,
            );
            parts.push(`saldo:${s.from}:${s.to}`);
        }
    }
    for (let n = 1; n < stmtsYear.length; n++) {
        const a = stmtsYear[n - 1];
        const b = stmtsYear[n];
        // A number lower than its predecessor is a new year's count, not a hole.
        const seqGap = a.seq != null && b.seq != null && b.seq - a.seq > 1;
        const balanceBreak =
            a.closing != null && b.opening != null && Math.abs(round2(a.closing - b.opening)) > SALDO_TOLERANZ;
        if (!seqGap && !balanceBreak) continue;
        const nr = seqGap ? ` (Nr. ${a.seq! + 1}${b.seq! - a.seq! > 2 ? `–${b.seq! - 1}` : ''})` : '';
        const saldo = balanceBreak ? ` — Endsaldo ${fmt(a.closing!)} € ≠ Anfangssaldo ${fmt(b.opening!)} €` : '';
        findings.push(`Zwischen ${deDate(a.to)} und ${deDate(b.from)} fehlt vermutlich ein Auszug${nr}${saldo}`);
        parts.push(`luecke:${a.to}:${b.from}`);
    }
    // Statements and stored bookings agree — only meaningful once the chain itself holds.
    const inside = stmtsYear.filter((s) => s.from >= yearStart && s.to <= yearEnd);
    if (findings.length === 0 && inside.length) {
        const from = inside[0].from;
        const to = inside.reduce((m, s) => (s.to > m ? s.to : m), inside[0].to);
        const stmtSum = round2(inside.reduce((a, s) => a + s.sum, 0));
        const txSum = round2(
            txs.filter((t) => t.bookingDate >= from && t.bookingDate <= to).reduce((a, t) => a + t.amount, 0),
        );
        if (Math.abs(round2(stmtSum - txSum)) > SALDO_TOLERANZ) {
            findings.push(
                `Die Auszüge ${deDate(from)}–${deDate(to)} summieren ${fmt(stmtSum)} €, die Buchungen im selben Zeitraum ${fmt(txSum)} € — vermutlich fehlen Buchungen oder sind doppelt`,
            );
            parts.push(`summe:${from}:${to}`);
        }
    }

    // ── 2. Months without bookings, outside what the statements cover ──
    const firstInYear = [inYear[0]?.bookingDate, stmtsYear[0]?.from].filter(Boolean).sort()[0];
    const start = dataBefore ? yearStart : firstInYear;
    const yearOver = i.today > yearEnd;
    // In the running year (or for an account whose data simply stops) only a hole WITH data after it
    // counts — the tail is "not imported yet", which the next sync answers.
    const lastData = [txs[txs.length - 1]?.bookingDate, lastStmt?.to].filter(Boolean).sort().pop();
    const checkUntil = yearOver || dataAfter ? end : lastData && lastData < end ? lastData : end;
    const covered = (m: number): boolean => {
        const a = firstDayOfMonth(year, m);
        const b = lastDayOfMonth(year, m);
        return stmtsYear.some((s) => s.from <= b && s.to >= a);
    };
    let dichteOk = false;
    if (start && inYear.length) {
        const counts = new Map<number, number>();
        for (const t of inYear)
            counts.set(Number(t.bookingDate.slice(5, 7)), (counts.get(Number(t.bookingDate.slice(5, 7))) ?? 0) + 1);
        const startMonth = Number(start.slice(5, 7));
        const months: number[] = [];
        for (let m = start.slice(0, 4) < String(year) ? 1 : startMonth; m <= 12; m++) {
            if (lastDayOfMonth(year, m) > checkUntil) break;
            months.push(m);
        }
        const active = months.filter((m) => (counts.get(m) ?? 0) > 0);
        const total = active.reduce((a, m) => a + (counts.get(m) ?? 0), 0);
        dichteOk = active.length > 0 && total / active.length >= MIN_UMSAETZE_JE_MONAT;
        if (dichteOk) {
            const empty = months.filter((m) => !counts.get(m) && !covered(m));
            for (const run of runs(empty)) {
                findings.push(
                    `Keine Umsätze im ${monthRun(year, run)}, obwohl das Konto sonst jeden Monat Umsätze hat`,
                );
                for (const m of run) parts.push(`monat:${year}-${String(m).padStart(2, '0')}`);
            }
        }
    }

    const nachEnde =
        end < yearEnd ? ` Nach dem ${deDate(end)} nicht geprüft (Konto aufgelöst oder Betrieb beendet).` : '';
    if (findings.length) {
        return {
            key,
            level: 'warnung',
            title: `Kontoauszug ${k.label}: vermutlich lückenhaft`,
            text:
                `Zu klären: ${findings.join('; ')}. Eine fehlende Auszugsdatei verfälscht die EÜR, ohne dass es auffällt.` +
                (hasBalances ? '' : ' Die Salden lassen sich erst mit importierten Kontoauszügen (CAMT) prüfen.') +
                nachEnde,
            status: 'befund',
            handlungen: [HANDLUNG_IMPORT(k.accountKey), HANDLUNG_IN_ORDNUNG],
            fingerprint: hinweisFingerprint(parts),
        };
    }
    if (hasBalances) {
        const from = stmtsYear[0].from < yearStart ? yearStart : stmtsYear[0].from;
        const lastTo = stmtsYear.reduce((m, s) => (s.to > m ? s.to : m), stmtsYear[0].to);
        const to = lastTo > yearEnd ? yearEnd : lastTo;
        const seq = stmtsYear.every((s) => s.seq != null);
        const ausserhalb = from > yearStart || to < end ? '; außerhalb der Auszüge nur Monate ohne Umsätze' : '';
        return {
            key,
            level: 'info',
            title: `Kontoauszug ${k.label} lückenlos`,
            text: `${stmtsYear.length} Auszüge vom ${deDate(from)} bis ${deDate(to)} geprüft.${nachEnde}`,
            status: 'ohne_befund',
            geprueft:
                `Anfangssaldo + Umsätze = Endsaldo je Auszug, Endsaldo = nächster Anfangssaldo` +
                `${seq ? ', Auszugsnummern fortlaufend' : ''}, Summe der Auszüge = Summe der Buchungen${ausserhalb}`,
        };
    }
    return {
        key,
        level: 'info',
        title: `Kontoauszug ${k.label}: Salden nicht prüfbar`,
        text: dichteOk
            ? `Geprüft wurde nur, ob ein Monat ${year} ohne Umsätze ist — keiner gefunden.${nachEnde}`
            : `Zu wenige Umsätze je Monat, um daran eine Lücke zu erkennen.${nachEnde}`,
        status: 'nicht_pruefbar',
        weil: 'das Konto keine Salden liefert',
        handlungen: [HANDLUNG_IMPORT(k.accountKey)],
    };
}

/** One „Kontoauszug lückenlos?" hint per account that is alive in the year (PayPal is skipped). */
export function pruefeKontoauszuege(i: KontoauszugInput): Hinweis[] {
    const out: Hinweis[] = [];
    for (const k of i.konten) {
        if (OHNE_KONTOAUSZUG.has(k.source)) continue;
        const h = pruefeKonto(k, i);
        if (h) out.push(h);
    }
    return out;
}
