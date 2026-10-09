import { describe, it, expect, vi, afterEach } from '@gjsify/unit';
import { rmSync } from 'node:fs';
import { parseElsterArgs } from '../../../src/frontends/cli/elster/shared.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

/**
 * Regression: `--year` must move BOTH `period.year` and `schema_version`. schema_version drives the
 * `ustva/v<year>` namespace + the derived ERiC datenartVersion (UStVA_<year>); leaving it at the
 * config default while `<Jahr>` follows --year made ERiC reject a 2026 UStVA with UStVA_Jahr_gleich_VZ.
 *
 * The former ELSTER_CONFIG file/env is gone: parseElsterArgs resolves the default (or `--entity`)
 * manifest entity's inline `elster` section.
 */
export default async () => {
    await describe('parseElsterArgs period/schema_version sync', async () => {
        const dirs: string[] = [];
        afterEach(() => {
            for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
            vi.unstubAllEnvs();
        });

        function useConfig(elster: object): void {
            const { dir, path } = writeManifestFixture({ entities: [{ id: 'gbr', kind: 'gbr', elster }] });
            dirs.push(dir);
            vi.stubEnv('STEUER_WORKSPACE', path);
        }

        await it('syncs schema_version to the --year override', async () => {
            // Config default year 2025 (schema_version 2025 derived from it).
            useConfig({ tax_number: '12/345/67890', period: { year: 2025, quarter: 1 } });

            const config = parseElsterArgs({ year: 2026, quarter: 1 });

            expect(config.period.year).toBe(2026);
            expect(config.period.quarter).toBe(1);
            // The bug: this stayed 2025 → ustva/v2025 namespace + UStVA_2025 datenart while <Jahr>=2026.
            expect(config.schema_version).toBe(2026);
        });

        await it('leaves schema_version at the config year when --year is absent', async () => {
            useConfig({ tax_number: '12/345/67890', period: { year: 2025, quarter: 1 } });

            const config = parseElsterArgs({ quarter: 2 });

            expect(config.period.quarter).toBe(2);
            expect(config.period.year).toBe(2025);
            expect(config.schema_version).toBe(2025);
        });
    });
};
