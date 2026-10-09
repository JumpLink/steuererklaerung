import { describe, it, expect } from '@gjsify/unit';
import { buildEuerAdjustments } from '../../../src/core/actions/elster/euer.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

/** Minimal config exercising only the fields buildEuerAdjustments reads (adjustments + business dates). */
function config(over: Partial<ElsterConfig> = {}): ElsterConfig {
    return {
        adjustments: {
            anlageverzeichnis: [],
            privatanteile: [{ bezeichnung: 'Telefon', netto: 200, ust_satz: 0.19 }],
            sonderbetriebsausgaben: [],
            nachtraegliche_posten: [],
            nachtraeglich_gbr_ausgaben_gegenseiten: [],
            doppelzahlungen: [],
        },
        ...over,
    } as unknown as ElsterConfig;
}

export default async () => {
    await describe('buildEuerAdjustments — Privatanteil business-window scoping', async () => {
        await it('applies the Privatanteil in a normal year (no business end configured)', async () => {
            const adj = buildEuerAdjustments(config(), 2025);
            expect(adj.privatanteile?.length).toBe(1);
            expect(adj.privatanteile?.[0].net).toBe(200);
            expect(adj.privatanteile?.[0].vat).toBe(38);
        });

        await it('keeps the full Privatanteil in the Betriebsaufgabe year (no mid-year proration)', async () => {
            const adj = buildEuerAdjustments(config({ business_end_date: '2025-10-31' }), 2025);
            expect(adj.privatanteile?.length).toBe(1);
            expect(adj.privatanteile?.[0].net).toBe(200);
        });

        await it('drops the Privatanteil in years after the Betriebsaufgabe (dissolved GbR)', async () => {
            const adj = buildEuerAdjustments(config({ business_end_date: '2025-10-31' }), 2026);
            expect(adj.privatanteile).toStrictEqual([]);
        });

        await it('drops the Privatanteil in years before the business started', async () => {
            const adj = buildEuerAdjustments(config({ business_start_date: '2025-01-01' }), 2024);
            expect(adj.privatanteile).toStrictEqual([]);
        });
    });
};
