/**
 * The refusals of ADR 0001 step 3: a German-tax-only CLI command, MCP tool or web route refuses an
 * entity whose tax module is off, while the bookkeeping ones (EÜR report, classification) keep
 * working — and an entity without the new fields is never refused.
 *
 * Uses a fresh temp workspace under os.tmpdir() — never the real gitignored steuererklaerung.json.
 */
import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaxModuleOffError, capabilities } from '../../../src/core/countries/index.ts';
import { refuseWhenTaxOff } from '../../../src/frontends/cli/elster/shared.ts';
import { refuseTaxOnlyCall } from '../../../src/frontends/mcp/tax-guard.ts';
import { taxOffError, type EntityMeta } from '../../../src/frontends/web/routes.ts';

function manifest(gbrTax?: 'none', privatTax?: 'none'): string {
    return JSON.stringify({
        version: 1,
        entities: [
            {
                id: 'gbr',
                name: 'Muster & Partner GbR',
                kind: 'gbr',
                accounts: [],
                ...(gbrTax ? { taxModule: gbrTax } : {}),
                elster: { entity_id: 'gbr', tax_number: '11/222/33333', period: { year: 2025, quarter: 1 } },
            },
            {
                id: 'privat',
                name: 'Erika Mustermann',
                kind: 'privat',
                accounts: [],
                ...(privatTax ? { taxModule: privatTax } : {}),
            },
        ],
    });
}

function throwsTaxOff(fn: () => void): boolean {
    try {
        fn();
    } catch (err) {
        return err instanceof TaxModuleOffError;
    }
    return false;
}

function meta(taxModule: 'de' | 'none'): EntityMeta {
    return {
        id: 'gbr',
        name: 'Muster & Partner GbR',
        kind: 'gbr',
        hasElster: taxModule === 'de',
        hasEst: false,
        taxModule,
        capabilities: capabilities({ taxModule }),
        years: [2025],
        defaultYear: 2025,
        accountCount: 0,
    };
}

export default async () => {
    await describe('countries/tax guards', async () => {
        let dir = '';
        let prev: string | undefined;
        const write = (gbr?: 'none', privat?: 'none') =>
            writeFileSync(join(dir, 'steuererklaerung.json'), manifest(gbr, privat));

        beforeEach(async () => {
            prev = process.env.STEUER_WORKSPACE;
            dir = mkdtempSync(join(tmpdir(), 'bh-tax-guards-'));
            process.env.STEUER_WORKSPACE = join(dir, 'steuererklaerung.json');
        });

        afterEach(async () => {
            if (prev === undefined) delete process.env.STEUER_WORKSPACE;
            else process.env.STEUER_WORKSPACE = prev;
            rmSync(dir, { recursive: true, force: true });
        });

        await it('CLI: a filing command refuses, the EÜR report and classification do not', async () => {
            write('none');
            expect(throwsTaxOff(() => refuseWhenTaxOff(['uste', 'report'], { entity: 'gbr' }))).toBe(true);
            expect(throwsTaxOff(() => refuseWhenTaxOff(['submit'], {}))).toBe(true);
            expect(throwsTaxOff(() => refuseWhenTaxOff(['euer', 'report'], { entity: 'gbr' }))).toBe(false);
            expect(throwsTaxOff(() => refuseWhenTaxOff(['reclassify'], { entity: 'gbr' }))).toBe(false);
            expect(throwsTaxOff(() => refuseWhenTaxOff(['explain'], {}))).toBe(false);
        });

        await it('CLI: est and zve check the privat entity, not the business one', async () => {
            write('none');
            expect(throwsTaxOff(() => refuseWhenTaxOff(['zve'], {}))).toBe(false);
            write(undefined, 'none');
            expect(throwsTaxOff(() => refuseWhenTaxOff(['zve'], {}))).toBe(true);
            expect(throwsTaxOff(() => refuseWhenTaxOff(['uste', 'report'], {}))).toBe(false);
        });

        await it('CLI and MCP: an entity without the fields is never refused', async () => {
            write();
            expect(throwsTaxOff(() => refuseWhenTaxOff(['submit'], { entity: 'gbr' }))).toBe(false);
            expect(throwsTaxOff(() => refuseTaxOnlyCall('submit_filing', { entity: 'gbr' }))).toBe(false);
            expect(throwsTaxOff(() => refuseTaxOnlyCall('elster_zve', {}))).toBe(false);
        });

        await it('MCP: a tax-only tool refuses, a mixed tool does not', async () => {
            write('none');
            expect(throwsTaxOff(() => refuseTaxOnlyCall('elster_uste_report', { entity: 'gbr' }))).toBe(true);
            expect(throwsTaxOff(() => refuseTaxOnlyCall('elster_gewst_report', {}))).toBe(true);
            expect(throwsTaxOff(() => refuseTaxOnlyCall('elster_euer_report', { entity: 'gbr' }))).toBe(false);
            expect(throwsTaxOff(() => refuseTaxOnlyCall('record_classification', { entity: 'gbr' }))).toBe(false);
        });

        await it('MCP: an unknown entity id is left to the tool', async () => {
            write('none');
            expect(throwsTaxOff(() => refuseTaxOnlyCall('elster_uste_report', { entity: 'nope' }))).toBe(false);
        });

        await it('web: tax routes refuse a tax-off entity, bookkeeping routes do not', async () => {
            expect(taxOffError(meta('none'), 'uste')).toContain('ausgeschaltet');
            expect(taxOffError(meta('none'), 'steuerkonto')).toContain('ausgeschaltet');
            expect(taxOffError(meta('none'), 'euer')).toBe(null);
            expect(taxOffError(meta('none'), 'transactions')).toBe(null);
            expect(taxOffError(meta('de'), 'uste')).toBe(null);
        });
    });
};
