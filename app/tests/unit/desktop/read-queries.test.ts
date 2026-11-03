/**
 * The reads the window moves into the worker: what `transaktionenQuery` and `steuerQuery` return for a
 * business and a privat entity, and how they degrade. Invented bookings; a fake session, no worker.
 */

import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnifiedTransaction } from '@steuererklaerung/store';
import { steuerQuery, transaktionenQuery } from '../../../src/frontends/desktop/read/queries.ts';
import type { PresenterSession } from '../../../src/core/presenters/session.ts';
import type { EntityModel } from '../../../src/core/presenters/workspace.ts';
import { aggregateEuerByTransactions } from '../../../src/core/elster/euer-transactions.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';
import { capabilities } from '../../../src/core/countries/index.ts';

const txs: UnifiedTransaction[] = [
    {
        id: 'q1',
        source: 'camt',
        accountKey: 'camt:test',
        bookingDate: '2026-02-03',
        amount: -119,
        currency: 'EUR',
        counterparty: 'Küstenlicht Bildagentur',
        purpose: 'Bürobedarf Bildlizenz',
    },
    {
        id: 'q2',
        source: 'camt',
        accountKey: 'camt:test',
        bookingDate: '2026-05-06',
        amount: 1190,
        currency: 'EUR',
        counterparty: 'Hafenlicht GmbH',
        purpose: 'Rechnung RE-2026-0001',
    },
];

function makeSession(aggregate: PresenterSession['aggregate']): PresenterSession {
    return {
        elster: () => ({ account_labels: {} }) as unknown as ElsterConfig,
        aggregate,
        documents: async () => ({ docs: [], dmsKind: 'builtin' as const }),
        invalidate: () => {},
    } as unknown as PresenterSession;
}

const okSession = makeSession(async () => aggregateEuerByTransactions(txs, new Map(), 2026, { detail: true }));

function makeEntity(over: Partial<EntityModel>): EntityModel {
    return {
        id: 'firma',
        name: 'Beispiel GbR',
        kind: 'gbr',
        country: 'DE',
        taxModule: 'de' as const,
        capabilities: capabilities({}),
        hasElster: true,
        hasEst: false,
        years: [2026],
        defaultYear: 2026,
        accountKeys: [],
        dmsType: 'builtin',
        ...over,
    } as EntityModel;
}

const business = makeEntity({ elster: { account_labels: {} } as unknown as ElsterConfig });
const privat = makeEntity({ id: 'privat', name: 'Privat', kind: 'privat' as never, elster: undefined });

export default async () => {
    await describe('read queries', async () => {
        let dir = '';
        let prev: Record<string, string | undefined> = {};
        const useManifest = (manifest: string | undefined) => {
            if (manifest === undefined) process.env.STEUER_WORKSPACE = join(dir, 'fehlt.json');
            else {
                const file = join(dir, 'steuererklaerung.json');
                writeFileSync(file, manifest);
                process.env.STEUER_WORKSPACE = file;
            }
        };
        beforeEach(async () => {
            prev = { STEUER_WORKSPACE: process.env.STEUER_WORKSPACE, LEDGER_DB_PATH: process.env.LEDGER_DB_PATH };
            dir = mkdtempSync(join(tmpdir(), 'bh-read-queries-'));
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
        });
        afterEach(async () => {
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            rmSync(dir, { recursive: true, force: true });
        });

        await it('transaktionen: a business entity gets the classified rows and its projects', async () => {
            useManifest(
                JSON.stringify({
                    version: 1,
                    entities: [{ id: 'firma', name: 'Beispiel GbR', kind: 'gbr', accounts: [], projects: [] }],
                }),
            );
            const r = await transaktionenQuery(okSession, business, 2026);
            expect(r.data.classified).toBe(true);
            expect(r.data.rows.map((x) => x.id).join()).toBe('q2,q1'); // newest first
            expect(r.projekte === null).toBe(false);
            expect(r.projekteFehler).toBe(undefined);
        });

        await it('transaktionen: an entity without ELSTER gets the raw list and no projects', async () => {
            useManifest(undefined);
            const r = await transaktionenQuery(okSession, privat, 2026);
            expect(r.data.classified).toBe(false);
            expect(r.projekte).toBe(null);
            expect(r.projekteFehler).toBe(undefined);
        });

        await it('transaktionen: a failing project view keeps the bookings and reports why', async () => {
            useManifest(undefined);
            const r = await transaktionenQuery(okSession, business, 2026);
            expect(r.data.rows.length).toBe(2);
            expect(r.projekte).toBe(null);
            expect(typeof r.projekteFehler).toBe('string');
        });

        await it('steuer: strips the per-booking detail and resolves the optional reports to null on failure', async () => {
            // No ELSTER config on the entity: the EÜR still works, the annual reports cannot.
            const r = await steuerQuery(okSession, privat, 2026);
            expect(r.euer.aggregate.detail).toBe(undefined);
            expect(r.euer.aggregate.totals.profit).toBe(1190 / 1.19 - 119 / 1.19);
            expect(r.uste).toBe(null);
            expect(r.gewst).toBe(null);
            expect(r.fest).toBe(null);
        });

        await it('steuer: the EÜR is required — its failure rejects', async () => {
            const failing = makeSession(async () => {
                throw new Error('keine Daten');
            });
            let msg = '';
            try {
                await steuerQuery(failing, business, 2026);
            } catch (e) {
                msg = e instanceof Error ? e.message : String(e);
            }
            expect(msg).toBe('keine Daten');
        });
    });
};
