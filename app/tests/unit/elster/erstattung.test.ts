import { describe, it, expect, beforeEach, afterEach } from '@gjsify/unit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import {
    aggregateEuerByTransactions,
    classifyTransaction,
    type EuerErstattung,
    type TxDocInfo,
} from '../../../src/core/elster/euer-transactions.ts';
import {
    ERSTATTUNG_FENSTER_TAGE,
    bereitsErstattet,
    erbeVonUrsprung,
    erstattungKandidaten,
    geerbterSteuersatz,
    istErstattungsEingang,
    offeneErstattungen,
    ursprungLabel,
    type ErstattungBuchung,
    type ErstattungEntscheidung,
} from '../../../src/core/elster/erstattung.ts';
import { herkunftText, istErstattung, wasGiltDanach, zuPruefenQueue } from '../../../src/core/elster/zu-pruefen.ts';
import { buildHomeModel } from '../../../src/core/elster/home.ts';
import { computeHinweise } from '../../../src/core/elster/hinweise.ts';
import {
    loadErstattungLinks,
    loadEuerErstattungen,
    removeErstattungLink,
    saveErstattungAbgelehnt,
    saveErstattungLink,
} from '../../../src/core/actions/erstattungen.ts';
import { getDecisionLog } from '../../../src/core/actions/classifications.ts';

// All bookings, names and amounts below are invented.
let n = 0;
function b(over: Partial<ErstattungBuchung>): ErstattungBuchung {
    return {
        id: `eb${n++}`,
        bookingDate: '2026-03-10',
        amount: -119,
        counterparty: 'Büromöbel Kranich GmbH',
        kind: 'expense',
        source: 'document',
        category: '4930 Bürobedarf',
        net: 100,
        vat: 19,
        ...over,
    };
}
function credit(over: Partial<ErstattungBuchung>): ErstattungBuchung {
    return b({
        amount: 119,
        kind: 'income',
        source: 'unclassified',
        category: '(unklassifiziert)',
        net: 0,
        vat: 0,
        ...over,
    });
}
function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: `et${n++}`,
        source: 'camt',
        accountKey: 'camt:test',
        bookingDate: '2026-03-10',
        amount: -119,
        currency: 'EUR',
        ...over,
    };
}
const BUERO = '4930 Bürobedarf';
const doc = (net: number, vat: number, category = BUERO): TxDocInfo => ({
    category,
    netEur: net,
    vatEur: vat,
    currency: 'EUR',
});

export default async () => {
    await describe('Erstattungen: Kandidaten', async () => {
        await it('ranks the exact amount first, then a shared order number, then the newest debit', async () => {
            const refund = credit({
                bookingDate: '2026-04-02',
                amount: 59.5,
                purpose: 'Gutschrift Bestellung KR-4711',
            });
            const exakt = b({ id: 'exakt', bookingDate: '2026-01-05', amount: -59.5 });
            const zweck = b({ id: 'zweck', bookingDate: '2026-02-01', amount: -119, purpose: 'Bestellung KR-4711' });
            const neu = b({ id: 'neu', bookingDate: '2026-03-01', amount: -238 });
            const alt = b({ id: 'alt', bookingDate: '2026-01-01', amount: -238 });
            const k = erstattungKandidaten(refund, [alt, neu, zweck, exakt, refund], []);
            expect(k.map((c) => c.original.id).join(',')).toBe('exakt,zweck,neu,alt');
            expect(k[0].exakt).toBe(true);
            expect(k[1].zweckTreffer).toBe(true);
        });

        await it('needs the same party, an earlier debit inside the window and enough left to refund', async () => {
            const refund = credit({ bookingDate: '2026-04-02', amount: 119 });
            const fremd = b({ counterparty: 'Andere Firma AG' });
            const spaeter = b({ bookingDate: '2026-04-03' });
            const zuAlt = b({ bookingDate: '2025-03-01' });
            const zuKlein = b({ amount: -50 });
            const kurzForm = b({ id: 'kurz', counterparty: 'Büromöbel Kranich' });
            const k = erstattungKandidaten(refund, [fremd, spaeter, zuAlt, zuKlein, kurzForm], []);
            expect(k.map((c) => c.original.id).join(',')).toBe('kurz');
            expect(ERSTATTUNG_FENSTER_TAGE).toBe(365);
        });

        await it('offers only credits that may be refunds', async () => {
            const o = b({});
            expect(erstattungKandidaten(credit({}), [o], []).length).toBe(1);
            expect(
                istErstattungsEingang(
                    credit({
                        source: 'rule',
                        kind: 'income',
                        matchedRule: { id: 'x', label: 'x', art: 'eingebaut', auffang: true },
                    }),
                ),
            ).toBe(true);
            // a receipt (customer payment), an Umbuchung, a double payment, own money, a known customer
            expect(istErstattungsEingang(credit({ source: 'document' }))).toBe(false);
            expect(istErstattungsEingang(credit({ source: 'manual' }))).toBe(false);
            expect(
                istErstattungsEingang(
                    credit({
                        source: 'rule',
                        kind: 'neutral',
                        matchedRule: { id: 'd', label: 'D', art: 'doppelzahlung' },
                    }),
                ),
            ).toBe(false);
            expect(
                istErstattungsEingang(credit({ source: 'rule', kind: 'neutral', category: '1360 Geldtransit' })),
            ).toBe(false);
            expect(
                istErstattungsEingang(
                    credit({ source: 'rule', kind: 'income', matchedRule: { id: 'k', label: 'Kunde', art: 'eigene' } }),
                ),
            ).toBe(false);
            // a debit is no refund, and an unclassified debit is no original
            expect(erstattungKandidaten(b({}), [o], []).length).toBe(0);
            expect(erstattungKandidaten(credit({}), [b({ source: 'unclassified', kind: 'income' })], []).length).toBe(
                0,
            );
        });

        await it('skips a rejected candidate for that refund only', async () => {
            const refund = credit({ id: 'r1' });
            const other = credit({ id: 'r2' });
            const o = b({ id: 'o1' });
            const nein: ErstattungEntscheidung[] = [{ refundTxId: 'r1', originalTxId: 'o1', status: 'rejected' }];
            expect(erstattungKandidaten(refund, [o], nein).length).toBe(0);
            expect(erstattungKandidaten(other, [o], nein).length).toBe(1);
        });
    });

    await describe('Erstattungen: Teil- und Mehrfacherstattung', async () => {
        await it('lets two partial refunds use up one debit and refuses a third', async () => {
            const o = b({ id: 'o', amount: -119 });
            const r1 = credit({ id: 'r1', amount: 59.5, bookingDate: '2026-04-01' });
            const r2 = credit({ id: 'r2', amount: 47.6, bookingDate: '2026-04-15' });
            const r3 = credit({ id: 'r3', amount: 20, bookingDate: '2026-05-01' });
            const links: ErstattungEntscheidung[] = [
                { refundTxId: 'r1', originalTxId: 'o', status: 'linked', betrag: 59.5 },
            ];
            const k2 = erstattungKandidaten(r2, [o], links);
            expect(k2.length).toBe(1);
            expect(k2[0].offen).toBe(59.5);
            expect(k2[0].exakt).toBe(false);
            links.push({ refundTxId: 'r2', originalTxId: 'o', status: 'linked', betrag: 47.6 });
            expect(bereitsErstattet(links).get('o')).toBe(107.1);
            expect(erstattungKandidaten(r3, [o], links).length).toBe(0);
            // the refund being decided does not block itself
            expect(erstattungKandidaten(r1, [o], links).length).toBe(1);
        });

        await it('lists the year’s open refunds and leaves linked ones out', async () => {
            const o = b({ id: 'o', bookingDate: '2025-11-20' });
            const r = credit({ id: 'r', bookingDate: '2026-01-15' });
            const vorjahr = credit({ id: 'v', bookingDate: '2025-12-01' });
            expect(
                offeneErstattungen([o, r, vorjahr], [], 2026)
                    .map((x) => x.buchung.id)
                    .join(','),
            ).toBe('r');
            const linked: ErstattungEntscheidung[] = [
                { refundTxId: 'r', originalTxId: 'o', status: 'linked', betrag: 119 },
            ];
            expect(offeneErstattungen([o, r], linked, 2026).length).toBe(0);
        });

        await it('inherits category, the VAT rate and the receipt', async () => {
            expect(erbeVonUrsprung(b({ documentId: 12 }))).toStrictEqual({
                category: BUERO,
                vatRate: 0.19,
                originalDocumentId: 12,
            });
            expect(geerbterSteuersatz({ net: 100, vat: 7 })).toBe(0.07);
            expect(geerbterSteuersatz({ net: 50, vat: 0 })).toBe(0);
            expect(erbeVonUrsprung(b({ source: 'rule', documentId: 3 })).originalDocumentId).toBe(null);
            expect(ursprungLabel({ bookingDate: '2026-03-10', counterparty: 'Büromöbel Kranich GmbH' })).toBe(
                'Buchung vom 10.03.2026 (Büromöbel Kranich GmbH)',
            );
        });
    });

    await describe('Erstattungen: EÜR und Vorsteuer', async () => {
        const original = tx({
            id: 'orig',
            bookingDate: '2026-03-10',
            amount: -119,
            counterparty: 'Büromöbel Kranich GmbH',
        });
        const refund = tx({
            id: 'ref',
            bookingDate: '2026-05-04',
            amount: 59.5,
            counterparty: 'Büromöbel Kranich GmbH',
            purpose: 'Gutschrift',
        });
        const umsatz = tx({ id: 'ums', bookingDate: '2026-05-05', amount: 238, counterparty: 'Kundin A' });
        const miete = tx({ id: 'miete', bookingDate: '2026-05-01', amount: -500, counterparty: 'Hausverwaltung' });
        const docs = new Map<string, TxDocInfo>([
            ['orig', doc(100, 19)],
            ['ums', doc(200, 38, '8400 Erlöse 19% USt')],
            ['miete', doc(500, 0, '4210 Miete/Raumkosten')],
        ]);
        const link: EuerErstattung = {
            originalTxId: 'orig',
            category: BUERO,
            vatRate: 0.19,
            originalLabel: 'Buchung vom 10.03.2026 (Büromöbel Kranich GmbH)',
        };
        const txs = [original, refund, umsatz, miete];

        await it('reduces the original category and its Vorsteuer, nothing else', async () => {
            const ohne = aggregateEuerByTransactions(txs, docs, 2026, { detail: true });
            const mit = aggregateEuerByTransactions(txs, docs, 2026, {
                detail: true,
                erstattungen: new Map([['ref', link]]),
            });
            const cat = (a: typeof mit, c: string) => [...a.expenses, ...a.income].find((x) => x.category === c);
            expect(cat(mit, BUERO)!.net).toBe(50);
            expect(cat(mit, BUERO)!.vat).toBe(9.5);
            expect(mit.totals.expenseNet).toBe(Math.round((ohne.totals.expenseNet - 50) * 100) / 100);
            expect(mit.totals.inputVat).toBe(Math.round((ohne.totals.inputVat - 9.5) * 100) / 100);
            // Without the link the unclassified credit counted as revenue with output VAT; with it, the
            // revenue is only the real sale and the Vorsteuer shrinks instead.
            expect(ohne.totals.incomeNet).toBe(250);
            expect(ohne.totals.outputVat).toBe(47.5);
            expect(mit.totals.incomeNet).toBe(200);
            expect(mit.totals.outputVat).toBe(38);
            expect(mit.totals.profit).toBe(ohne.totals.profit);
            expect(mit.totals.vatPayable).toBe(ohne.totals.vatPayable);
            expect(cat(mit, '4210 Miete/Raumkosten')!.net).toBe(cat(ohne, '4210 Miete/Raumkosten')!.net);
            expect(ohne.coverage.unclassified.some((u) => u.id === 'ref')).toBe(true);
            expect(mit.coverage.unclassified.some((u) => u.id === 'ref')).toBe(false);
        });

        await it('books the Vorsteuer correction on the refund’s date (its Voranmeldungszeitraum)', async () => {
            const mit = aggregateEuerByTransactions(txs, docs, 2026, {
                detail: true,
                erstattungen: new Map([['ref', link]]),
            });
            const row = mit.detail!.find((r) => r.id === 'ref')!;
            expect(row.bookingDate).toBe('2026-05-04'); // Q2, not the original's Q1
            expect(row.vat).toBe(-9.5);
            expect(row.net).toBe(-50);
            const q1 = mit
                .detail!.filter((r) => r.bookingDate < '2026-04-01' && r.kind === 'expense')
                .reduce((s, r) => s + r.vat, 0);
            expect(q1).toBe(19);
            expect(herkunftText(row)).toBe('via Erstattung zu Buchung vom 10.03.2026 (Büromöbel Kranich GmbH)');
        });

        await it('books a refund of a 2025 debit in 2026 and leaves 2025 untouched', async () => {
            const alt = tx({
                id: 'alt',
                bookingDate: '2025-12-12',
                amount: -119,
                counterparty: 'Büromöbel Kranich GmbH',
            });
            const rueck = tx({
                id: 'rueck',
                bookingDate: '2026-01-20',
                amount: 119,
                counterparty: 'Büromöbel Kranich GmbH',
            });
            const d = new Map([['alt', doc(100, 19)]]);
            const l = new Map([['rueck', { ...link, originalTxId: 'alt' }]]);
            const y25ohne = aggregateEuerByTransactions([alt, rueck], d, 2025);
            const y25mit = aggregateEuerByTransactions([alt, rueck], d, 2025, { erstattungen: l });
            expect(JSON.stringify(y25mit.totals)).toBe(JSON.stringify(y25ohne.totals));
            expect(y25mit.totals.inputVat).toBe(19);
            const y26 = aggregateEuerByTransactions([alt, rueck], d, 2026, { erstattungen: l });
            expect(y26.totals.expenseNet).toBe(-100);
            expect(y26.totals.inputVat).toBe(-19);
            expect(y26.totals.incomeNet).toBe(0);
        });

        await it('undoes to what applied before, and an Umbuchung still wins', async () => {
            const mit = aggregateEuerByTransactions(txs, docs, 2026, {
                detail: true,
                erstattungen: new Map([['ref', link]]),
            });
            const row = mit.detail!.find((r) => r.id === 'ref')!;
            expect(istErstattung(row)).toBe(true);
            expect(row.ohneUmbuchung?.source).toBe('unclassified');
            expect(wasGiltDanach(row)).toBe('Danach ist die Buchung unklassifiziert.');
            const umgebucht = classifyTransaction(refund, undefined, {
                override: { category: '8500 Sonstige Erträge/Zinsen' },
                erstattung: link,
            });
            expect(umgebucht.source).toBe('manual');
            const auffang = classifyTransaction(refund, undefined, { erstattung: link });
            expect(auffang.matchedRule?.art).toBe('erstattung');
            expect(auffang.vatRate).toBe(0.19);
        });
    });

    await describe('Erstattungen: Zu prüfen und Als Nächstes', async () => {
        await it('puts an open refund into the queue with its own reason', async () => {
            const rows = [
                { id: 'a', source: 'unclassified' as const, category: '(unklassifiziert)' },
                { id: 'b', source: 'rule' as const, category: BUERO },
            ];
            const q = zuPruefenQueue(rows, new Map(), new Set(['a', 'b']));
            expect(q.map((r) => `${r.id}:${r.grund}`).join(',')).toBe('a:erstattung,b:erstattung');
        });

        await it('shows one task each and none for the unclassified hint', async () => {
            const hinweise = computeHinweise({
                year: 2026,
                umsatz: 0,
                outputVat: 0,
                unclassified: 1,
                unclassifiedRows: [{ id: 'x', bookingDate: '2026-01-01', amount: 5 }],
            });
            const m = buildHomeModel({
                year: 2026,
                txs: [],
                dashboard: null,
                hinweise,
                zuPruefen: 0,
                erstattungenOffen: 2,
            });
            expect(
                m.tasks
                    .filter((t) => t.kind === 'erstattungen')
                    .map((t) => t.title)
                    .join(),
            ).toBe('2 Erstattungen zuordnen');
            expect(m.tasks.some((t) => t.ref === 'unklassifiziert')).toBe(false);
            expect(m.tasks.some((t) => t.kind === 'zu-pruefen')).toBe(false);
        });
    });

    await describe('Erstattungen: Entscheidungen im Ledger', async () => {
        let dir = '';
        let prev: string | undefined;
        beforeEach(async () => {
            prev = process.env.LEDGER_DB_PATH;
            dir = mkdtempSync(join(tmpdir(), 'bh-erstattung-'));
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
        });
        afterEach(async () => {
            if (prev === undefined) delete process.env.LEDGER_DB_PATH;
            else process.env.LEDGER_DB_PATH = prev;
            rmSync(dir, { recursive: true, force: true });
        });

        await it('reads nothing and creates nothing on a fresh store', async () => {
            expect(loadErstattungLinks().length).toBe(0);
            expect(loadEuerErstattungen(['r'], () => undefined).size).toBe(0);
        });

        await it('stores „Ja", replaces an earlier link, keeps „Nein" and undoes with a log', async () => {
            saveErstattungLink({
                refundTxId: 'r',
                originalTxId: 'o1',
                category: BUERO,
                vatRate: 0.19,
                originalDocumentId: 7,
            });
            saveErstattungLink({
                refundTxId: 'r',
                originalTxId: 'o2',
                category: '4964 Software/Lizenzen',
                vatRate: 0.19,
            });
            saveErstattungAbgelehnt('r', 'o3', 'test');
            const links = loadErstattungLinks(['r']);
            expect(
                links
                    .filter((l) => l.status === 'linked')
                    .map((l) => l.originalTxId)
                    .join(),
            ).toBe('o2');
            expect(
                links
                    .filter((l) => l.status === 'rejected')
                    .map((l) => l.originalTxId)
                    .join(),
            ).toBe('o3');
            const euer = loadEuerErstattungen(['r'], (id) =>
                id === 'o2' ? { bookingDate: '2026-02-01', counterparty: 'Pixel' } : undefined,
            );
            expect(euer.get('r')?.category).toBe('4964 Software/Lizenzen');
            expect(euer.get('r')?.originalLabel).toBe('Buchung vom 01.02.2026 (Pixel)');
            expect(removeErstattungLink('r')).toBe(true);
            expect(removeErstattungLink('r')).toBe(false);
            expect(
                loadErstattungLinks(['r'])
                    .map((l) => l.status)
                    .join(),
            ).toBe('rejected');
            expect(
                getDecisionLog('r')
                    .map((e) => e.action)
                    .join(','),
            ).toBe('erstattung.link,erstattung.link,erstattung.reject,erstattung.remove');
        });
    });
};
