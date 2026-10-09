/**
 * `bmf-kurse import` — refresh `bmf-umrechnungskurse.json` from the official BMF yearly CSV.
 *
 * Best-effort live download (with a full browser header set to pass the Radware bot wall) or
 * `--file <pfad>` for a locally-saved CSV (always works, even when the bot wall blocks). See
 * {@link file://../../core/config/bmf-import.ts} for the source/API analysis + parser.
 */

import { readFileSync } from 'node:fs';
import type { CommandModule } from 'yargs';

import { bmfCsvUrl, fetchBmfCsv, parseBmfCsv } from '../../core/config/bmf-import.ts';
import { writeBmfRates } from '../../core/config/bmf-rates.ts';
import { pickArgv } from './output.ts';

const currentYear = (): number => new Date().getFullYear();

const importSubcommand: CommandModule = {
    command: 'import',
    describe: 'Amtliche BMF-Umsatzsteuer-Umrechnungskurse laden und bmf-umrechnungskurse.json aktualisieren.',
    builder: (y) =>
        y
            .option('year', { type: 'number', describe: 'Kalenderjahr der Kurse (Default: laufendes Jahr)' })
            .option('file', {
                type: 'string',
                describe: 'Lokale BMF-CSV parsen statt live laden (umgeht die Bot-Sperre)',
            })
            .option('url', { type: 'string', describe: 'CSV-URL überschreiben' })
            .option('output', {
                type: 'string',
                describe: 'Pfad zu bmf-umrechnungskurse.json (Default: Arbeitsverzeichnis)',
            })
            .option('dry-run', {
                type: 'boolean',
                default: false,
                describe: 'Nur anzeigen, was importiert würde — nichts schreiben',
            })
            .example('$0 bmf-kurse import', 'Laufendes Jahr live vom BMF laden')
            .example('$0 bmf-kurse import --year 2025 --file uu-kurse-2025-csv.csv', 'Lokale CSV importieren'),
    handler: async (argv) => {
        const raw = argv as Record<string, unknown>;
        const explicitYear = pickArgv<number>(raw, 'year');
        // With --file the year is authoritative FROM the CSV title (below); --year only builds the
        // download URL. Keep the requested year for the URL, but flag a mismatch so it isn't silent.
        const year = explicitYear ?? currentYear();
        const file = pickArgv<string>(raw, 'file');
        const url = pickArgv<string>(raw, 'url');
        const output = pickArgv<string>(raw, 'output');
        const dryRun = pickArgv<boolean>(raw, 'dry-run', 'dryRun') ?? false;
        try {
            let bytes: Uint8Array;
            if (file) {
                console.log(`Lese lokale CSV: ${file}`);
                bytes = new Uint8Array(readFileSync(file));
            } else {
                console.log(`Lade BMF-CSV ${year}: ${url ?? bmfCsvUrl(year)}`);
                bytes = await fetchBmfCsv(year, url);
            }
            const parsed = parseBmfCsv(bytes);
            if (explicitYear != null && parsed.year !== explicitYear) {
                console.warn(`Hinweis: --year ${explicitYear} wird ignoriert — die CSV enthält Jahr ${parsed.year}.`);
            }
            console.log(
                `Geparst: Jahr ${parsed.year} · ${parsed.currencies.length} Währungen · ${parsed.cells} Monatskurse ` +
                    `(${parsed.currencies.join(', ')})`,
            );
            if (dryRun) {
                console.log('--dry-run: nichts geschrieben.');
                return process.exit(0);
            }
            // Parsed here so --file and --dry-run keep working; the WRITE is the shared step, so
            // the app's "Kurse laden" button and this command cannot drift apart on what they store.
            const summary = writeBmfRates(parsed.rates, output);
            console.log(
                `Geschrieben: ${summary.path}\n` +
                    `  ${summary.added} neu · ${summary.updated} aktualisiert · ${summary.unchanged} unverändert ` +
                    `(${summary.months.length} Monate, ${summary.currencies.length} Währungen)`,
            );
            return process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            return process.exit(1);
        }
    },
};

export const bmfKurseCommand: CommandModule = {
    command: 'bmf-kurse',
    describe: 'BMF-Umsatzsteuer-Umrechnungskurse verwalten (Import aus der amtlichen CSV).',
    builder: (y) => y.demandCommand(1, 'Unterbefehl wählen: import').command(importSubcommand),
    handler: () => {},
};
