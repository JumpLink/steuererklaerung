/**
 * Gewerbesteuer report: orchestrate the EÜR aggregate, run the GewSt computation, and
 * print the Gewerbeertrag → Messbetrag breakdown. For the dissolved GbR the Messbetrag
 * is €0 (profit ≪ €24.500 Freibetrag) — the declaration is filed regardless.
 */

import { round2, fmtDe as fmt } from '../../lib/money.ts';
import type { SyncConfig } from '../../config/index.ts';
import type { ElsterConfig, ElsterGewerbe } from '../../config/index.ts';
import { computeGewst, type GewstResult, type GewstHinzurechnungen, type GewstKuerzungen } from '../../elster/gewst.ts';
import { euerReportByTransactions, totalSonderbetriebsausgaben } from './euer.ts';
import type { EuerTxAggregate } from '../../elster/euer-transactions.ts';

/** Map config Hinzurechnungen (snake_case) to the GewSt compute shape (camelCase). */
export function mapHinz(h: ElsterGewerbe['hinzurechnungen']): GewstHinzurechnungen | undefined {
    if (!h) return undefined;
    return {
        finanzierungsanteile: h.finanzierungsanteile,
        streubesitzdividenden: h.streubesitzdividenden,
        verlustanteilePersGes: h.verlustanteile_pers_ges,
        sonstige: h.sonstige,
    };
}

/** Map config Kürzungen (snake_case) to the GewSt compute shape (camelCase). */
export function mapKuerz(k: ElsterGewerbe['kuerzungen']): GewstKuerzungen | undefined {
    if (!k) return undefined;
    return {
        grundbesitz: k.grundbesitz,
        gewinnanteilePersGes: k.gewinnanteile_pers_ges,
        spenden: k.spenden,
        sonstige: k.sonstige,
    };
}

export interface GewstReport {
    result: GewstResult;
    euer: EuerTxAggregate;
}

/** Compute the GewSt for the year from the transaction-driven EÜR profit. */
export async function gewstReport(
    syncConfig: SyncConfig,
    elster: ElsterConfig,
    year: number,
    options: { accountKeys?: string[]; agg?: EuerTxAggregate } = {},
): Promise<GewstReport> {
    if (!elster.gewerbe) {
        throw new Error('No `gewerbe` block in the ELSTER config (gemeinde, hebesatz) — cannot compute GewSt.');
    }
    const euer =
        options.agg ?? (await euerReportByTransactions(syncConfig, year, { accountKeys: options.accountKeys, elster }));
    // The Gewerbeertrag of the Mitunternehmerschaft is the Gesamthandsgewinn (EÜR) less
    // the partners' Sonderbetriebsausgaben and the GewSt-free §24 nachträgliche Posten
    // (auto-classified post-Aufgabe bookings + config nachtraegliche_posten, via the aggregate).
    const result = computeGewst({
        profit: round2(euer.totals.profit - totalSonderbetriebsausgaben(elster) - euer.totals.nachtraeglichNet),
        hinzurechnungen: mapHinz(elster.gewerbe.hinzurechnungen),
        kuerzungen: mapKuerz(elster.gewerbe.kuerzungen),
        hebesatz: elster.gewerbe.hebesatz,
        gemeinde: elster.gewerbe.gemeinde,
        year,
    });
    return { result, euer };
}

/** Print the Gewerbesteuer computation breakdown. */
export function printGewstReport(report: GewstReport, gewerbe: ElsterGewerbe, year: number): void {
    const r = report.result;
    console.log(`\nGewerbesteuer ${year} — Messbetragsermittlung (GewSt 1 A)`);
    console.log('='.repeat(60));
    console.log(`Gemeinde: ${gewerbe.gemeinde}   Hebesatz: ${gewerbe.hebesatz} %`);
    console.log('');
    console.log(
        `  Gewinn aus Gewerbebetrieb (EÜR)       ${fmt(r.gewerbeertrag - r.sumHinzurechnungen + r.sumKuerzungen).padStart(14)} €`,
    );
    console.log(`  + Hinzurechnungen (§8)                ${fmt(r.sumHinzurechnungen).padStart(14)} €`);
    console.log(`  − Kürzungen (§9)                      ${fmt(r.sumKuerzungen).padStart(14)} €`);
    console.log(`  = Gewerbeertrag                       ${fmt(r.gewerbeertrag).padStart(14)} €`);
    console.log(`  Gewerbeertrag (abgerundet, §11)       ${fmt(r.gewerbeertragRounded).padStart(14)} €`);
    console.log(`  − Freibetrag                          ${fmt(r.freibetrag).padStart(14)} €`);
    console.log(`  = Bemessungsgrundlage                 ${fmt(r.bemessungsgrundlage).padStart(14)} €`);
    console.log(`  × Steuermesszahl ${(r.steuermesszahl * 100).toFixed(1)} %`);
    console.log(`  = Steuermessbetrag                    ${fmt(r.messbetrag).padStart(14)} €`);
    console.log(`  Gewerbesteuer (Messbetrag × Hebesatz) ${fmt(r.gewerbesteuer).padStart(14)} €`);
    if (r.messbetrag === 0) {
        console.log('\n  → Messbetrag 0 € (Gewinn unter dem Freibetrag). Erklärung wird dennoch abgegeben.');
    }
    console.log('');
}
