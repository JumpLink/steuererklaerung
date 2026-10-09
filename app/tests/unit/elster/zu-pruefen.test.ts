import { describe, it, expect, beforeEach, afterEach } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import {
    aggregateEuerByTransactions,
    classifyNoDocTransaction,
    type EuerManualOverride,
    type TxDocInfo,
} from '../../../src/core/elster/euer-transactions.ts';
import { eigeneRegelId } from '../../../src/core/elster/euer-classify.ts';
import { herkunftText, wasGiltDanach, zuPruefenGrund, zuPruefenQueue } from '../../../src/core/elster/zu-pruefen.ts';
import {
    musterAusBeispielen,
    regelAusBeispielen,
    regelTreffer,
    type RegelBuchung,
} from '../../../src/core/elster/regel-aus-beispielen.ts';
import { buildHomeModel } from '../../../src/core/elster/home.ts';
import { computeHinweise } from '../../../src/core/elster/hinweise.ts';
import {
    confirmClassification,
    getClassificationDecision,
    loadConfirmedClassifications,
    loadManualOverrides,
    recordClassificationDecision,
} from '../../../src/core/actions/classifications.ts';
import {
    loadClassificationRules,
    rememberRule,
    saveAufwandRegeln,
} from '../../../src/core/actions/classification-rules.ts';

// All bookings, names and amounts below are invented.
let n = 0;
function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: `zp${n++}`,
        source: 'camt',
        accountKey: 'camt:test',
        bookingDate: '2025-05-10',
        amount: -10,
        currency: 'EUR',
        ...over,
    };
}

function buchung(over: Partial<RegelBuchung>): RegelBuchung {
    return {
        id: `rb${n++}`,
        bookingDate: '2025-03-01',
        amount: -20,
        source: 'unclassified',
        category: '(unklassifiziert)',
        ...over,
    };
}

export default async () => {
    await describe('classifier exposes the matched rule', async () => {
        await it('names a built-in rule with a stable id and keeps the old label', async () => {
            const c = classifyNoDocTransaction(tx({ purpose: 'Interne Überweisung an Rücklage' }));
            expect(c.rule).toBe('interne Überweisung / Umbuchung');
            expect(c.matchedRule).toStrictEqual({
                id: 'eingebaut:interne-ueberweisung',
                label: 'interne Überweisung / Umbuchung',
                art: 'eingebaut',
            });
        });

        await it('names the needle of a user list and the pattern of a user rule', async () => {
            const own = classifyNoDocTransaction(tx({ counterparty: 'Altfirma Muster KG' }), {
                eigeneKonten: ['Altfirma Muster'],
            });
            expect(own.matchedRule?.id).toBe('eigene:eigene_konten:altfirma muster');
            expect(own.matchedRule?.art).toBe('eigene');
            const supplier = classifyNoDocTransaction(tx({ counterparty: 'Erika Beispiel' }), {
                aufwandRegeln: [{ muster: 'Erika Beispiel', kategorie: '4946 Fremdleistungen' }],
            });
            expect(supplier.matchedRule?.id).toBe(eigeneRegelId('Erika Beispiel'));
            expect(supplier.rule).toBe('Regel „Erika Beispiel“');
        });

        await it('flags the bank-tag keywords as Auffangregel, a merchant name not', async () => {
            const reise = classifyNoDocTransaction(tx({ purpose: 'Reisekosten Bahnticket' }));
            expect(reise.category).toBe('4670 Reisekosten');
            expect(reise.matchedRule?.auffang).toBe(true);
            const telekom = classifyNoDocTransaction(tx({ counterparty: 'Telekom Deutschland' }));
            expect(telekom.category).toBe('4921 Telefon/Internet');
            expect(telekom.matchedRule?.auffang).toBeUndefined();
        });

        await it('an income with only the „Verkaufserlöse" tag is a catch-all; one with an invoice number is not', async () => {
            const tag = classifyNoDocTransaction(tx({ amount: 100, purpose: 'Verkaufserlöse' }));
            expect(tag.category).toBe('8400 Erlöse 19% USt');
            expect(tag.matchedRule?.auffang).toBe(true);
            const reNr = classifyNoDocTransaction(tx({ amount: 100, purpose: 'Verkaufserlöse RE-20250042' }));
            expect(reNr.category).toBe('8400 Erlöse 19% USt');
            expect(reNr.matchedRule?.auffang).toBeUndefined();
        });

        await it('a user rule skips its exceptions', async () => {
            const t = tx({ counterparty: 'Muster Hosting AG' });
            const rules = {
                aufwandRegeln: [{ muster: 'Muster Hosting', kategorie: '4806 Hosting/Cloud', ausnahmen: [t.id] }],
            };
            const c = classifyNoDocTransaction(t, rules);
            // Falls through to the generic /hosting/ keyword — the exception only removes THIS rule.
            expect(c.matchedRule?.id).toBe('eingebaut:stichwort:hosting');
        });
    });

    await describe('aggregate totals are unchanged by the matched-rule exposure', async () => {
        await it('books the same amounts per category as before', async () => {
            const reise = tx({ id: 'a1', amount: -119, purpose: 'Reisekosten Hotel' });
            const erloes = tx({ id: 'a2', amount: 238, purpose: 'Verkaufserlöse' });
            const gebuehr = tx({ id: 'a3', amount: -50, purpose: 'Kontoführung Entgelt' });
            const beleg = tx({ id: 'a4', amount: -11.9, counterparty: 'Papierladen' });
            const doppelt = tx({ id: 'a5', amount: 119, purpose: 'Verkaufserlöse' });
            const unklar = tx({ id: 'a6', amount: -238, counterparty: 'Unbekannt XYZ' });
            const manuell = tx({ id: 'a7', amount: -59.5, purpose: 'Reisekosten' });
            const docs = new Map<string, TxDocInfo>([
                ['a4', { documentId: 7, category: '4930 Bürobedarf', netEur: 10, vatEur: 1.9, currency: 'EUR' }],
            ]);
            const overrides = new Map<string, EuerManualOverride>([['a7', { category: '4964 Software/Lizenzen' }]]);
            const agg = aggregateEuerByTransactions(
                [reise, erloes, gebuehr, beleg, doppelt, unklar, manuell],
                docs,
                2025,
                { detail: true, doppelzahlungIds: new Set(['a5']), overrides },
            );
            expect(agg.totals).toStrictEqual({
                incomeNet: 200,
                outputVat: 38,
                expenseNet: 410,
                inputVat: 68.4,
                profit: -210,
                vatPayable: -30.4,
                nachtraeglichNet: 0,
            });
            expect(agg.coverage.classifiedByDocument).toBe(1);
            expect(agg.coverage.classifiedByManual).toBe(1);
            expect(agg.coverage.classifiedByRule).toBe(4);
            expect(agg.coverage.unclassified.map((u) => u.id)).toStrictEqual(['a6']);
            const byId = new Map((agg.detail ?? []).map((r) => [r.id, r]));
            expect(byId.get('a4')?.matchedRule).toStrictEqual({ id: 'beleg:7', label: 'Beleg #7', art: 'beleg' });
            expect(byId.get('a5')?.matchedRule?.art).toBe('doppelzahlung');
            expect(byId.get('a6')?.matchedRule).toBeUndefined();
        });
    });

    await describe('Zu prüfen queue', async () => {
        const rows = [
            { id: 'q1', source: 'unclassified' as const, category: '(unklassifiziert)' },
            {
                id: 'q2',
                source: 'rule' as const,
                category: '4670 Reisekosten',
                matchedRule: { id: 'eingebaut:stichwort:reise', label: 'x', art: 'eingebaut' as const, auffang: true },
            },
            {
                id: 'q3',
                source: 'rule' as const,
                category: '4921 Telefon/Internet',
                matchedRule: { id: 'eingebaut:stichwort:telefonanbieter', label: 'x', art: 'eingebaut' as const },
            },
            { id: 'q4', source: 'document' as const, category: '4930 Bürobedarf' },
            { id: 'q5', source: 'manual' as const, category: '4930 Bürobedarf' },
        ];

        await it('holds the unclassified and the catch-all bookings only', async () => {
            expect(rows.map((r) => zuPruefenGrund(r))).toStrictEqual([
                'unklassifiziert',
                'auffangregel',
                null,
                null,
                null,
            ]);
            expect(zuPruefenQueue(rows, new Map()).map((r) => r.id)).toStrictEqual(['q1', 'q2']);
        });

        await it('a confirmation holds only while the category is the confirmed one', async () => {
            expect(zuPruefenQueue(rows, new Map([['q2', '4670 Reisekosten']])).map((r) => r.id)).toStrictEqual(['q1']);
            expect(
                zuPruefenQueue(rows, new Map([['q2', '4600 Werbe-/Marketingkosten']])).map((r) => r.id),
            ).toStrictEqual(['q1', 'q2']);
        });
    });

    await describe('was gilt nach „Umbuchung zurücknehmen"', async () => {
        await it('re-runs the classification without the override', async () => {
            const viaRegel = tx({ id: 'w1', purpose: 'Reisekosten Bahn' });
            const unklar = tx({ id: 'w2', counterparty: 'Niemand bekannt' });
            const viaBeleg = tx({ id: 'w3', counterparty: 'Papierladen' });
            const agg = aggregateEuerByTransactions(
                [viaRegel, unklar, viaBeleg],
                new Map([
                    ['w3', { documentId: 9, category: '4930 Bürobedarf', netEur: 8.4, vatEur: 1.6, currency: 'EUR' }],
                ]),
                2025,
                {
                    detail: true,
                    overrides: new Map([
                        ['w1', { category: '4964 Software/Lizenzen' }],
                        ['w2', { category: '4964 Software/Lizenzen' }],
                        ['w3', { category: '4964 Software/Lizenzen' }],
                    ]),
                },
            );
            const byId = new Map((agg.detail ?? []).map((r) => [r.id, r]));
            expect(wasGiltDanach(byId.get('w1')!)).toBe(
                'Danach gilt wieder: via Regel „Stichwort reise“ (Auffangregel) → 4670 Reisekosten.',
            );
            expect(wasGiltDanach(byId.get('w2')!)).toBe('Danach ist die Buchung unklassifiziert.');
            expect(wasGiltDanach(byId.get('w3')!)).toBe('Danach gilt wieder: via Beleg #9 → 4930 Bürobedarf.');
            expect(herkunftText(byId.get('w1')!)).toBe('manuell');
        });

        await it('says nothing for a booking without an Umbuchung', async () => {
            expect(wasGiltDanach({ source: 'rule' })).toBe(null);
        });
    });

    await describe('Regel aus Beispielen', async () => {
        await it('proposes the shared counterparty text', async () => {
            expect(
                musterAusBeispielen([
                    buchung({ counterparty: 'Muster Hosting AG' }),
                    buchung({ counterparty: 'MUSTER HOSTING AG' }),
                ]),
            ).toBe('Muster Hosting AG');
            expect(
                musterAusBeispielen([
                    buchung({ counterparty: 'Beispiel Druck GmbH Filiale Nord' }),
                    buchung({ counterparty: 'Beispiel Druck GmbH' }),
                ]),
            ).toBe('Beispiel Druck GmbH');
            expect(
                musterAusBeispielen([
                    buchung({ purpose: 'Abo Buchhaltungssoftware Januar' }),
                    buchung({ purpose: 'Abo Buchhaltungssoftware Februar' }),
                ]),
            ).toBe('Buchhaltungssoftware');
        });

        await it('lists every booking it would hit — not receipts, manual ones or exceptions', async () => {
            const a = buchung({ counterparty: 'Beispiel Druck GmbH' });
            const b = buchung({ counterparty: 'Beispiel Druck GmbH', purpose: 'Flyer' });
            const c = buchung({
                counterparty: 'Beispiel Druck GmbH',
                source: 'document',
                category: '4600 Werbe-/Marketingkosten',
            });
            const d = buchung({ counterparty: 'Beispiel Druck GmbH', source: 'manual', category: '4930 Bürobedarf' });
            const e = buchung({ counterparty: 'Anderer Laden' });
            const f = buchung({ counterparty: 'Beispiel Druck GmbH' });
            const alle = [a, b, c, d, e, f];
            const hits = regelTreffer('Beispiel Druck', '4600 Werbe-/Marketingkosten', alle);
            expect(hits.map((h) => h.id)).toStrictEqual([a.id, b.id, f.id]);
            const ohneF = regelTreffer('Beispiel Druck', '4600 Werbe-/Marketingkosten', alle, {}, [f.id]);
            expect(ohneF.map((h) => h.id)).toStrictEqual([a.id, b.id]);

            const v = regelAusBeispielen([a, b], alle, {}, { kategorie: '4600 Werbe-/Marketingkosten' });
            expect(v.muster).toBe('Beispiel Druck GmbH');
            expect(v.treffer.length).toBe(3);
            expect(v.nichtErfasst.length).toBe(0);
        });

        await it('reports an example an earlier rule of the chain catches first', async () => {
            const steuer = buchung({ counterparty: 'Finanzamt Musterstadt', purpose: 'Umsatzsteuer' });
            const v = regelAusBeispielen(
                [steuer],
                [steuer],
                {},
                { muster: 'Musterstadt', kategorie: '4950 Rechts-/Beratungskosten' },
            );
            expect(v.treffer.length).toBe(0);
            expect(v.nichtErfasst[0].warum).toContain('frühere Regel');
        });
    });

    await describe('Als Nächstes: one task for Zu prüfen, no duplicate', async () => {
        const hinweise = computeHinweise({
            year: 2025,
            umsatz: 0,
            outputVat: 0,
            unclassified: 2,
            unclassifiedRows: [
                { id: 'h1', bookingDate: '2025-01-02', amount: -5 },
                { id: 'h2', bookingDate: '2025-01-03', amount: -6 },
            ],
        });

        await it('replaces the unclassified hint task while the queue is not empty', async () => {
            const m = buildHomeModel({ year: 2025, txs: [], dashboard: null, hinweise, zuPruefen: 5 });
            expect(m.tasks.map((t) => t.kind)).toStrictEqual(['zu-pruefen']);
            expect(m.tasks[0].title).toBe('5 Buchungen zu prüfen');
        });

        await it('keeps the hint task when there is no queue count', async () => {
            const m = buildHomeModel({ year: 2025, txs: [], dashboard: null, hinweise });
            expect(m.tasks.map((t) => t.ref)).toStrictEqual(['unklassifiziert']);
        });
    });

    await describe('confirm and rule persistence', async () => {
        let dir = '';
        let prev: Record<string, string | undefined> = {};
        beforeEach(async () => {
            prev = { STEUER_WORKSPACE: process.env.STEUER_WORKSPACE, LEDGER_DB_PATH: process.env.LEDGER_DB_PATH };
            dir = mkdtempSync(join(tmpdir(), 'bh-zu-pruefen-'));
            const manifest = join(dir, 'steuererklaerung.json');
            writeFileSync(
                manifest,
                JSON.stringify({
                    version: 1,
                    entities: [
                        {
                            id: 'firma',
                            name: 'Beispiel GbR',
                            kind: 'gbr',
                            accounts: [],
                            elster: {
                                entity_id: 'firma',
                                tax_number: '9198081508152',
                                period: { year: 2025, quarter: 1 },
                                test_mode: true,
                                taxation_basis: 'ist',
                                betrieb: {
                                    name: 'Beispiel GbR',
                                    strasse: 'Musterweg 1',
                                    plz: '12345',
                                    ort: 'Musterstadt',
                                    art: 'Software',
                                },
                                gesellschafter: [
                                    { id: 'p1', name: 'A B', steuer_id: '11111111111', quote: 0.5 },
                                    { id: 'p2', name: 'C D', steuer_id: '22222222222', quote: 0.5 },
                                ],
                            },
                        },
                    ],
                }),
            );
            process.env.STEUER_WORKSPACE = manifest;
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
        });
        afterEach(async () => {
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            rmSync(dir, { recursive: true, force: true });
        });

        await it('a confirmation is remembered but never an override', async () => {
            confirmClassification({ transactionId: 'c1', category: '4670 Reisekosten', decidedBy: 'test' });
            expect(loadConfirmedClassifications(['c1'])).toStrictEqual(new Map([['c1', '4670 Reisekosten']]));
            expect(loadManualOverrides(['c1']).size).toBe(0);
            // A Begründung added later keeps it a confirmation.
            recordClassificationDecision({ transactionId: 'c1', note: 'Bahnfahrt zum Kunden' });
            expect(getClassificationDecision('c1')?.source).toBe('rule');
            expect(loadManualOverrides(['c1']).size).toBe(0);
            expect(loadConfirmedClassifications(['c1']).get('c1')).toBe('4670 Reisekosten');
        });

        await it('refuses to stamp over a manual Umbuchung', async () => {
            recordClassificationDecision({ transactionId: 'c2', category: '4930 Bürobedarf' });
            let msg = '';
            try {
                confirmClassification({ transactionId: 'c2', category: '4930 Bürobedarf' });
            } catch (err) {
                msg = err instanceof Error ? err.message : String(err);
            }
            expect(msg).toContain('manuell umgebucht');
            expect(loadManualOverrides(['c2']).get('c2')?.category).toBe('4930 Bürobedarf');
        });

        await it('stores the deselected hits as exceptions, and the editor keeps them', async () => {
            rememberRule('firma', 'Beispiel Druck', '4600 Werbe-/Marketingkosten', { ausnahmen: ['x9'] });
            expect(loadClassificationRules('firma').aufwandRegeln).toStrictEqual([
                { muster: 'Beispiel Druck', kategorie: '4600 Werbe-/Marketingkosten', ausnahmen: ['x9'] },
            ]);
            // Saving the same rule again with one more exception merges, no twin rule.
            const again = rememberRule('firma', 'Beispiel Druck', '4600 Werbe-/Marketingkosten', { ausnahmen: ['x8'] });
            expect(again.added).toBe(false);
            expect(loadClassificationRules('firma').aufwandRegeln[0].ausnahmen).toStrictEqual(['x9', 'x8']);
            saveAufwandRegeln('firma', loadClassificationRules('firma').aufwandRegeln);
            const raw = JSON.parse(readFileSync(process.env.STEUER_WORKSPACE!, 'utf8'));
            expect(raw.entities[0].elster.klassifizierung.aufwand_regeln[0].ausnahmen).toStrictEqual(['x9', 'x8']);
        });
    });
};
