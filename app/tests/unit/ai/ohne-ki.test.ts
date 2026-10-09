/**
 * The promise "every function works without AI", run rather than read: the main flows execute with
 * a provider installed that counts its calls, and none may make one. The AI-only sites are checked
 * for the other half of the promise — when AI is off they say so in one German sentence.
 *
 * `check:ai` (dev/check-ai-boundary.js) guards the list of AI sites; this guards the flows beside it.
 */
import { describe, it, expect, beforeEach, afterEach } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openLedger, upsertAccount, type UnifiedTransaction } from '@steuererklaerung/store';
import { BuiltinDmsProvider, type DmsProvider } from '@steuererklaerung/dms';
import {
    AI_NOT_CONFIGURED_MESSAGE,
    setLLMProviderOverride,
    type LLMProvider,
} from '../../../src/core/clients/llm/index.ts';
import { probeEngine } from '../../../src/core/actions/assistant/engine-status.ts';
import { extractInvoiceFieldsFromContent } from '../../../src/core/actions/paperless/extract-invoice.ts';
import { linkDocumentToTransaction } from '../../../src/core/actions/link-candidates.ts';
import {
    loadClassificationRules,
    rememberRule,
    toClassifyRules,
} from '../../../src/core/actions/classification-rules.ts';
import { classifyNoDocTransaction, aggregateEuerByTransactions } from '../../../src/core/elster/euer-transactions.ts';
import { buildEuerNutzdaten, euerLinesFromAggregate } from '../../../src/core/elster/euer-xml.ts';
import { SelfOutgoingInvoiceProvider } from '../../../src/core/invoices/self-provider.ts';

const tx = (id: string, over: Partial<UnifiedTransaction> = {}): UnifiedTransaction =>
    ({
        id,
        source: 'camt',
        accountKey: 'camt:DE00TESTKONTO',
        bookingDate: '2025-06-01',
        amount: -119,
        currency: 'EUR',
        ...over,
    }) as UnifiedTransaction;

export default async () => {
    await describe('ohne KI — Hauptabläufe', async () => {
        let dir = '';
        let calls = 0;
        const prev = new Map<string, string | undefined>();
        const setEnv = (k: string, v: string) => {
            if (!prev.has(k)) prev.set(k, process.env[k]);
            process.env[k] = v;
        };
        const counting: LLMProvider = {
            name: 'zaehler',
            model: 'keins',
            complete: async () => {
                calls++;
                throw new Error('Die KI wurde gerufen, obwohl der Ablauf ohne sie gehen muss.');
            },
        };

        beforeEach(() => {
            calls = 0;
            dir = mkdtempSync(join(tmpdir(), 'bh-ohne-ki-'));
            setEnv('TRANSACTIONS_DATA_DIR', dir);
            setEnv('LEDGER_DB_PATH', join(dir, 'ledger.db'));
            const manifest = join(dir, 'steuererklaerung.json');
            writeFileSync(
                manifest,
                JSON.stringify({
                    version: 1,
                    entities: [
                        {
                            id: 'gbr',
                            name: 'Test GbR',
                            kind: 'gbr',
                            accounts: ['camt:*'],
                            dms: { type: 'builtin' },
                            elster: {
                                tax_number: '12/345/67890',
                                period: { year: 2025, quarter: 1 },
                                entity_id: 'gbr',
                                test_mode: true,
                                taxation_basis: 'ist',
                                betrieb: {
                                    name: 'Test GbR',
                                    strasse: 'Musterweg 1',
                                    plz: '12345',
                                    ort: 'Musterstadt',
                                    art: 'Beratung',
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
            setEnv('STEUER_WORKSPACE', manifest);
            setLLMProviderOverride(counting);
        });
        afterEach(() => {
            setLLMProviderOverride(null);
            for (const [k, v] of prev) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            prev.clear();
            rmSync(dir, { recursive: true, force: true });
        });

        await it('the counting provider is really the one the app would get', async () => {
            let message = '';
            try {
                await extractInvoiceFieldsFromContent('Rechnung 1', 'incoming_invoice');
            } catch (e) {
                message = e instanceof Error ? e.message : String(e);
            }
            expect(calls).toBe(1);
            expect(message).toContain('gerufen');
        });

        await it('Beleg zuordnen: links a document to a transaction', async () => {
            upsertAccount('camt:DE00TESTKONTO', [tx('tx-1')]);
            const dms = new BuiltinDmsProvider('gbr');
            const doc = await dms.store({ bytes: Buffer.from('r1'), filename: 'r1.pdf', mimeType: 'application/pdf' });
            const res = await linkDocumentToTransaction('gbr', doc.id, 'tx-1');
            expect(res.linkedTxIds.join(',')).toBe('tx-1');
            expect(calls).toBe(0);
        });

        await it('Buchung einordnen: "Als Regel merken" then the rule chain books it', async () => {
            const kategorie = '4950 Rechts-/Beratungskosten';
            expect(rememberRule('gbr', 'Kanzlei Mustermann', kategorie).added).toBe(true);
            const rules = toClassifyRules(loadClassificationRules('gbr'));
            const booked = classifyNoDocTransaction(
                tx('t2', { counterparty: 'Kanzlei Mustermann', purpose: 'Beratung', amount: -300 }),
                rules,
            );
            expect(booked.category).toBe(kategorie);
            expect(calls).toBe(0);
        });

        await it('Rechnung schreiben: draft, number and XRechnung XML', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const fakeDms: DmsProvider = {
                kind: 'builtin',
                list: async () => [],
                get: async () => null,
                getFile: async () => null,
                store: async (i) => ({ id: 'doc-1', filename: i.filename }) as never,
                setMetadata: async () => {},
                link: async () => {},
            };
            const provider = new SelfOutgoingInvoiceProvider({
                entityId: 'gbr',
                numberPrefix: 'RE-',
                iban: 'DE02120300000000202051',
                logoPath: null,
                withDb: (fn) => fn(db),
                resolveIssuer: () => ({
                    name: 'Muster & Partner',
                    address: 'Musterweg 1',
                    zip: '12345',
                    city: 'Musterstadt',
                    taxNumber: '12/345/67890',
                    kleinunternehmer: false,
                    bank: { iban: 'DE02120300000000202051' },
                }),
                makeDms: () => fakeDms,
                resolveRecipient: () => ({
                    name: 'Beispiel GmbH',
                    address: 'Kundenstr. 2',
                    zip: '54321',
                    city: 'Kundenstadt',
                }),
                now: () => '2026-03-01T10:00:00Z',
            });
            const draft = await provider.createDraft({
                issueDate: '2026-03-01',
                dueDate: '2026-03-15',
                currency: 'EUR',
                iban: 'DE02120300000000202051',
                performanceStart: '2026-02-01',
                performanceEnd: '2026-02-28',
                items: [{ title: 'Beratung', quantity: 2, unit: 'Std', unit_price: 100, vat_rate: 19 }],
            });
            expect(draft.status).toBe('draft');
            try {
                const done = await provider.finalize(draft.id);
                expect(done.number).toBe('RE-2026-0001');
                const file = await provider.getXml(draft.id);
                const xml = file && file.kind === 'bytes' ? new TextDecoder().decode(file.bytes) : '';
                expect(xml).toContain('xrechnung_3.0');
                expect(xml).toContain('RE-2026-0001');
            } catch (e) {
                // Numbering renders the PDF, which needs cairo/Pango — GJS only (same as self-provider.test).
                expect(e instanceof Error ? e.message : String(e)).toContain('GJS');
            }
            expect(calls).toBe(0);
            db.close();
        });

        await it('EÜR erzeugen: aggregate and XML from bookings', async () => {
            const txs = [
                tx('e1', { amount: 1190, counterparty: 'Musterkunde AG', purpose: 'Rechnung' }),
                tx('e2', { amount: -50, counterparty: 'Kanzlei Mustermann', purpose: 'Beratung' }),
            ];
            const agg = aggregateEuerByTransactions(txs, new Map(), 2025, {
                klassifizierung: {
                    eigeneKonten: [],
                    privatGegenseiten: [],
                    gesellschafterGegenseiten: [],
                    kskKennungen: [],
                    erloesGegenseiten: ['musterkunde ag'],
                    aufwandRegeln: [{ muster: 'kanzlei mustermann', kategorie: '4950 Rechts-/Beratungskosten' }],
                },
            });
            expect(agg.coverage.transactions).toBe(2);
            const xml = buildEuerNutzdaten(
                euerLinesFromAggregate(agg),
                { name: 'Muster & Partner', strasse: 'Musterweg 1', plz: '12345', ort: 'Musterstadt', art: 'Beratung' },
                '2181012345678',
                2025,
            );
            expect(xml).toContain('E6001201');
            expect(calls).toBe(0);
        });
    });

    await describe('ohne KI — die KI-Stellen sagen es', async () => {
        let prev: string | undefined;
        beforeEach(() => {
            prev = process.env.LLM_PROVIDER;
            process.env.LLM_PROVIDER = 'off';
        });
        afterEach(() => {
            if (prev === undefined) delete process.env.LLM_PROVIDER;
            else process.env.LLM_PROVIDER = prev;
        });

        await it('extract-invoice fails with the German "keine KI eingerichtet" message', async () => {
            let message = '';
            try {
                await extractInvoiceFieldsFromContent('Rechnung 1', 'incoming_invoice');
            } catch (e) {
                message = e instanceof Error ? e.message : String(e);
            }
            expect(message).toBe(AI_NOT_CONFIGURED_MESSAGE);
            expect(message).toContain('keine eingerichtet');
        });

        await it('the engine probe reports it instead of crashing', async () => {
            const res = await probeEngine();
            expect(res.ok).toBe(false);
            expect(res.message).toBe(AI_NOT_CONFIGURED_MESSAGE);
        });
    });
};
