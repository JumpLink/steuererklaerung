/**
 * `umsatz-aufstellung` — generate a revenue listing (tax proof) for one (entity, year): a text
 * summary always, plus optional PDF (`--pdf`, the Anlage) and CSV (`--csv`, the cross-check).
 * First use case: the maßgeblicher Umsatz for a Tourismusbeitrag-Erklärung. Figures come from the
 * same aggregation as the USt-VA/EÜR, and a data-coverage warning is printed when the store does
 * not span the full year.
 *
 *   umsatz-aufstellung --entity gbr --year 2023 --pdf --csv
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandModule } from 'yargs';
import { loadPaperlessConfig } from '../../core/config/index.ts';
import {
    buildUmsatzAufstellung,
    toUmsatzPdfModel,
    umsatzToCsv,
    type UmsatzReport,
} from '../../core/actions/umsatz-aufstellung.ts';
import { pdfRenderingAvailable, renderUmsatzPdf } from '@steuererklaerung/invoice-pdf';

function money(n: number): string {
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printSummary(report: UmsatzReport): void {
    console.log(`\nUmsatzaufstellung ${report.entityName} · ${report.year}`);
    console.log('='.repeat(64));
    if (report.coverage.warning) console.log(`\n⚠️  ${report.coverage.warning}\n`);
    console.log(`  Zeilen (Erlöse):            ${report.rows.length}`);
    console.log(`  Netto 19 %:      ${money(report.netByRate.rate19).padStart(16)} €`);
    console.log(`  Netto 7 %:       ${money(report.netByRate.rate7).padStart(16)} €`);
    console.log(`  Netto 0 %:       ${money(report.netByRate.rate0).padStart(16)} €`);
    console.log(`  Summe Netto:     ${money(report.totalNet).padStart(16)} €  (Bemessungsgrundlage)`);
    console.log(`  Summe USt:       ${money(report.totalVat).padStart(16)} €`);
    console.log(`  Summe Brutto:    ${money(report.totalGross).padStart(16)} €`);
    if (report.reconciliationNote) console.log(`\n  ${report.reconciliationNote}`);
    console.log('');
}

export const umsatzAufstellungCommand: CommandModule = {
    command: 'umsatz-aufstellung',
    describe: 'Umsatzaufstellung (Steuer-Nachweis) für eine Entität/Jahr: Text + optional PDF/CSV',
    builder: (y) =>
        y
            .option('entity', { type: 'string', demandOption: true, describe: 'Workspace-Entität (gbr|jumplink|…)' })
            .option('year', { type: 'number', demandOption: true, describe: 'Kalenderjahr, z. B. 2023' })
            .option('pdf', { type: 'boolean', default: false, describe: 'PDF-Anlage schreiben' })
            .option('csv', { type: 'boolean', default: false, describe: 'CSV zum Gegenprüfen schreiben' })
            .option('out', { type: 'string', describe: 'Ausgabeverzeichnis (Default: elster/)' })
            .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
    handler: async (argv) => {
        try {
            const entity = String(argv.entity);
            const year = Number(argv.year);
            const report = await buildUmsatzAufstellung(loadPaperlessConfig(), { entityId: entity, year });

            if (argv.json) {
                console.log(JSON.stringify(report, null, 2));
                process.exit(0);
            }

            printSummary(report);

            const dir = argv.out ? String(argv.out) : join(process.cwd(), 'elster');
            const base = `umsatz-${entity}-${year}`;
            if (argv.csv) {
                mkdirSync(dir, { recursive: true });
                const path = join(dir, `${base}.csv`);
                writeFileSync(path, umsatzToCsv(report));
                console.log(`CSV geschrieben: ${path}`);
            }
            if (argv.pdf) {
                if (!pdfRenderingAvailable()) {
                    console.error(
                        'PDF-Rendering benötigt die GJS-Laufzeit (Cairo/Pango) — via `npm run start:gjs` ausführen.',
                    );
                    process.exit(1);
                }
                mkdirSync(dir, { recursive: true });
                const bytes = await renderUmsatzPdf(toUmsatzPdfModel(report));
                const path = join(dir, `${base}.pdf`);
                writeFileSync(path, bytes);
                console.log(`PDF geschrieben: ${path}`);
            }
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
