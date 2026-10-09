import { describe, it, expect } from '@gjsify/unit';
import { buildDemoTransactions } from '../../../src/core/lib/demo/dataset.ts';
import { estReport } from '../../../src/core/actions/elster/est.ts';
import { buildEstPlan } from '../../../src/core/actions/elster/wizard.ts';
import { loadManifest, resolveEntity } from '../../../src/core/config/index.ts';

/** The demo `privat` (GIRO) transactions — real ids, so the §35a override wiring is exercised end-to-end. */
function giroTxs() {
    const acc = buildDemoTransactions().find((a) => a.key.includes('giro'));
    return acc?.txs ?? [];
}

// Loads the SHIPPED demo manifest's `privat` entity ESt section (cwd = app/ under the test run) so this
// test validates the real demo config — including that its par35a_arbeitskosten transaktion_ids still
// match the demo txs.
export default async () => {
    await describe('estReport — demo privat entity end-to-end (shipped demo/steuererklaerung.json)', async () => {
        const txs = giroTxs();
        const config = resolveEntity(loadManifest('demo/steuererklaerung.json'), 'privat').est!;

        await it('the demo Handwerker transactions exist with the referenced ids', async () => {
            expect(txs.find((t) => t.counterparty === 'Elektro Petersen')?.id).toBe('demo-giro-109');
            expect(txs.find((t) => t.counterparty === 'Malermeister Voss')?.id).toBe('demo-giro-112');
        });

        await it('classifies the private account and treats §35a gross as an upper bound', async () => {
            const r = estReport(config, 2025, { txs });
            expect(r.aggregate.handwerkerBrutto).toBe(952); // 238 + 714 gross
            expect(r.aggregate.krankheitskosten).toBe(386.5); // Zahnarzt
            expect(r.aggregate.spenden).toBe(150); // Seenotretter
            expect(r.aggregate.gehaltNettoSumme).toBe(2850 * 12); // monthly salary inflow
        });

        await it('claims the Arbeitskosten via the shipped config overrides (ids still valid)', async () => {
            const r = estReport(config, 2025, { txs });
            expect(r.aggregate.par35aOhneArbeitskosten).toBe(0); // both Handwerker txs matched an override
            expect(r.inputs.par35a.handwerkerArbeitskosten).toBe(580); // 160 + 420 Arbeitslohn
            // No par35a_manuell: the E10 needs Art + Betrag per item, which a lump sum cannot give.
            expect(r.inputs.par35a.haushaltsnah).toBe(0);
            // §35a = 20 % × 580 = 116
            expect(r.result.ermaessigung35a.berechnet).toBe(116);
        });

        await it('produces a ready ESt plan with the est form preview', async () => {
            const plan = buildEstPlan(config, 2025, { txs });
            expect(plan.ready).toBe(true);
            expect(plan.forms.length).toBe(1);
            expect(plan.forms[0].form).toBe('est');
            expect(plan.forms[0].canExport).toBe(true); // E10-XML + Prüfblatt export vorhanden
            expect(plan.steps.find((s) => s.id === 'zusammenfassung')?.status).toBe('ok');
        });

        await it('carries the Steuer-Themen cards + Abzugs-Wasserfall for the front-ends', async () => {
            const plan = buildEstPlan(config, 2025, { txs });
            expect(plan.est != null).toBe(true);
            expect(plan.est?.themes.length).toBe(6); // arbeit/handwerker/haushaltsnah/vorsorge/gesundheit/spenden
            const handwerker = plan.est?.themes.find((t) => t.key === 'handwerker');
            expect(handwerker?.status).toBe('done'); // overrides supplied → §35a wirkt
            const gesundheit = plan.est?.themes.find((t) => t.key === 'gesundheit');
            expect(gesundheit?.status).toBe('open'); // Zahnarzt unter der zumutbaren Belastung
            // The waterfall ends on the signed Erstattung/Nachzahlung row.
            expect(plan.est?.waterfall.at(-1)?.emphasis).toBe('result');
        });

        await it('blocks the plan when no Lohnsteuerbescheinigung exists for the (valid) tarif year', async () => {
            const plan = buildEstPlan({ ...config, jahre: [] }, 2025, { txs });
            expect(plan.ready).toBe(false);
            expect(plan.steps.find((s) => s.id === 'vollstaendigkeit')?.status).toBe('blocked');
        });
    });
};
