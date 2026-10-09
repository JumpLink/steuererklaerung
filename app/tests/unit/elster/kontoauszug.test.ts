import { describe, it, expect } from '@gjsify/unit';
import {
    pruefeKontoauszuege,
    type KontoauszugKonto,
    type KontoauszugStatement,
} from '../../../src/core/elster/kontoauszug.ts';

/** Monthly bookings: `perMonth` of −10 € on the 5th..(5+n) of each listed month. */
function monthly(year: number, months: number[], perMonth = 3): { bookingDate: string; amount: number }[] {
    const out: { bookingDate: string; amount: number }[] = [];
    for (const m of months) {
        for (let d = 0; d < perMonth; d++) {
            out.push({
                bookingDate: `${year}-${String(m).padStart(2, '0')}-${String(5 + d).padStart(2, '0')}`,
                amount: -10,
            });
        }
    }
    return out;
}

const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** Statements matching `monthly(...)` exactly, with a running balance from `start`. */
function statements(year: number, months: number[], perMonth = 3, start = 1000): KontoauszugStatement[] {
    let bal = start;
    const out: KontoauszugStatement[] = [];
    for (const m of months) {
        const mm = String(m).padStart(2, '0');
        const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
        const sum = -10 * perMonth;
        out.push({
            from: `${year}-${mm}-01`,
            to: `${year}-${mm}-${last}`,
            opening: bal,
            closing: bal + sum,
            seq: m,
            sum,
        });
        bal += sum;
    }
    return out;
}

function konto(over: Partial<KontoauszugKonto>): KontoauszugKonto {
    return { accountKey: 'camt:DE00TEST', label: 'Testbank', source: 'camt', txs: [], statements: [], ...over };
}

const run = (k: KontoauszugKonto, extra: { businessEndDate?: string; today?: string } = {}) =>
    pruefeKontoauszuege({
        year: 2025,
        konten: [k],
        today: extra.today ?? '2026-03-01',
        businessEndDate: extra.businessEndDate,
    });

export default async () => {
    await describe('Kontoauszug lückenlos? — statements with balances', async () => {
        await it('ohne_befund with what was checked when the chain holds', async () => {
            const [h] = run(konto({ txs: monthly(2025, ALL), statements: statements(2025, ALL) }));
            expect(h.status).toBe('ohne_befund');
            expect(h.key).toBe('kontoauszug:camt:DE00TEST');
            expect(h.geprueft).toContain('Anfangssaldo + Umsätze = Endsaldo');
            expect(h.geprueft).toContain('Auszugsnummern fortlaufend');
            expect(h.handlungen).toBe(undefined);
        });

        await it('befund when opening + entries ≠ closing within one statement', async () => {
            const st = statements(2025, ALL);
            st[3] = { ...st[3], closing: st[3].closing! + 5 };
            st[4] = { ...st[4], opening: st[4].opening! + 5, closing: st[4].closing! + 5 };
            const [h] = run(konto({ txs: monthly(2025, ALL), statements: st.slice(0, 5) }));
            expect(h.status).toBe('befund');
            expect(h.text).toContain('≠ Endsaldo');
            expect(h.text).toContain('Differenz');
            expect(h.handlungen?.map((a) => a.id)).toStrictEqual(['kontoauszug-importieren', 'in-ordnung']);
            expect(typeof h.fingerprint).toBe('string');
        });

        await it('befund for a missing statement: number gap + broken balance chain, reported once', async () => {
            const st = statements(2025, ALL).filter((s) => s.seq !== 9);
            const [h] = run(konto({ txs: monthly(2025, ALL), statements: st }));
            expect(h.status).toBe('befund');
            expect(h.text).toContain('Zwischen 31.08.2025 und 01.10.2025 fehlt vermutlich ein Auszug (Nr. 9)');
            expect(h.text).toContain('Endsaldo');
            expect(h.text.split('fehlt vermutlich').length).toBe(2);
        });

        await it('befund when the statements and the stored bookings disagree', async () => {
            const txs = monthly(2025, ALL).filter((t, n) => n !== 7); // one booking lost in the store
            const [h] = run(konto({ txs, statements: statements(2025, ALL) }));
            expect(h.status).toBe('befund');
            expect(h.text).toContain('vermutlich fehlen Buchungen');
        });

        await it('a closed account (last statement ends at 0 €) is no gap after its closing date', async () => {
            const months = [1, 2, 3, 4, 5];
            const st = statements(2025, months, 3, 150); // 150 − 5×30 = 0
            const [h] = run(konto({ txs: monthly(2025, months), statements: st }));
            expect(h.status).toBe('ohne_befund');
            expect(h.text).toContain('Nach dem 31.05.2025 nicht geprüft');
        });
    });

    await describe('Kontoauszug lückenlos? — accounts without balances', async () => {
        await it('nicht_pruefbar „weil das Konto keine Salden liefert" when no month is empty', async () => {
            const [h] = run(konto({ source: 'qonto', txs: monthly(2025, ALL) }));
            expect(h.status).toBe('nicht_pruefbar');
            expect(h.weil).toBe('das Konto keine Salden liefert');
            expect(h.handlungen?.[0].id).toBe('kontoauszug-importieren');
        });

        await it('befund for an empty month on an otherwise busy account', async () => {
            const [h] = run(
                konto({
                    source: 'qonto',
                    txs: monthly(
                        2025,
                        ALL.filter((m) => m !== 4 && m !== 5),
                    ),
                }),
            );
            expect(h.status).toBe('befund');
            expect(h.text).toContain('Keine Umsätze im April bis Mai 2025');
            expect(h.text).toContain('erst mit importierten Kontoauszügen');
        });

        await it('a quiet account (one booking now and then) is not a gap', async () => {
            const [h] = run(konto({ source: 'qonto', txs: monthly(2025, [1, 4, 9], 1) }));
            expect(h.status).toBe('nicht_pruefbar');
        });

        await it('the dissolved business: nothing after business_end_date is a gap', async () => {
            const [h] = run(konto({ txs: monthly(2025, [1, 2, 3, 4, 5, 6]) }), { businessEndDate: '2025-06-30' });
            expect(h.status).toBe('nicht_pruefbar');
            const [open] = run(konto({ txs: monthly(2025, [1, 2, 3, 4, 5, 6]) }));
            expect(open.status).toBe('befund');
            expect(open.text).toContain('Juli bis Dezember 2025');
        });

        await it('the running year: a tail without bookings is „not imported yet", not a gap', async () => {
            const [h] = run(konto({ source: 'qonto', txs: monthly(2025, [1, 2, 3, 4, 5, 6]) }), {
                today: '2025-10-08',
            });
            expect(h.status).toBe('nicht_pruefbar');
        });

        await it('the months before the first booking are no gap', async () => {
            const [h] = run(konto({ source: 'qonto', txs: monthly(2025, [7, 8, 9, 10, 11, 12]) }));
            expect(h.status).toBe('nicht_pruefbar');
        });

        await it('skips PayPal and accounts without data in or around the year', async () => {
            expect(run(konto({ source: 'paypal', txs: monthly(2025, [1, 3]) })).length).toBe(0);
            expect(run(konto({ txs: monthly(2024, ALL) })).length).toBe(0);
        });

        await it('a whole year missing between data before and after is a finding', async () => {
            const [h] = run(konto({ txs: [...monthly(2024, ALL), ...monthly(2026, [1])] }));
            expect(h.status).toBe('befund');
            expect(h.text).toContain('weder Umsätze noch Auszug');
        });

        await it('the same finding gives the same fingerprint; a different one a new print', async () => {
            const a = run(
                konto({
                    source: 'qonto',
                    txs: monthly(
                        2025,
                        ALL.filter((m) => m !== 4),
                    ),
                }),
            )[0];
            const b = run(
                konto({
                    source: 'qonto',
                    txs: monthly(
                        2025,
                        ALL.filter((m) => m !== 4),
                    ),
                }),
            )[0];
            const c = run(
                konto({
                    source: 'qonto',
                    txs: monthly(
                        2025,
                        ALL.filter((m) => m !== 4 && m !== 8),
                    ),
                }),
            )[0];
            expect(a.fingerprint).toBe(b.fingerprint);
            expect(a.fingerprint === c.fingerprint).toBe(false);
        });
    });
};
