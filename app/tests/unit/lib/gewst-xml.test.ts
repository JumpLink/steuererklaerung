import { describe, it, expect } from '@gjsify/unit';
import { buildGewstEds, gewstDatenartVersion } from '../../../src/core/elster/gewst-xml.ts';
import { computeGewst } from '../../../src/core/elster/gewst.ts';
import type { EuerBetrieb } from '../../../src/core/elster/euer-xml.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

const betrieb: EuerBetrieb = {
    name: 'Musterbetrieb GbR',
    strasse: 'Musterstraße 1',
    plz: '12345',
    ort: 'Musterstadt',
    art: 'Softwareentwicklung',
};

const config: ElsterConfig = {
    tax_number: '9198011310010',
    schema_version: 2025,
    period: { year: 2025, quarter: 4 },
    output_directory: '/tmp',
    test_mode: true,
    taxation_basis: 'ist',
    ust_dauerfristverlaengerung: false,
    exclude_tags: [],
    include_tags: [],
    entity_id: 'artcode',
    account_labels: {},
    gesellschafter: [],
};

const result = computeGewst({ profit: 2332.38, hebesatz: 480, gemeinde: 'Musterstadt', year: 2025 });

export default async () => {
    await describe('buildGewstEds', async () => {
        const xml = buildGewstEds(result, config, betrieb, 2025);
        await it('targets the GewSt 2025 DatenArt + namespace', async () => {
            expect(gewstDatenartVersion(2025)).toBe('GewSt_2025');
            expect(xml).toContain('<DatenArt>GewSt</DatenArt>');
            expect(xml).toContain('<E20 xmlns="http://finkonsens.de/elster/elstererklaerung/gewst/e20/v2025" version="2025">');
        });
        await it('emits the GbR Rechtsform, single-Betriebsstätte answers, and the Gewinn', async () => {
            expect(xml).toContain('<E4000501>270</E4000501>'); // Rechtsform = GbR
            expect(xml).toContain('<E4001506>2</E4001506>'); // keine mehreren Gemeinden
            expect(xml).toContain('<E4001102>2</E4001102>'); // nicht verlegt
            expect(xml).toContain('<E4001111>Musterstadt</E4001111>'); // Ort der Betriebsstätte
            expect(xml).toContain('<E4001703>2332</E4001703>'); // Gewinn aus Gewerbebetrieb (full euros)
        });
    });

    // Betriebsaufgabe: the Gemeinde/FA must learn that the Gewerbebetrieb ended, else further
    // Erhebungszeiträume are expected. Vordruckzeile 35 / E4002205, format TT.MM (no year).
    await describe('werbende Tätigkeit beendet (E4002205)', async () => {
        await it('emits the Aufgabe date as TT.MM when it falls in the declared year', async () => {
            const xml = buildGewstEds(result, { ...config, business_end_date: '2025-10-31' }, betrieb, 2025);
            expect(xml).toContain('<Betr_Eroeff>');
            expect(xml).toContain('<E4002205>31.10</E4002205>');
        });

        await it('omits it for a going concern', async () => {
            expect(buildGewstEds(result, config, betrieb, 2025)).not.toContain('<Betr_Eroeff>');
        });

        await it('omits it when the Aufgabe belongs to another year', async () => {
            const xml = buildGewstEds(result, { ...config, business_end_date: '2024-10-31' }, betrieb, 2025);
            expect(xml).not.toContain('<E4002205>');
        });
    });

    await describe('schema year', async () => {
        await it('writes the E20 of 2024 for 2024 and keeps 2025 for a year without its own', async () => {
            expect(buildGewstEds(result, config, betrieb, 2024)).toContain('/gewst/e20/v2024" version="2024">');
            expect(buildGewstEds(result, config, betrieb, 2026)).toContain('/gewst/e20/v2025" version="2025">');
        });
    });
};
