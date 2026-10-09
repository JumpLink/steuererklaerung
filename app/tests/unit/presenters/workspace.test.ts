import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertAccount, type UnifiedTransaction } from '@steuererklaerung/store';
import {
    candidateYears,
    entityOf,
    loadWorkspaceModel,
    type WorkspaceModel,
} from '../../../src/core/presenters/workspace.ts';

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

/** A minimal v1 manifest with two entities sharing one account; neither carries an inline elster/est. */
const MANIFEST = JSON.stringify({
    version: 1,
    entities: [
        { id: 'test', name: 'Test GbR', kind: 'gbr', accounts: ['camt:test'] },
        { id: 'broken', name: 'Broken', kind: 'einzelunternehmen', accounts: ['camt:test'] },
    ],
});

export default async () => {
    await describe('presenters/workspace', async () => {
        let dir = '';
        let prev: Record<string, string | undefined> = {};

        beforeEach(async () => {
            prev = {
                TRANSACTIONS_DATA_DIR: process.env.TRANSACTIONS_DATA_DIR,
                LEDGER_DB_PATH: process.env.LEDGER_DB_PATH,
                STEUER_WORKSPACE: process.env.STEUER_WORKSPACE,
            };
            dir = mkdtempSync(join(tmpdir(), 'bh-ws-'));
            process.env.TRANSACTIONS_DATA_DIR = dir;
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
            const manifest = join(dir, 'steuererklaerung.json');
            writeFileSync(manifest, MANIFEST);
            process.env.STEUER_WORKSPACE = manifest;
            // Seed transactions in two years so the probe reports [2024, 2025].
            upsertAccount('camt:test', [
                tx({ id: 'a', bookingDate: '2024-06-01' }),
                tx({ id: 'b', bookingDate: '2025-06-01' }),
            ]);
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

        await it('candidateYears is a 9-year window ending at the current year', async () => {
            const years = candidateYears();
            const current = new Date().getFullYear();
            expect(years.length).toBe(9);
            expect(years[years.length - 1]).toBe(current);
            expect(years[0]).toBe(current - 8);
            // strictly ascending
            expect(years.every((y, i) => i === 0 || y === years[i - 1] + 1)).toBe(true);
        });

        await it('reports the years an entity actually has data for + a sensible defaultYear', async () => {
            const ws = loadWorkspaceModel();
            const test = ws.entities.find((e) => e.id === 'test');
            expect(test).toBeDefined();
            expect(test?.years).toStrictEqual([2024, 2025]);
            expect(test?.defaultYear).toBe(2025);
            expect(test?.accountKeys).toStrictEqual(['camt:test']);
            // First entity with data is the default; the assistant defaults on.
            expect(ws.defaultEntity).toBe('test');
            expect(ws.assistant).toBe(true);
        });

        await it('honours an explicit years override (like the web --years)', async () => {
            const ws = loadWorkspaceModel({ years: [2025] });
            const test = ws.entities.find((e) => e.id === 'test');
            expect(test?.years).toStrictEqual([2025]);
            expect(test?.defaultYear).toBe(2025);
        });

        await it('is tolerant: a broken/absent ELSTER or ESt config → hasElster/hasEst false, no throw', async () => {
            const ws = loadWorkspaceModel();
            const broken = ws.entities.find((e) => e.id === 'broken');
            expect(broken).toBeDefined();
            expect(broken?.hasElster).toBe(false);
            expect(broken?.hasEst).toBe(false);
            // An entity with no config paths at all is likewise false (not undefined).
            const test = ws.entities.find((e) => e.id === 'test');
            expect(test?.hasElster).toBe(false);
            expect(test?.hasEst).toBe(false);
        });

        await it('entityOf resolves by id and falls back to the default entity', async () => {
            const ws: WorkspaceModel = loadWorkspaceModel();
            expect(entityOf(ws, 'broken')?.id).toBe('broken');
            // Unknown id → the default entity (web fallback-to-default semantics).
            expect(entityOf(ws, 'nope')?.id).toBe(ws.defaultEntity);
            // No id → the default entity.
            expect(entityOf(ws, undefined)?.id).toBe(ws.defaultEntity);
        });
    });
};
