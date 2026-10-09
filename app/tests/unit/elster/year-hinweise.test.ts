import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertAccount, type UnifiedTransaction } from '@steuererklaerung/store';
import { BuiltinDmsProvider } from '@steuererklaerung/dms';
import { DEFAULT_SYNC_CONFIG, ElsterConfigRawSchema, normalizeElsterConfig } from '../../../src/core/config/index.ts';
import { euerReportByTransactions } from '../../../src/core/actions/elster/euer.ts';
import { buildYearCache, type YearCache } from '../../../src/core/presenters/year-snapshot.ts';
import { computeYearHinweise } from '../../../src/core/actions/elster/hinweise.ts';
import { doppelzahlungHinweisCounts } from '../../../src/core/actions/invoices/doppelzahlung.ts';
import { computeHinweise } from '../../../src/core/elster/hinweise.ts';

let n = 0;
function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: `t${n++}`,
        source: 'camt',
        accountKey: 'camt:test',
        bookingDate: '2025-06-01',
        amount: -10,
        currency: 'EUR',
        ...over,
    };
}

// A business entity whose ELSTER config exercises many hint branches at once: gewerbe (→ gewst),
// business_end_date (→ Betriebsaufgabe), a doppelzahlung (→ Doppelzahlung), a Frist. The reporting
// year is 2025; business_end_date is the year end so every seeded booking is inside the active window.
const ELSTER = {
    tax_number: '',
    period: { year: 2025, quarter: 1 },
    entity_id: 'test',
    business_end_date: '2025-12-31',
    deadline_extension_months: 0,
    gewerbe: { gemeinde: 'Musterstadt', hebesatz: 400 },
    gesellschafter: [],
    adjustments: {
        doppelzahlungen: [{ transaktion_id: 'no-such-tx', bezeichnung: 'placeholder' }],
    },
    account_labels: {},
};

const KEYS = ['camt:test'];

export default async () => {
    await describe('computeYearHinweise — desktop/web parity + full set', async () => {
        let dir = '';
        let prev: Record<string, string | undefined> = {};

        beforeEach(async () => {
            prev = {
                TRANSACTIONS_DATA_DIR: process.env.TRANSACTIONS_DATA_DIR,
                LEDGER_DB_PATH: process.env.LEDGER_DB_PATH,
                STEUER_WORKSPACE: process.env.STEUER_WORKSPACE,
                SYNC_CONFIG: process.env.SYNC_CONFIG,
                PAPERLESS_BASE_URL: process.env.PAPERLESS_BASE_URL,
            };
            dir = mkdtempSync(join(tmpdir(), 'bh-hinweise-'));
            process.env.TRANSACTIONS_DATA_DIR = dir;
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
            const manifest = join(dir, 'steuererklaerung.json');
            writeFileSync(
                manifest,
                JSON.stringify({
                    version: 1,
                    entities: [{ id: 'test', name: 'Test GbR', kind: 'gbr', accounts: ['camt:test'] }],
                }),
            );
            process.env.STEUER_WORKSPACE = manifest;
            // No positive invoice document_type_ids → euer skips the Paperless fetch and resolves offline.
            const syncCfg = join(dir, 'sync-config.json');
            writeFileSync(syncCfg, JSON.stringify({}));
            process.env.SYNC_CONFIG = syncCfg;
            delete process.env.PAPERLESS_BASE_URL;

            // A vat-bearing income booking, a vat-bearing expense with NO receipt (→ Beleg-Lücke) and an
            // unknown expense (→ unklassifiziert). All inside the active period, profit ≪ Freibetrag.
            upsertAccount('camt:test', [
                tx({
                    id: 'inc',
                    amount: 1190,
                    bookingDate: '2025-06-01',
                    counterparty: 'Kunde',
                    purpose: 'Verkaufserlöse RE-2025-1',
                }),
                tx({
                    id: 'rent',
                    amount: -119,
                    bookingDate: '2025-06-05',
                    counterparty: 'Vermieter',
                    purpose: 'Betriebskosten Miete',
                }),
                tx({
                    id: 'mystery',
                    amount: -42,
                    bookingDate: '2025-06-10',
                    counterparty: 'Edeka',
                    purpose: 'Einkauf',
                }),
            ]);
            // Create + migrate the ledger so the built-in DMS list() resolves (empty → nothing linked).
            await new BuiltinDmsProvider('test').store({
                bytes: Buffer.from('%PDF-1.4 seed'),
                filename: 'seed.pdf',
                mimeType: 'application/pdf',
                created: '2024-01-01', // out of the reporting year → does not link, does not appear in 2025
            });
        });

        afterEach(async () => {
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        });

        await it('the web review cache and the shared function yield byte-identical Hinweise', async () => {
            const config = DEFAULT_SYNC_CONFIG;
            // Load the crafted config through the real parser (defaults + refinements applied).
            const cfg = normalizeElsterConfig(ElsterConfigRawSchema.parse(ELSTER));

            const dms = new BuiltinDmsProvider('test');
            const agg = await euerReportByTransactions(config, 2025, { detail: true, elster: cfg, accountKeys: KEYS });
            const docs = await dms.list({ from: '2025-01-01', to: '2025-12-31' });

            // The shared function is exactly what the desktop Auswertungen view now calls.
            const doppelzahlung = await doppelzahlungHinweisCounts(cfg.entity_id, 2025);
            const shared = computeYearHinweise({
                year: 2025,
                agg,
                elster: cfg,
                docs,
                doppelzahlung,
                accountKeys: KEYS,
                entityId: cfg.entity_id,
            });
            // The web review cache derives its `hinweise` field from the same function.
            const yc: YearCache = await buildYearCache(config, cfg, 2025, KEYS, dms);

            expect(JSON.stringify(yc.hinweise)).toBe(JSON.stringify(shared));
        });

        await it('produces the FULL hint set the old reduced desktop input dropped', async () => {
            const config = DEFAULT_SYNC_CONFIG;
            const cfg = normalizeElsterConfig(ElsterConfigRawSchema.parse(ELSTER));

            const dms = new BuiltinDmsProvider('test');
            const agg = await euerReportByTransactions(config, 2025, { detail: true, elster: cfg, accountKeys: KEYS });
            const docs = await dms.list({ from: '2025-01-01', to: '2025-12-31' });

            const full = computeYearHinweise({
                year: 2025,
                agg,
                elster: cfg,
                docs,
                accountKeys: KEYS,
                today: '2026-03-01',
            });
            const fullKeys = new Set(full.map((h) => h.key));

            // The migrated hints name their bookings; the Kontoauszug check runs per account.
            const ids = (key: string) => full.find((h) => h.key === key)?.betroffen?.map((b) => b.id) ?? [];
            expect(ids('beleg-luecke').length > 0).toBe(true);
            expect(ids('unklassifiziert').length > 0).toBe(true);
            expect(fullKeys.has('kontoauszug:camt:test')).toBe(true);

            // The hints ONLY the full input can produce (the divergence the desktop copy suffered).
            for (const key of ['beleg-luecke', 'frist', 'gewst-null', 'betriebsaufgabe', 'ust-vorauszahlungen']) {
                expect(fullKeys.has(key)).toBe(true);
            }

            // The exact reduced input the desktop `loadAuswertungen` used to build by hand.
            const afa = agg.expenses.find((c) => c.category.startsWith('4830'))?.net;
            const reduced = computeHinweise({
                year: 2025,
                umsatz: agg.totals.incomeNet,
                outputVat: agg.totals.outputVat,
                unclassified: agg.coverage.unclassified.length,
                nachtraeglichNet: agg.totals.nachtraeglichNet,
                afa,
            });
            const reducedKeys = new Set(reduced.map((h) => h.key));
            for (const key of ['beleg-luecke', 'frist', 'gewst-null', 'betriebsaufgabe', 'ust-vorauszahlungen']) {
                expect(reducedKeys.has(key)).toBe(false);
            }
            expect(full.length > reduced.length).toBe(true);
        });
    });
};
