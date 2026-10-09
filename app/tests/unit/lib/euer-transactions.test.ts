import { describe, it, expect } from '@gjsify/unit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    classifyNoDocTransaction,
    aggregateEuerByTransactions,
    type TxClassifyRules,
    type TxDocInfo,
} from '../../../src/core/elster/euer-transactions.ts';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import { doppelzahlungIds } from '../../../src/core/actions/elster/euer.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

let n = 0;
function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return { id: `t${n++}`, source: 'camt', accountKey: 'camt:a', bookingDate: '2025-06-01', amount: -10, currency: 'EUR', ...over };
}

/**
 * A user's configured needles (`elster.klassifizierung`) — entirely invented, like every value in
 * this suite. Everything the rule chain knows about concrete counterparties comes from here; the
 * chain itself only carries signals that are true for any user.
 */
const RULES: TxClassifyRules = {
    eigeneKonten: ['muster & partner gbr'],
    privatGegenseiten: ['www.spielel', 'muster musikdienst', '4711000042'],
    gesellschafterGegenseiten: ['erika mustermann'],
    kskKennungen: ['90000001'],
    erloesGegenseiten: ['musterkunde ag'],
    aufwandRegeln: [
        { muster: 'kanzlei mustermann', kategorie: '4950 Rechts-/Beratungskosten' },
        { muster: 'kundennummer-000000', kategorie: '4921 Telefon/Internet' },
        { muster: 'stadt musterstadt', kategorie: '4650 Sonstige Betriebsausgaben' },
    ],
};

export default async () => {
    await describe('classifyNoDocTransaction', async () => {
        await it('routes internal / private / tax / fee by pattern', async () => {
            expect(classifyNoDocTransaction(tx({ purpose: 'Interne Ueberweisung', counterparty: 'Hauptkonto' })).category).toBe('1360 Interne Überweisung');
            expect(classifyNoDocTransaction(tx({ purpose: 'Ausgleich Verkaufserlöse', counterparty: 'Erika Mustermann' })).category).toBe('1800 Privatentnahme');
            expect(classifyNoDocTransaction(tx({ counterparty: 'Finanzamt', purpose: 'Umsatzsteuer' })).kind).toBe('neutral');
            const fee = classifyNoDocTransaction(tx({ counterparty: 'Qonto', purpose: 'Kartenpreis' }));
            expect(fee.category).toBe('4970 Nebenkosten Geldverkehr');
            expect(fee.kind).toBe('expense');
            // A merchant the user confirmed as private (the camt export truncates it) → private,
            // not a software licence. Only a CONFIGURED needle can decide that.
            expect(
                classifyNoDocTransaction(
                    tx({ purpose: 'PP.1555.PP www.spielel Software-Lizenzen', amount: -39.99 }),
                    RULES,
                ).category,
            ).toBe('1800 Privatentnahme');
        });
        await it('books a GNOME Foundation donation as Privatentnahme, not Reisekosten', async () => {
            // The card charge carries a "GNOME.ORG* DONATION GN" counterparty and Qonto
            // mis-tags it "Travel Expenses / Sonstige Reisekosten" in the purpose. A gift
            // to a US non-profit is a private draw (no GbR expense, no Vorsteuer), NOT 4670.
            const donation = classifyNoDocTransaction(
                tx({
                    counterparty: 'GNOME.ORG* DONATION GN',
                    purpose: 'NONREF Travel Expenses Sonstige Reisekosten 9999 ‹GNOME.ORG* DONATION GN (Karte)›',
                    amount: -9.33,
                }),
            );
            expect(donation.category).toBe('1800 Privatentnahme');
            expect(donation.kind).toBe('neutral');
            // Regression guard: a genuine travel expense still lands in 4670 Reisekosten.
            const travel = classifyNoDocTransaction(tx({ amount: -120, purpose: 'NONREF Reisekosten Bahn 9999' }));
            expect(travel.category).toBe('4670 Reisekosten');
            expect(travel.kind).toBe('expense');
        });
        await it('flags an unknown expense as unclassified', async () => {
            const c = classifyNoDocTransaction(tx({ counterparty: 'Some Shop', purpose: 'Einkauf', amount: -42 }));
            expect(c.source).toBe('unclassified');
            expect(c.kind).toBe('expense');
        });
        await it('treats an owner transfer without an invoice number as a private capital movement', async () => {
            // Owner credit with a stray "Verkaufserlöse" reference (no RE-number) → Einlage, not revenue.
            const credit = classifyNoDocTransaction(
                tx({ counterparty: 'Erika Mustermann', purpose: 'SCTINSTOUT Verkaufserlöse', amount: 2001 }),
                RULES,
            );
            expect(credit.category).toBe('1810 Privateinlage');
            expect(credit.kind).toBe('neutral');
            // Owner debit → Entnahme.
            expect(classifyNoDocTransaction(tx({ counterparty: 'Erika Mustermann', purpose: 'Auszahlung', amount: -300 }), RULES).category).toBe('1800 Privatentnahme');
            // …but a genuinely forwarded customer payment WITH an RE-number stays revenue.
            expect(classifyNoDocTransaction(tx({ counterparty: 'Erika Mustermann', purpose: 'RE-2024-001 Verkaufserlöse', amount: 500 }), RULES).category).toBe('8400 Erlöse 19% USt');
            // Nobody configured → the rule cannot fire, and the payout is simply unknown.
            expect(classifyNoDocTransaction(tx({ counterparty: 'Erika Mustermann', purpose: 'Auszahlung', amount: -300 })).source).toBe('unclassified');
        });
    });

    // The needles that used to be compiled in — owner names, the former firm name, a customer, a
    // supplier's personal name, a KSK membership number, a telco customer number. They decide real
    // money, so each one gets an explicit "configured fires / unconfigured does not" pair.
    await describe('classifyNoDocTransaction — configured needles (elster.klassifizierung)', async () => {
        await it('books a transfer naming an own account as an internal transfer', async () => {
            const t = tx({ counterparty: 'Muster & Partner GbR', purpose: 'SEPA', amount: -500 });
            expect(classifyNoDocTransaction(t, RULES).category).toBe('1360 Interne Überweisung');
            expect(classifyNoDocTransaction(t).source).toBe('unclassified');
        });

        await it('books a confirmed-private merchant as Entnahme/Einlage by direction', async () => {
            expect(classifyNoDocTransaction(tx({ counterparty: 'Muster Musikdienst', amount: -17 }), RULES).category).toBe('1800 Privatentnahme');
            expect(classifyNoDocTransaction(tx({ counterparty: 'Muster Musikdienst', amount: 17 }), RULES).category).toBe('1810 Privateinlage');
            // A bare order reference the enrichment folded in is a needle like any other.
            expect(classifyNoDocTransaction(tx({ purpose: 'NONREF 4711000042', amount: -1.99 }), RULES).kind).toBe('neutral');
            expect(classifyNoDocTransaction(tx({ purpose: 'NONREF 4711000042', amount: -1.99 })).source).toBe('unclassified');
        });

        await it('recognises a KSK membership number, not only the KSK name', async () => {
            // Some banks print the member's number and never the KSK's name. That number belongs
            // to a natural person → configured, never compiled in.
            const t = tx({ purpose: 'DAUERAUFTRAG 90000001', amount: -418 });
            expect(classifyNoDocTransaction(t, RULES).category).toBe('1800 Privatentnahme');
            expect(classifyNoDocTransaction(t).source).toBe('unclassified');
        });

        await it('books a configured customer as revenue without a Verkaufserlöse tag', async () => {
            const t = tx({ counterparty: 'Musterkunde AG', purpose: 'Zahlung', amount: 1200 });
            expect(classifyNoDocTransaction(t, RULES).category).toBe('8400 Erlöse 19% USt');
            expect(classifyNoDocTransaction(t).source).toBe('unclassified');
            // A credit note from that same customer is still NOT revenue.
            expect(
                classifyNoDocTransaction(tx({ counterparty: 'Musterkunde AG', purpose: 'Gutschrift', amount: 90 }), RULES)
                    .source,
            ).toBe('unclassified');
        });

        await it('lets a configured supplier rule win over the generic keyword table', async () => {
            // The booking also says "Telekommunikation" (→ 4921 by keyword); the configured rule
            // for the advisor's name is checked first and wins.
            const t = tx({ counterparty: 'Kanzlei Mustermann', purpose: 'Telekommunikation Beratung', amount: -300 });
            expect(classifyNoDocTransaction(t, RULES).category).toBe('4950 Rechts-/Beratungskosten');
            expect(classifyNoDocTransaction(t).category).toBe('4921 Telefon/Internet');
            // A telco that prints only the customer number, never its own name.
            expect(classifyNoDocTransaction(tx({ purpose: 'Kundennummer-000000', amount: -77.97 }), RULES).category).toBe('4921 Telefon/Internet');
            expect(classifyNoDocTransaction(tx({ purpose: 'Kundennummer-000000', amount: -77.97 })).source).toBe('unclassified');
        });

        /**
         * The mechanism, not just the fix. Every needle that identified a PERSON in this chain was
         * a number a bank prints instead of a name: a KSK membership number, a telco customer
         * number, an order reference. Those are exactly the literals a future "just add the number,
         * it is only a keyword" edit would reintroduce — and nobody would notice in review.
         *
         * SKR03 category codes are four digits; a run of five or more literal digits in this module
         * is therefore always somebody's identifier. Configure it under `elster.klassifizierung`.
         */
        await it('the rule chain source carries no identifier-shaped literal', async () => {
            const source = readFileSync(join(process.cwd(), 'src/core/elster/euer-classify.ts'), 'utf-8');
            const offenders = [
                ...new Set(
                    source
                        .split('\n')
                        // Quantifiers like `\d{4,}` are a PATTERN, not an identifier.
                        .map((l) => l.replace(/\\d\{[\d,]*\}/g, ''))
                        .flatMap((l) => l.match(/\d{5,}/g) ?? []),
                ),
            ];
            expect(offenders.join(',')).toBe('');
        });

        await it('ignores blank needles instead of matching everything', async () => {
            const blank: TxClassifyRules = {
                eigeneKonten: ['', '   '],
                privatGegenseiten: [''],
                aufwandRegeln: [{ muster: '  ', kategorie: '4930 Bürobedarf' }],
            };
            expect(classifyNoDocTransaction(tx({ counterparty: 'Some Shop', amount: -42 }), blank).source).toBe('unclassified');
        });
    });

    await describe('aggregateEuerByTransactions', async () => {
        const docs = new Map<string, TxDocInfo>([
            ['inc1', { category: '8400 Erlöse 19% USt', netEur: 1000, vatEur: 190, currency: 'EUR' }],
            ['exp1', { category: '4806 Hosting/Cloud', netEur: 100, vatEur: 19, currency: 'EUR' }],
            ['usd1', { category: '4806 Hosting/Cloud', taxRate: 0.19, currency: 'USD' }], // foreign → derive from EUR gross
        ]);
        const txs: UnifiedTransaction[] = [
            tx({ id: 'inc1', amount: 1190 }),                                   // linked income
            tx({ id: 'exp1', amount: -119 }),                                  // linked expense (EUR)
            tx({ id: 'usd1', amount: -119 }),                                  // linked expense, USD doc → EUR 119 gross
            tx({ id: 'fee', counterparty: 'Qonto', purpose: 'Gebühr', amount: -11.90 }), // rule: fee
            tx({ id: 'intern', purpose: 'Interne Ueberweisung', amount: -500 }),         // rule: neutral
            tx({ id: 'mystery', counterparty: 'Edeka', purpose: 'Einkauf', amount: -42 }), // unclassified
        ];

        await it('sums income/expenses on a cash basis, deriving net/VAT for foreign-currency docs', async () => {
            const a = aggregateEuerByTransactions(txs, docs, 2025);
            expect(a.totals.incomeNet).toBe(1000);
            expect(a.totals.outputVat).toBe(190);
            // expenses: 100 (exp1) + 100 (usd1: 119/1.19) + 11.90 (fee, VAT-exempt) + 35.29 (mystery: 42/1.19) = 247.19
            expect(a.totals.expenseNet).toBe(247.19);
            // input VAT: 19 (exp1) + 19 (usd1) + 0 (fee) + 6.71 (mystery, implied 19%) = 44.71
            expect(a.totals.inputVat).toBe(44.71);
        });

        await it('reports coverage: by-document, by-rule, and unclassified gaps', async () => {
            const a = aggregateEuerByTransactions(txs, docs, 2025);
            expect(a.coverage.transactions).toBe(6);
            expect(a.coverage.classifiedByDocument).toBe(3);
            expect(a.coverage.classifiedByRule).toBe(2); // fee + intern
            expect(a.coverage.unclassified.map((u) => u.id)).toStrictEqual(['mystery']);
        });

        await it('keeps neutral transactions out of the profit', async () => {
            const a = aggregateEuerByTransactions(txs, docs, 2025);
            expect(a.neutral.map((c) => c.category)).toContain('1360 Interne Überweisung');
            // profit = income 1000 − expenses 247.19
            expect(a.totals.profit).toBe(752.81);
        });
    });

    await describe('purpose-keyword rules + implied VAT', async () => {
        await it('classifies a no-document customer payment as 19% revenue', async () => {
            const txs = [tx({ id: 'c', amount: 1190, purpose: 'RNr RE-00037 Verkaufserlöse' })];
            const a = aggregateEuerByTransactions(txs, new Map(), 2025);
            expect(a.income[0].category).toBe('8400 Erlöse 19% USt');
            expect(a.totals.incomeNet).toBe(1000); // 1190 / 1.19
            expect(a.totals.outputVat).toBe(190);
        });

        await it('nets a refund against the purchase in the same expense category', async () => {
            const txs = [
                tx({ id: 'buy', amount: -316.99, counterparty: 'Notebook-Pro NPH GmbH', purpose: 'REF0414' }),
                tx({ id: 'refund', amount: 316.99, counterparty: 'Notebook-Pro NPH GmbH', purpose: 'Gutschrift Verkaufserlöse' }),
            ];
            const a = aggregateEuerByTransactions(txs, new Map(), 2025);
            const gwg = a.expenses.find((c) => c.category.startsWith('0420'));
            expect(gwg?.net).toBe(0); // purchase + full refund cancel
            expect(a.totals.expenseNet).toBe(0);
        });

        await it('classifies expenses by Qonto category keywords in the purpose', async () => {
            expect(classifyNoDocTransaction(tx({ amount: -50, purpose: 'NONREF Technologiekosten Hosting-Dienstleistungen 9999' })).category).toBe('4806 Hosting/Cloud');
            expect(classifyNoDocTransaction(tx({ amount: -50, purpose: 'NONREF Betriebskosten Bürobedarf 9999' })).category).toBe('4930 Bürobedarf');
            // A bare "NONREF 9999" (7128 = the Qonto card id, no category word) is an
            // unknown card charge — must NOT be guessed as hosting.
            expect(classifyNoDocTransaction(tx({ amount: -50, purpose: 'NONREF 9999' })).source).toBe('unclassified');
            // PayPal-resolved merchants (folded into the purpose by enrichWithPaypal):
            // DigitalOcean wins over the broad /lizenz/ tag; Kugellager is business; the
            // municipal Gewerbe fee and the music streaming come from the configured needles.
            expect(
                classifyNoDocTransaction(tx({ amount: -180, purpose: 'NONREF Software-Lizenzen 7128 ‹PayPal: DigitalOcean ›' }))
                    .category,
            ).toBe('4806 Hosting/Cloud');
            expect(
                classifyNoDocTransaction(tx({ amount: -52, purpose: 'NONREF 9999 ‹CURSOR, AI POWERED IDE (Karte)›' }))
                    .category,
            ).toBe('4964 Software/Lizenzen');
            expect(
                classifyNoDocTransaction(tx({ amount: -11, purpose: 'NONREF 9999 ‹SERVERPILOT.IO (Karte)›' })).category,
            ).toBe('4806 Hosting/Cloud');
            expect(
                classifyNoDocTransaction(tx({ amount: -14, purpose: 'PP.1555.PP ‹PayPal: Kugellager-Express GmbH ›' }))
                    .category,
            ).toBe('4650 Sonstige Betriebsausgaben');
            expect(
                classifyNoDocTransaction(
                    tx({ amount: -40, purpose: 'PP.1555.PP ‹PayPal: Stadt Musterstadt GEW-000000 ›' }),
                    RULES,
                ).category,
            ).toBe('4650 Sonstige Betriebsausgaben');
            expect(
                classifyNoDocTransaction(
                    tx({ amount: -17, purpose: 'PP.1555.PP ‹PayPal: Muster Musikdienst Premium ›' }),
                    RULES,
                ).kind,
            ).toBe('neutral');
            // KSK = a partner's personal Vorsorge (private), NOT a firm expense → Privatentnahme,
            // not 4380. Matched on the word in either spelling, wherever it appears.
            expect(classifyNoDocTransaction(tx({ counterparty: 'Künstlersozialkasse', amount: -418 })).category).toBe('1800 Privatentnahme');
            expect(classifyNoDocTransaction(tx({ amount: -418, purpose: 'Beitrag Kuenstlersozialkasse' })).kind).toBe('neutral');
            // Genuine firm dues (IHK/Handelskammer) DO stay a 4380 expense.
            expect(classifyNoDocTransaction(tx({ counterparty: 'IHK Musterstadt', amount: -82 })).category).toBe('4380 Beiträge/Künstlersozialkasse');
            expect(classifyNoDocTransaction(tx({ amount: -321, purpose: 'Betriebskosten Miete' })).category).toBe('4210 Miete/Raumkosten');
        });
    });

    await describe('year-end adjustments (AfA + Privatanteil)', async () => {
        await it('injects AfA as an expense and a Privatanteil as deemed income + output VAT', async () => {
            const txs = [tx({ amount: 1190, purpose: 'Verkaufserlöse RE-2025-1', counterparty: 'Kunde' })];
            const agg = aggregateEuerByTransactions(txs, new Map<string, TxDocInfo>(), 2025, {
                adjustments: { afa: 695.16, privatanteile: [{ bezeichnung: 'Telefon', net: 200, vat: 38 }] },
            });
            const afaCat = agg.expenses.find((c) => c.category === '4830 Abschreibungen (AfA)');
            expect(afaCat?.net).toBe(695.16);
            expect(afaCat?.vat).toBe(0);
            const priv = agg.income.find((c) => c.category === '8924 Unentgeltliche Wertabgaben (Privatanteil)');
            expect(priv?.net).toBe(200);
            expect(priv?.vat).toBe(38);
            // 1190 revenue = 1000 net + 190 VAT; + 200 Privatanteil net, + 38 output VAT.
            expect(agg.totals.incomeNet).toBe(1200);
            expect(agg.totals.outputVat).toBe(228);
            // expenses = AfA 695.16 (no input VAT); profit = 1200 − 695.16.
            expect(agg.totals.expenseNet).toBe(695.16);
            expect(agg.totals.profit).toBe(504.84);
            // AfA is non-cash → it must NOT count as a bank booking in the coverage.
            expect(agg.coverage.transactions).toBe(1);
            // Adjustments were supplied → the aggregate is the final (not a raw) view.
            expect(agg.adjustmentsApplied).toBe(true);
        });

        await it('is a no-op without adjustments', async () => {
            const txs = [tx({ amount: -50, purpose: 'Betriebskosten Miete' })];
            const agg = aggregateEuerByTransactions(txs, new Map<string, TxDocInfo>(), 2025);
            expect(agg.expenses.some((c) => c.category === '4830 Abschreibungen (AfA)')).toBe(false);
            expect(agg.income.some((c) => c.category.startsWith('8924'))).toBe(false);
            // No adjustments → raw cash view; surfaces must flag it as vorläufig.
            expect(agg.adjustmentsApplied).toBe(false);
        });

        await it('folds nachträgliche §24 income + expense into the EÜR', async () => {
            const agg = aggregateEuerByTransactions([], new Map<string, TxDocInfo>(), 2025, {
                adjustments: {
                    nachtraeglich: [
                        { bezeichnung: 'späte Kundenzahlung', net: 1000, vat: 190, art: 'einnahme' },
                        { bezeichnung: 'doppelte Zahlung erstattet', net: 0, vat: 0, art: 'einnahme' },
                        { bezeichnung: 'späte Lieferantenrechnung', net: 100, vat: 19, art: 'ausgabe' },
                    ],
                },
            });
            const inc = agg.income.find((c) => c.category === '8410 Nachträgliche Betriebseinnahme (§24)');
            const exp = agg.expenses.find((c) => c.category === '4655 Nachträgliche Betriebsausgabe (§24)');
            expect(inc?.net).toBe(1000);
            expect(inc?.vat).toBe(190);
            expect(exp?.net).toBe(100);
            expect(agg.totals.profit).toBe(900); // 1000 income − 100 expense
            expect(agg.totals.vatPayable).toBe(171); // 190 output − 19 input
            // not bank bookings → coverage untouched
            expect(agg.coverage.transactions).toBe(0);
        });
    });

    await describe('active-period scoping (Betriebsaufgabe)', async () => {
        await it('keeps post-Aufgabe INCOME as GbR §24 but excludes post-Aufgabe expenses (successor) by default', async () => {
            const txs = [
                tx({ amount: 1190, bookingDate: '2025-06-01', purpose: 'Verkaufserlöse RE-1', counterparty: 'Kunde' }),
                tx({ amount: 595, bookingDate: '2025-11-30', purpose: 'Verkaufserlöse RE-2', counterparty: 'Kunde' }),
                tx({ amount: -50, bookingDate: '2025-12-02', purpose: 'SaaS Hosting', counterparty: 'Hetzner' }),
            ];
            const agg = aggregateEuerByTransactions(txs, new Map<string, TxDocInfo>(), 2025, { activeTo: '2025-10-31', detail: true });
            // June 1000 laufend + Nov 500 as §24 income = 1500; the Dec expense is the successor's → excluded.
            expect(agg.totals.incomeNet).toBe(1500);
            expect(agg.totals.nachtraeglichNet).toBe(500); // only the §24 income; Dec expense dropped
            expect(agg.income.some((c) => c.category === '8410 Nachträgliche Betriebseinnahme (§24)' && c.net === 500)).toBe(true);
            expect(agg.expenses.some((c) => c.category === '4655 Nachträgliche Betriebsausgabe (§24)')).toBe(false);
            // only the June booking is in the active-period count + the laufende list (detail)
            expect(agg.coverage.transactions).toBe(1);
            expect(agg.detail?.length).toBe(1);
            // Nov income kept (§24, included), Dec expense excluded (successor)
            const nov = agg.coverage.outsidePeriod.find((o) => o.bookingDate === '2025-11-30');
            const dec = agg.coverage.outsidePeriod.find((o) => o.bookingDate === '2025-12-02');
            expect(nov?.included).toBe(true);
            expect(dec?.included).toBe(false);
        });

        await it('keeps a post-Aufgabe expense as GbR §24 when its counterparty is whitelisted', async () => {
            const txs = [tx({ amount: -119, bookingDate: '2025-12-03', purpose: 'Steuerberatung', counterparty: 'Kanzlei Nordwind Steuerberatung' })];
            const agg = aggregateEuerByTransactions(txs, new Map<string, TxDocInfo>(), 2025, {
                activeTo: '2025-10-31',
                nachtraeglichGbrAusgaben: ['Nordwind'],
            });
            expect(agg.expenses.some((c) => c.category === '4655 Nachträgliche Betriebsausgabe (§24)')).toBe(true);
            expect(agg.totals.nachtraeglichNet).toBe(-100); // §24 expense (100 net)
            expect(agg.coverage.outsidePeriod[0]?.included).toBe(true);
        });

        await it('defaults to the whole year when no active window is given', async () => {
            const txs = [tx({ amount: 595, bookingDate: '2025-11-30', purpose: 'Verkaufserlöse RE', counterparty: 'Kunde' })];
            const agg = aggregateEuerByTransactions(txs, new Map<string, TxDocInfo>(), 2025);
            expect(agg.totals.incomeNet).toBe(500);
            expect(agg.coverage.outsidePeriod.length).toBe(0);
        });

        await it('neutralises a confirmed double payment (out of income + USt)', async () => {
            const txs = [
                tx({ amount: 1190, bookingDate: '2025-06-01', purpose: 'Verkaufserlöse RE-1', counterparty: 'Kunde' }),
                tx({ id: 'dup', amount: 595, bookingDate: '2025-09-11', purpose: 'Verkaufserlöse RE-2 (doppelt)', counterparty: 'Kunde' }),
            ];
            const agg = aggregateEuerByTransactions(txs, new Map<string, TxDocInfo>(), 2025, {
                doppelzahlungIds: new Set(['dup']),
            });
            expect(agg.totals.incomeNet).toBe(1000); // only the real receipt; the duplicate is neutral
            expect(agg.totals.outputVat).toBe(190);
            expect(agg.neutral.some((c) => c.category === '1590 Doppelzahlung (durchlaufend)')).toBe(true);
        });
    });

    await describe('Doppelzahlung — refund neutralisation', async () => {
        await it('neutralises the duplicate credit AND the linked refund debit (no expense, no Vorsteuer)', async () => {
            const txs = [
                tx({ amount: 1190, bookingDate: '2025-06-01', purpose: 'Verkaufserlöse RE-1', counterparty: 'Kunde' }),
                tx({ id: 'dup', amount: 1190, bookingDate: '2025-06-20', purpose: 'Verkaufserlöse RE-1', counterparty: 'Kunde' }),
                tx({ id: 'refund', amount: -1190, bookingDate: '2025-07-05', purpose: 'Rückzahlung RE-1', counterparty: 'Kunde' }),
            ];
            const agg = aggregateEuerByTransactions(txs, new Map<string, TxDocInfo>(), 2025, {
                detail: true,
                doppelzahlungIds: doppelzahlungIds({
                    adjustments: { doppelzahlungen: [{ transaktion_id: 'dup', bezeichnung: '', rueckzahlung_transaktion_id: 'refund' }] },
                } as ElsterConfig),
            });
            expect(agg.totals.incomeNet).toBe(1000);
            expect(agg.totals.outputVat).toBe(190);
            expect(agg.totals.expenseNet).toBe(0);
            expect(agg.totals.inputVat).toBe(0);
            const rows = (agg.detail ?? []).filter((r) => r.id === 'dup' || r.id === 'refund');
            expect(rows.length).toBe(2);
            expect(rows.every((r) => r.kind === 'neutral' && r.rule === 'Doppelzahlung')).toBe(true);
        });

        await it('without the link the refund debit stays an expense-side booking', async () => {
            const ids = doppelzahlungIds({
                adjustments: { doppelzahlungen: [{ transaktion_id: 'dup', bezeichnung: '' }] },
            } as ElsterConfig);
            expect([...ids]).toStrictEqual(['dup']);
        });
    });

    await describe('per-transaction detail (review view)', async () => {
        await it('classifyNoDocTransaction carries a rule label (undefined when unclassified)', async () => {
            expect(classifyNoDocTransaction(tx({ counterparty: 'Qonto', purpose: 'Gebühr' })).rule).toContain('Bankgebühr');
            expect(
                classifyNoDocTransaction(tx({ purpose: 'Interne Ueberweisung', counterparty: 'Hauptkonto' })).rule,
            ).toContain('interne');
            expect(classifyNoDocTransaction(tx({ amount: -50, purpose: 'Hosting-Dienstleistungen' })).rule).toContain(
                'Keyword',
            );
            expect(classifyNoDocTransaction(tx({ counterparty: 'Edeka', purpose: 'Einkauf', amount: -42 })).rule).toBeUndefined();
        });

        await it('emits a detail row per transaction only when requested', async () => {
            const txs = [
                tx({ id: 'inc', amount: 1190, purpose: 'RE-00037 Verkaufserlöse' }),
                tx({ id: 'fee', counterparty: 'Qonto', purpose: 'Gebühr', amount: -11.9 }),
            ];
            expect(aggregateEuerByTransactions(txs, new Map(), 2025).detail).toBeUndefined();
            const d = aggregateEuerByTransactions(txs, new Map(), 2025, { detail: true }).detail ?? [];
            expect(d).toHaveLength(2);
            const inc = d.find((r) => r.id === 'inc');
            expect(inc?.category).toBe('8400 Erlöse 19% USt');
            expect(inc?.source).toBe('rule');
            expect(inc?.net).toBe(1000);
            expect(d.find((r) => r.id === 'fee')?.rule).toContain('Bankgebühr');
        });

        await it('detail net is signed: a refund nets negative against the purchase', async () => {
            const txs = [
                tx({ id: 'buy', amount: -316.99, counterparty: 'Notebook-Pro NPH GmbH', purpose: 'REF0414' }),
                tx({ id: 'ref', amount: 316.99, counterparty: 'Notebook-Pro NPH GmbH', purpose: 'Gutschrift Verkaufserlöse' }),
            ];
            const d = aggregateEuerByTransactions(txs, new Map(), 2025, { detail: true }).detail ?? [];
            const buy = d.find((r) => r.id === 'buy');
            const ref = d.find((r) => r.id === 'ref');
            expect(buy?.net).toBeGreaterThan(0);
            expect(ref?.net).toBeLessThan(0);
            expect((buy?.net ?? 0) + (ref?.net ?? 0)).toBeCloseTo(0, 2);
        });
    });

    await describe('foreign-currency net/VAT derivation at 7% and 0%', async () => {
        await it('derives net/VAT from the EUR booking gross via the document tax rate', async () => {
            const docs = new Map<string, TxDocInfo>([
                ['inc7', { category: '8300 Erlöse 7% USt', taxRate: 0.07, currency: 'USD' }],
                ['exp0', { category: '4946 Fremdleistungen', taxRate: 0, currency: 'USD' }],
            ]);
            const txs = [tx({ id: 'inc7', amount: 107 }), tx({ id: 'exp0', amount: -50 })];
            const a = aggregateEuerByTransactions(txs, docs, 2025);
            expect(a.totals.incomeNet).toBe(100); // 107 / 1.07
            expect(a.totals.outputVat).toBe(7);
            expect(a.totals.expenseNet).toBe(50); // 0% → net == gross
            expect(a.totals.inputVat).toBe(0);
        });
    });
};
