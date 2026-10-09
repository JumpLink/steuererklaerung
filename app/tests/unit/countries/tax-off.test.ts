/**
 * Switching the German tax module off (ADR 0001) hides tax features — and ONLY those. The
 * categorisation rules live in the `elster` section, so the load-bearing guarantee checked here is
 * that a tax-off entity still classifies its bookings exactly as before and keeps its EÜR-based
 * bookkeeping totals, while every tax capability reads false.
 *
 * Uses a fresh temp workspace under os.tmpdir() — never the real gitignored steuererklaerung.json.
 */
import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertAccount, type UnifiedTransaction } from '@steuererklaerung/store';
import { BuiltinDmsProvider } from '@steuererklaerung/dms';
import { capabilities, requireTaxModule, TaxModuleOffError } from '../../../src/core/countries/index.ts';
import { loadWorkspaceModel } from '../../../src/core/presenters/workspace.ts';
import { createPresenterSession } from '../../../src/core/presenters/session.ts';
import { loadEnrichedTransactions } from '../../../src/core/presenters/buchungen.ts';
import { loadFreiVerfuegbar } from '../../../src/core/presenters/frei-verfuegbar.ts';

function tx(over: Partial<UnifiedTransaction>): UnifiedTransaction {
    return {
        id: 'x',
        source: 'camt',
        accountKey: 'camt:test',
        bookingDate: '2025-06-01',
        amount: -10,
        currency: 'EUR',
        ...over,
    };
}

function manifest(taxModule?: 'none'): string {
    return JSON.stringify({
        version: 1,
        entities: [
            {
                id: 'gbr',
                name: 'Muster & Partner GbR',
                kind: 'gbr',
                accounts: ['camt:test'],
                ...(taxModule ? { taxModule } : {}),
                elster: {
                    entity_id: 'gbr',
                    tax_number: '11/222/33333',
                    period: { year: 2025, quarter: 1 },
                    klassifizierung: {
                        privat_gegenseiten: ['Musterladen'],
                        erloes_gegenseiten: ['Kunde Beispiel'],
                    },
                },
            },
        ],
    });
}

export default async () => {
    await describe('countries/tax module off', async () => {
        let dir = '';
        let prev: Record<string, string | undefined> = {};

        async function workspace(taxModule?: 'none') {
            writeFileSync(join(dir, 'steuererklaerung.json'), manifest(taxModule));
            const session = createPresenterSession();
            const entity = session.workspace.entities.find((e) => e.id === 'gbr')!;
            return { session, entity };
        }

        beforeEach(async () => {
            prev = {
                TRANSACTIONS_DATA_DIR: process.env.TRANSACTIONS_DATA_DIR,
                LEDGER_DB_PATH: process.env.LEDGER_DB_PATH,
                STEUER_WORKSPACE: process.env.STEUER_WORKSPACE,
                PAPERLESS_BASE_URL: process.env.PAPERLESS_BASE_URL,
            };
            dir = mkdtempSync(join(tmpdir(), 'bh-tax-off-'));
            process.env.TRANSACTIONS_DATA_DIR = dir;
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
            process.env.STEUER_WORKSPACE = join(dir, 'steuererklaerung.json');
            delete process.env.PAPERLESS_BASE_URL;
            upsertAccount('camt:test', [
                tx({ id: 'erloes', amount: 1190, counterparty: 'Kunde Beispiel', purpose: 'Projekt' }),
                tx({ id: 'privat', amount: -50, counterparty: 'Musterladen', purpose: 'Einkauf' }),
            ]);
            await new BuiltinDmsProvider('gbr').store({
                bytes: Buffer.from('%PDF-1.4 seed'),
                filename: 'seed.pdf',
                mimeType: 'application/pdf',
                created: '2025-06-15',
            });
        });

        afterEach(async () => {
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            rmSync(dir, { recursive: true, force: true });
        });

        await it('every tax capability is off; the ELSTER section stays loaded', async () => {
            writeFileSync(join(dir, 'steuererklaerung.json'), manifest('none'));
            const gbr = loadWorkspaceModel().entities.find((e) => e.id === 'gbr')!;
            expect(gbr.taxModule).toBe('none');
            expect(Object.values(gbr.capabilities).every((on) => !on)).toBe(true);
            expect(gbr.hasElster).toBe(false);
            expect(gbr.elster?.entity_id).toBe('gbr');
        });

        await it('an entity without the fields keeps every tax capability on', async () => {
            writeFileSync(join(dir, 'steuererklaerung.json'), manifest());
            const gbr = loadWorkspaceModel().entities.find((e) => e.id === 'gbr')!;
            expect(gbr.taxModule).toBe('de');
            expect(Object.values(gbr.capabilities).every((on) => on)).toBe(true);
            expect(gbr.hasElster).toBe(true);
        });

        await it('categorisation and the EÜR bookkeeping totals do not change', async () => {
            const on = await workspace();
            const withTax = await loadEnrichedTransactions(on.session, on.entity, 2025);
            const off = await workspace('none');
            const withoutTax = await loadEnrichedTransactions(off.session, off.entity, 2025);

            expect(withoutTax.classified).toBe(true);
            const cats = (d: typeof withTax) => d.rows.map((r) => `${r.id}:${r.category}:${r.kz}`).sort();
            expect(cats(withoutTax)).toStrictEqual(cats(withTax));
            expect(withoutTax.rows.find((r) => r.id === 'erloes')?.category).not.toBe('');
            expect(withoutTax.totals).toStrictEqual(withTax.totals);
        });

        await it('the reserve drops its tax parts with the reason', async () => {
            const { session, entity } = await workspace('none');
            const frei = await loadFreiVerfuegbar(session, entity, { year: 2025, today: '2025-07-01' });
            expect(frei.steuerruecklage.terme.every((t) => t.status === 'entfaellt')).toBe(true);
            expect(frei.steuerruecklage.terme[0].erklaerung).toContain('Steuerfunktionen');
        });

        await it('requireTaxModule refuses a tax-off entity with a clear message', async () => {
            expect(capabilities({}).taxFiling).toBe(true);
            let err: unknown;
            try {
                requireTaxModule({ id: 'gbr', taxModule: 'none' });
            } catch (e) {
                err = e;
            }
            expect(err instanceof TaxModuleOffError).toBe(true);
            expect((err as Error).message).toContain('„gbr"');
        });
    });
};
