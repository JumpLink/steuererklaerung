import { describe, it, expect, vi, afterEach } from '@gjsify/unit';
import { rmSync } from 'node:fs';
import { getPeriodDateRange, loadManifest, resolveEntity } from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

/**
 * The former standalone elster-config loader is gone; an entity's ELSTER config now lives inline in the
 * consolidated manifest and resolves through `resolveEntity(...).elster` (same normalisation the old
 * loadElsterConfig applied: ELSTER_TAX_NUMBER override, schema_version ?? period.year, …).
 */
export default async () => {
    await describe('inline ELSTER config (resolveEntity)', async () => {
        const dirs: string[] = [];
        afterEach(() => {
            for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
            vi.unstubAllEnvs();
        });

        function fixture(elster: object) {
            const { dir, path } = writeManifestFixture({ entities: [{ id: 'gbr', kind: 'gbr', elster }] });
            dirs.push(dir);
            return resolveEntity(loadManifest(path), 'gbr').elster!;
        }

        await it('resolves a valid config with quarter period', async () => {
            const config = fixture({ tax_number: '12/345/67890', period: { year: 2025, quarter: 1 } });
            expect(config.tax_number).toBe('12/345/67890');
            expect(config.period.year).toBe(2025);
            expect(config.period.quarter).toBe(1);
            expect(config.schema_version).toBe(2025);
        });

        await it('resolves a valid config with month period', async () => {
            const config = fixture({ period: { year: 2025, month: 6 } });
            expect(config.period.month).toBe(6);
        });

        await it('overrides tax_number from env', async () => {
            vi.stubEnv('ELSTER_TAX_NUMBER', 'from-env');
            const config = fixture({ tax_number: 'from-file', period: { year: 2025, quarter: 1 } });
            expect(config.tax_number).toBe('from-env');
        });

        await it('rejects a period without quarter or month', async () => {
            expect(() => fixture({ period: { year: 2025 } })).toThrow(/quarter.*month|Ungültiges|Invalid/);
        });

        await it('fails loud on a missing manifest', async () => {
            expect(() => loadManifest('/tmp/definitely-missing-steuererklaerung.json')).toThrow(/migrate|Manifest/);
        });
    });

    await describe('getPeriodDateRange', async () => {
        await it('computes Q1 range', async () => {
            const range = getPeriodDateRange({ year: 2025, quarter: 1 });
            expect(range.dateFrom).toBe('2025-01-01');
            expect(range.dateTo).toBe('2025-03-31');
        });

        await it('computes Q2 range', async () => {
            const range = getPeriodDateRange({ year: 2025, quarter: 2 });
            expect(range.dateFrom).toBe('2025-04-01');
            expect(range.dateTo).toBe('2025-06-30');
        });

        await it('computes Q4 range', async () => {
            const range = getPeriodDateRange({ year: 2025, quarter: 4 });
            expect(range.dateFrom).toBe('2025-10-01');
            expect(range.dateTo).toBe('2025-12-31');
        });

        await it('computes February range (non-leap year)', async () => {
            const range = getPeriodDateRange({ year: 2025, month: 2 });
            expect(range.dateFrom).toBe('2025-02-01');
            expect(range.dateTo).toBe('2025-02-28');
        });

        await it('computes February range (leap year)', async () => {
            const range = getPeriodDateRange({ year: 2024, month: 2 });
            expect(range.dateFrom).toBe('2024-02-01');
            expect(range.dateTo).toBe('2024-02-29');
        });

        await it('computes December range', async () => {
            const range = getPeriodDateRange({ year: 2025, month: 12 });
            expect(range.dateFrom).toBe('2025-12-01');
            expect(range.dateTo).toBe('2025-12-31');
        });
    });
};
