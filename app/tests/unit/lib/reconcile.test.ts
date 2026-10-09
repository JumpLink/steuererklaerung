import { describe, it, expect } from '@gjsify/unit';
import {
    dayDiff,
    findStoreMatches,
    pickBestMatch,
    type DocMatchCriteria,
} from '../../../src/core/lib/transactions/reconcile.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: 'tx',
        source: 'camt',
        accountKey: 'camt:acc',
        bookingDate: '2025-03-10',
        amount: -119,
        currency: 'EUR',
        ...over,
    };
}

const incoming: DocMatchCriteria = {
    grossAmount: 119,
    currency: 'EUR',
    direction: 'incoming',
    invoiceDate: '2025-03-01',
    dueDate: '2025-03-15',
    counterpartyName: 'Hetzner Online GmbH',
};

export default async () => {
    await describe('dayDiff', async () => {
        await it('returns whole-day signed differences', async () => {
            expect(dayDiff('2025-03-10', '2025-03-01')).toBe(9);
            expect(dayDiff('2025-03-01', '2025-03-10')).toBe(-9);
            expect(dayDiff('2025-03-10T18:00:00Z', '2025-03-10')).toBe(0);
        });
        await it('returns null for missing or unparseable input', async () => {
            expect(dayDiff(undefined, '2025-03-01')).toBeNull();
            expect(dayDiff('nope', '2025-03-01')).toBeNull();
        });
    });

    await describe('findStoreMatches', async () => {
        await it('matches a debit of equal amount near the invoice date for an incoming invoice', async () => {
            const txs = [tx({ id: 'a', amount: -119, bookingDate: '2025-03-10', counterparty: 'Hetzner Online GmbH' })];
            const [best] = findStoreMatches(incoming, txs);
            expect(best.transaction.id).toBe('a');
            expect(best.amountDiff).toBe(0);
            // invoiceDate 2025-03-01 → +9d, dueDate 2025-03-15 → −5d; the closer (−5) wins.
            expect(best.dayGap).toBe(-5);
            expect(best.score).toBeGreaterThanOrEqual(90);
            expect(best.reasons).toContain('counterparty name match');
        });

        await it('ignores a credit (income) for an incoming invoice (wrong direction)', async () => {
            const txs = [tx({ id: 'credit', amount: 119 })];
            expect(findStoreMatches(incoming, txs)).toHaveLength(0);
        });

        await it('requires the credit direction for an outgoing invoice', async () => {
            const outgoing: DocMatchCriteria = { grossAmount: 500, direction: 'outgoing', invoiceDate: '2025-04-01' };
            const debit = tx({ id: 'd', amount: -500, bookingDate: '2025-04-05' });
            const credit = tx({ id: 'c', amount: 500, bookingDate: '2025-04-05' });
            const got = findStoreMatches(outgoing, [debit, credit]);
            expect(got.map((c) => c.transaction.id)).toStrictEqual(['c']);
        });

        await it('excludes amounts outside the tolerance', async () => {
            const txs = [tx({ id: 'off', amount: -120 })]; // 1 EUR off, default tolerance 0.01
            expect(findStoreMatches(incoming, txs)).toHaveLength(0);
        });

        await it('accepts a near-cent difference within tolerance', async () => {
            const txs = [tx({ id: 'near', amount: -119.005 })];
            expect(findStoreMatches(incoming, txs)).toHaveLength(1);
        });

        await it('drops a same-amount transaction far outside the day-gap window', async () => {
            const txs = [tx({ id: 'far', amount: -119, bookingDate: '2025-09-01' })];
            expect(findStoreMatches(incoming, txs)).toHaveLength(0);
        });

        await it('uses the due date when the invoice date is far but the payment is near due', async () => {
            const crit: DocMatchCriteria = {
                grossAmount: 119,
                direction: 'incoming',
                invoiceDate: '2025-01-01',
                dueDate: '2025-03-12',
            };
            const txs = [tx({ id: 'due', amount: -119, bookingDate: '2025-03-14' })];
            const [best] = findStoreMatches(crit, txs);
            expect(best.transaction.id).toBe('due');
            expect(best.dayGap).toBe(2);
        });

        await it('penalises a currency mismatch', async () => {
            const eur = findStoreMatches(incoming, [tx({ id: 'eur', amount: -119, currency: 'EUR' })])[0];
            const usd = findStoreMatches(
                { ...incoming, currency: 'USD' },
                [tx({ id: 'usd', amount: -119, currency: 'EUR' })],
            )[0];
            expect(usd.score).toBeLessThan(eur.score);
            expect(usd.reasons.some((r) => r.includes('currency mismatch'))).toBe(true);
        });
    });

    await describe('pickBestMatch', async () => {
        await it('is confident with a single clear winner', async () => {
            const cands = findStoreMatches(incoming, [tx({ id: 'a', amount: -119, bookingDate: '2025-03-10', counterparty: 'Hetzner' })]);
            const { match, confident } = pickBestMatch(cands);
            expect(confident).toBe(true);
            expect(match?.transaction.id).toBe('a');
        });

        await it('is not confident when two equal-amount transactions sit on the same date', async () => {
            const txs = [
                tx({ id: 'a', amount: -119, bookingDate: '2025-03-12' }),
                tx({ id: 'b', amount: -119, bookingDate: '2025-03-12' }),
            ];
            const { confident, rivals } = pickBestMatch(findStoreMatches({ ...incoming, counterpartyName: undefined }, txs));
            expect(confident).toBe(false);
            expect(rivals.length).toBe(2);
        });

        await it('returns no match for an empty candidate list', async () => {
            expect(pickBestMatch([])).toStrictEqual({ match: null, confident: false, rivals: [] });
        });
    });

    await describe('invoice-number disambiguation', async () => {
        const crit: DocMatchCriteria = {
            grossAmount: 128.52,
            direction: 'outgoing',
            invoiceDate: '2025-03-01',
            invoiceNumber: 'RE-00055',
        };
        const rivals = [
            tx({ id: 'other', amount: 128.52, bookingDate: '2025-03-05', purpose: 'Verkaufserlöse' }),
            tx({ id: 'right', amount: 128.52, bookingDate: '2025-03-05', purpose: 'ReNr RE-00055 Oktober' }),
        ];

        await it('is ambiguous on amount+date alone but confident with the invoice number', async () => {
            const noNum = pickBestMatch(findStoreMatches({ ...crit, invoiceNumber: undefined }, rivals));
            expect(noNum.confident).toBe(false);

            const withNum = findStoreMatches(crit, rivals);
            const best = pickBestMatch(withNum);
            expect(best.confident).toBe(true);
            expect(best.match?.transaction.id).toBe('right');
            expect(best.match?.reasons).toContain('invoice no. in reference');
        });

        await it('matches the numeric tail when the prefix differs (e.g. "Re 00055")', async () => {
            const txs = [tx({ id: 'tail', amount: 128.52, bookingDate: '2025-03-05', purpose: 'Re 00055 vom 01.03.' })];
            const [best] = findStoreMatches(crit, txs);
            expect(best.reasons).toContain('invoice no. in reference');
        });
    });

    await describe('nearest-date disambiguation (recurring same amount)', async () => {
        await it('confidently picks the temporally-nearest of two same-amount monthly payments', async () => {
            const crit: DocMatchCriteria = { grossAmount: 49.23, direction: 'incoming', invoiceDate: '2025-03-03' };
            const txs: UnifiedTransaction[] = [
                tx({ id: 'feb', amount: -49.23, bookingDate: '2025-02-01' }),
                tx({ id: 'mar', amount: -49.23, bookingDate: '2025-03-05' }),
            ];
            const best = pickBestMatch(findStoreMatches(crit, txs));
            expect(best.confident).toBe(true);
            expect(best.match?.transaction.id).toBe('mar');
        });
    });

    await describe('foreign-currency matching (USD invoice → EUR booking)', async () => {
        await it('matches by supplier name + nearest date, ignoring the amount', async () => {
            const crit: DocMatchCriteria = {
                grossAmount: 256.40, currency: 'USD', direction: 'incoming',
                invoiceDate: '2025-03-01', counterpartyName: 'DigitalOcean LLC', foreignCurrency: true,
            };
            const txs: UnifiedTransaction[] = [
                tx({ id: 'do', amount: -247.04, bookingDate: '2025-03-02', purpose: 'PP.1555.PP DIGITALOCEAN COM' }),
                tx({ id: 'other', amount: -247.04, bookingDate: '2025-03-02', purpose: 'Something else' }),
            ];
            const best = pickBestMatch(findStoreMatches(crit, txs));
            expect(best.confident).toBe(true);
            expect(best.match?.transaction.id).toBe('do');
            expect(best.match?.reasons.some((r) => r.startsWith('fx:'))).toBe(true);
        });

        await it('does not match a foreign-currency doc when the supplier is not named in any booking', async () => {
            const crit: DocMatchCriteria = {
                grossAmount: 100, currency: 'USD', direction: 'incoming',
                invoiceDate: '2025-03-01', counterpartyName: 'Acme Inc', foreignCurrency: true,
            };
            const txs = [tx({ id: 'x', amount: -88, bookingDate: '2025-03-02', purpose: 'unrelated debit' })];
            expect(findStoreMatches(crit, txs)).toHaveLength(0);
        });
    });

    await describe('matching edge cases', async () => {
        await it('keeps a payment exactly maxDayGap (60d) out, drops one beyond it', async () => {
            const crit: DocMatchCriteria = { grossAmount: 119, direction: 'incoming', invoiceDate: '2025-01-01' };
            expect(findStoreMatches(crit, [tx({ amount: -119, bookingDate: '2025-03-02' })])).toHaveLength(1); // +60d
            expect(findStoreMatches(crit, [tx({ amount: -119, bookingDate: '2025-03-03' })])).toHaveLength(0); // +61d
        });

        await it('excludes a zero-amount transaction in either direction (direction filter)', async () => {
            const incoming: DocMatchCriteria = { grossAmount: 0, direction: 'incoming', invoiceDate: '2025-03-10' };
            const outgoing: DocMatchCriteria = { grossAmount: 0, direction: 'outgoing', invoiceDate: '2025-03-10' };
            expect(findStoreMatches(incoming, [tx({ amount: 0 })])).toHaveLength(0);
            expect(findStoreMatches(outgoing, [tx({ amount: 0 })])).toHaveLength(0);
        });

        await it('applies no currency penalty when the transaction carries no currency', async () => {
            const crit: DocMatchCriteria = { grossAmount: 119, currency: 'EUR', direction: 'incoming', invoiceDate: '2025-03-10' };
            const got = findStoreMatches(crit, [tx({ amount: -119, bookingDate: '2025-03-10', currency: undefined as unknown as string })]);
            expect(got).toHaveLength(1);
            expect(got[0].reasons.some((r) => r.includes('currency mismatch'))).toBe(false);
        });
    });
};
