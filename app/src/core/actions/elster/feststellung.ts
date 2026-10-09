/**
 * Feststellungs-Datenblatt (interim): orchestrate the EÜR aggregate, allocate the
 * profit to the Gesellschafter, and print the figures to transcribe into Mein ELSTER's
 * Feststellung Hauptvordruck + Anlage FE — paired with the Anlage-EÜR Kennzahlen so the
 * GbR return can be filed manually now. The later full Feststellung XML reuses the same
 * {@link computeFeststellung}.
 */

import { round2, fmtDe as fmt } from '../../lib/money.ts';
import type { SyncConfig } from '../../config/index.ts';
import type { ElsterConfig, ElsterGesellschafter } from '../../config/index.ts';
import { computeFeststellung, type FeststellungResult, type Gesellschafter } from '../../elster/feststellung.ts';
import {
    euerReportByTransactions,
    buildEuerKennzahlen,
    sonderbetriebsausgabenMap,
    buildAufgabegewinn,
} from './euer.ts';
import type { AufgabegewinnResult } from '../../elster/betriebsaufgabe.ts';
import type { EuerTxAggregate } from '../../elster/euer-transactions.ts';

/** Map a config Gesellschafter (snake_case) to the pure-function shape (camelCase). */
export function toGesellschafter(c: ElsterGesellschafter): Gesellschafter {
    return { id: c.id, name: c.name, steuerId: c.steuer_id, quote: c.quote, finanzamt: c.finanzamt };
}

export interface FeststellungReport {
    result: FeststellungResult;
    euer: EuerTxAggregate;
    /** The Betriebsaufgabe breakdown (per-asset gemeiner Wert vs. Restbuchwert), if any. */
    aufgabe?: AufgabegewinnResult;
}

/** Compute the GbR profit allocation for the year from the transaction-driven EÜR. */
export async function feststellungReport(
    syncConfig: SyncConfig,
    elster: ElsterConfig,
    year: number,
    options: { accountKeys?: string[]; agg?: EuerTxAggregate } = {},
): Promise<FeststellungReport> {
    if (elster.gesellschafter.length === 0) {
        throw new Error('No `gesellschafter` configured in the ELSTER config — cannot allocate the GbR profit.');
    }
    const euer =
        options.agg ?? (await euerReportByTransactions(syncConfig, year, { accountKeys: options.accountKeys, elster }));
    const aufgabe = buildAufgabegewinn(elster, year);
    const result = computeFeststellung(
        round2(euer.totals.profit),
        elster.gesellschafter.map(toGesellschafter),
        year,
        sonderbetriebsausgabenMap(elster),
        aufgabe?.aufgabegewinn ?? 0,
    );
    return { result, euer, aufgabe: aufgabe ?? undefined };
}

/** Print the Datenblatt for manual entry into Mein ELSTER. */
export function printFeststellungDatenblatt(report: FeststellungReport, elster: ElsterConfig): void {
    const { result, euer } = report;
    console.log(`\nFeststellungs-Datenblatt ${result.year} — gesonderte u. einheitliche Feststellung (GbR)`);
    console.log('='.repeat(76));
    console.log(`Steuernummer: ${elster.tax_number}`);

    const hasSbv = result.allocations.some((a) => a.sonderbetriebsausgaben !== 0);
    const hasAufgabe = result.aufgabegewinn !== 0;
    console.log('\nGesamthand (Einkünfte aus Gewerbebetrieb):');
    console.log(`  Laufender Gewinn lt. EÜR ${fmt(result.totalProfit).padStart(12)} €`);
    if (hasSbv) {
        const sbvSum = result.allocations.reduce((s, a) => s + a.sonderbetriebsausgaben, 0);
        console.log(`  − Sonderbetriebsausgaben ${fmt(sbvSum).padStart(12)} €`);
        console.log(`  = Festgestellte laufende Eink. ${fmt(result.festgestellteEinkuenfte).padStart(12)} €`);
    }
    if (hasAufgabe) {
        const label = result.aufgabegewinn < 0 ? '+ Aufgabeverlust (§16/§34)' : '+ Aufgabegewinn (§16/§34)';
        console.log(`  ${label.padEnd(24)} ${fmt(result.aufgabegewinn).padStart(12)} €`);
        console.log(`  = Einkünfte aus Gewerbebetrieb ${fmt(result.einkuenfteGesamt).padStart(12)} €`);
    }

    console.log('\nAnlage FE — Verteilung auf die Beteiligten:');
    for (const a of result.allocations) {
        const quote = `${(a.gesellschafter.quote * 100).toFixed(2)} %`;
        if (hasSbv || hasAufgabe) {
            const aufg = hasAufgabe ? ` + Aufg ${fmt(a.aufgabegewinnAnteil).padStart(9)} €` : '';
            console.log(
                `  ${a.gesellschafter.name.padEnd(26)} ${quote.padStart(7)}  laufend ${fmt(a.laufenderAnteil).padStart(10)} € − SBA ${fmt(a.sonderbetriebsausgaben).padStart(7)} €${aufg} = ${fmt(a.gesamtAnteil).padStart(10)} €  (IdNr ${a.gesellschafter.steuerId})`,
            );
        } else {
            console.log(
                `  ${a.gesellschafter.name.padEnd(28)} Quote ${quote.padStart(8)}   Anteil ${fmt(a.profitShare).padStart(12)} €   (IdNr ${a.gesellschafter.steuerId})`,
            );
        }
    }
    if (result.rounding.residual !== 0) {
        console.log(`  (Rundungsrest ${fmt(result.rounding.residual)} € dem größten laufenden Anteil zugeschlagen)`);
    }
    if (hasAufgabe && report.aufgabe) {
        console.log(
            `\nBetriebsaufgabe ${report.aufgabe.datum} — Entnahme Anlagevermögen (gemeiner Wert ./. Restbuchwert):`,
        );
        for (const a of report.aufgabe.assets) {
            console.log(
                `  ${a.bezeichnung.padEnd(32)} gW ${fmt(a.gemeinerWert).padStart(10)} € − RBW ${fmt(a.restbuchwert).padStart(10)} € = ${fmt(a.gewinn).padStart(10)} €`,
            );
        }
        if (report.aufgabe.aufgabekosten)
            console.log(`  − Aufgabekosten ${fmt(report.aufgabe.aufgabekosten).padStart(12)} €`);
        console.log(
            '  ⚠ Gemeine Werte sind eine Schätzung — bitte prüfen (Aufgabegewinn ist §16/§34-begünstigt, GewSt-frei).',
        );
    }

    console.log('\nAnlage EÜR (als Anlage zur Feststellung) — Kennzahlen:');
    for (const k of buildEuerKennzahlen({ income: euer.income, expenses: euer.expenses, totals: euer.totals })) {
        console.log(`  Kz ${k.kz.padEnd(5)} ${k.label.padEnd(44)} ${fmt(k.amount).padStart(12)} €`);
    }

    if (euer.coverage.unclassified.length > 0) {
        console.log(
            `\n⚠ ${euer.coverage.unclassified.length} unklassifizierte Buchung(en) — vor Abgabe klären (siehe \`elster euer report --by transactions --detail\`).`,
        );
    }
    console.log('\nIn Mein ELSTER: Feststellung → Gesamthand-Gewinn, je Beteiligter eine Anlage FE.');
    console.log('Kz-Beschriftung bitte gegen die ELSTER-Formularzeilen prüfen (best-effort Mapping).');
    console.log('');
}
